import net from 'node:net'
import dns from 'node:dns/promises'

const FETCH_TIMEOUT_MS = 8000
const MAX_HTML_BYTES = 512 * 1024
const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_MAX = 200

const cache = new Map()

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
}

function attr(html, name) {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = html.match(re)
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : ''
}

function metaContent(html, keys) {
  const tags = html.match(/<meta\b[^>]*>/gi) || []
  for (const key of keys) {
    const lower = key.toLowerCase()
    for (const tag of tags) {
      const property = attr(tag, 'property').toLowerCase()
      const name = attr(tag, 'name').toLowerCase()
      if (property === lower || name === lower) {
        const content = decodeHtmlEntities(attr(tag, 'content')).trim()
        if (content) return content
      }
    }
  }
  return ''
}

function pageTitle(html) {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)
  return match ? decodeHtmlEntities(match[1]).replace(/\s+/g, ' ').trim() : ''
}

function absoluteUrl(base, value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    return new URL(raw, base).toString()
  } catch {
    return ''
  }
}

function isPrivateIp(ip) {
  if (!ip) return true
  if (ip === '::1' || ip === '0.0.0.0') return true
  if (ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.')) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true
  return false
}

export function normalizePreviewUrl(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null
  const host = parsed.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null
  if (net.isIP(host) && isPrivateIp(host)) return null
  parsed.hash = ''
  return parsed
}

async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw Object.assign(new Error('내부 주소는 미리볼 수 없습니다.'), { status: 400 })
    }
    return
  }
  let records
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw Object.assign(new Error('주소를 확인할 수 없습니다.'), { status: 400 })
  }
  if (!records.length || records.some((row) => isPrivateIp(row.address))) {
    throw Object.assign(new Error('내부 주소는 미리볼 수 없습니다.'), { status: 400 })
  }
}

async function fetchPublicPage(initialUrl, signal) {
  let current = initialUrl
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    await assertPublicHost(current.hostname)
    const response = await fetch(current.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'WikimanLinkPreview/1.0'
      }
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      const next = location ? normalizePreviewUrl(new URL(location, current).toString()) : null
      if (!next) {
        throw Object.assign(new Error('이동할 페이지 주소가 올바르지 않습니다.'), { status: 400 })
      }
      current = next
      continue
    }
    return { response, finalUrl: current }
  }
  throw Object.assign(new Error('페이지 이동 횟수가 너무 많습니다.'), { status: 400 })
}

async function readLimitedBody(response) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) {
    throw Object.assign(new Error('페이지가 너무 큽니다.'), { status: 400 })
  }
  if (!response.body?.getReader) {
    const fallback = Buffer.from(await response.arrayBuffer())
    if (fallback.length > MAX_HTML_BYTES) {
      throw Object.assign(new Error('페이지가 너무 큽니다.'), { status: 400 })
    }
    return fallback
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_HTML_BYTES) {
      await reader.cancel()
      throw Object.assign(new Error('페이지가 너무 큽니다.'), { status: 400 })
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, total)
}

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return hit.value
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value })
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    cache.delete(oldest)
  }
}

export async function fetchLinkPreview(rawUrl) {
  const parsed = normalizePreviewUrl(rawUrl)
  if (!parsed) {
    throw Object.assign(new Error('미리볼 수 있는 http(s) 주소가 아닙니다.'), { status: 400 })
  }

  const cacheKey = parsed.toString()
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const { response, finalUrl } = await fetchPublicPage(parsed, controller.signal)
    if (!response.ok) {
      throw Object.assign(new Error('페이지를 가져오지 못했습니다.'), { status: 400 })
    }

    const type = String(response.headers.get('content-type') || '').toLowerCase()
    if (!type.includes('text/html') && !type.includes('application/xhtml')) {
      throw Object.assign(new Error('HTML 페이지가 아닙니다.'), { status: 400 })
    }

    const buf = await readLimitedBody(response)
    const html = buf.toString('utf8')
    const title = metaContent(html, ['og:title', 'twitter:title']) || pageTitle(html) || finalUrl.hostname
    const description = metaContent(html, ['og:description', 'twitter:description', 'description'])
    const image = absoluteUrl(finalUrl.toString(), metaContent(html, ['og:image', 'twitter:image', 'twitter:image:src']))
    const siteName = metaContent(html, ['og:site_name']) || finalUrl.hostname

    const preview = {
      url: finalUrl.toString(),
      title: title.slice(0, 200),
      description: description.slice(0, 400),
      image: image.slice(0, 1000),
      siteName: siteName.slice(0, 120)
    }
    cacheSet(cacheKey, preview)
    return preview
  } catch (err) {
    if (err.status) throw err
    if (err.name === 'AbortError') {
      throw Object.assign(new Error('페이지 응답이 너무 늦습니다.'), { status: 400 })
    }
    throw Object.assign(new Error(err.message || '링크 미리보기에 실패했습니다.'), { status: 400 })
  } finally {
    clearTimeout(timer)
  }
}
