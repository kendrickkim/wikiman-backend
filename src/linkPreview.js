import net from 'node:net'
import dns from 'node:dns/promises'
import { db } from './db.js'
import { getLinkPreviewCacheConfig } from './settings.js'
import { apiError } from './errors.js'

const FETCH_TIMEOUT_MS = 8000
const MAX_HTML_BYTES = 512 * 1024

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
      throw apiError('LINK_PREVIEW_PRIVATE', 400)
    }
    return
  }
  let records
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw apiError('LINK_PREVIEW_RESOLVE_FAILED', 400)
  }
  if (!records.length || records.some((row) => isPrivateIp(row.address))) {
    throw apiError('LINK_PREVIEW_PRIVATE', 400)
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
        throw apiError('LINK_PREVIEW_BAD_REDIRECT', 400)
      }
      current = next
      continue
    }
    return { response, finalUrl: current }
  }
  throw apiError('LINK_PREVIEW_TOO_MANY_REDIRECTS', 400)
}

async function readLimitedBody(response) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) {
    throw apiError('LINK_PREVIEW_TOO_LARGE', 400)
  }
  if (!response.body?.getReader) {
    const fallback = Buffer.from(await response.arrayBuffer())
    if (fallback.length > MAX_HTML_BYTES) {
      throw apiError('LINK_PREVIEW_TOO_LARGE', 400)
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
      throw apiError('LINK_PREVIEW_TOO_LARGE', 400)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, total)
}

function mapCacheRow(row) {
  if (!row) return null
  return {
    url: row.final_url,
    title: row.title,
    description: row.description,
    image: row.image,
    siteName: row.site_name
  }
}

function cacheGet(key, ttlDays) {
  const row = db.prepare(`
    SELECT
      final_url, title, description, image, site_name,
      datetime(fetched_at) > datetime('now', ?) AS is_fresh
    FROM link_preview_cache
    WHERE url = ?
  `).get(`-${ttlDays} days`, key)
  return {
    value: mapCacheRow(row),
    fresh: row?.is_fresh === 1
  }
}

function extendCacheAfterFailure(key, ttlDays, failureTtlDays) {
  const offsetDays = failureTtlDays - ttlDays
  db.prepare(`
    UPDATE link_preview_cache
    SET fetched_at = datetime('now', ?)
    WHERE url = ?
  `).run(`${offsetDays} days`, key)
}

function cacheSet(key, value) {
  db.prepare(`
    INSERT INTO link_preview_cache (url, final_url, title, description, image, site_name, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(url) DO UPDATE SET
      final_url = excluded.final_url,
      title = excluded.title,
      description = excluded.description,
      image = excluded.image,
      site_name = excluded.site_name,
      fetched_at = datetime('now')
  `).run(
    key,
    value.url,
    value.title,
    value.description,
    value.image,
    value.siteName
  )
}

export function getLinkPreviewCacheStats() {
  const config = getLinkPreviewCacheConfig()
  const row = db.prepare('SELECT COUNT(*) AS count FROM link_preview_cache').get()
  return {
    count: Number(row?.count) || 0,
    ...config
  }
}

export function clearLinkPreviewCache() {
  const config = getLinkPreviewCacheConfig()
  const result = db.prepare('DELETE FROM link_preview_cache').run()
  return {
    deleted: Number(result.changes) || 0,
    ...config
  }
}

export async function fetchLinkPreview(rawUrl) {
  const parsed = normalizePreviewUrl(rawUrl)
  if (!parsed) {
    throw apiError('LINK_PREVIEW_NOT_HTTP', 400)
  }

  const cacheKey = parsed.toString()
  const { ttlDays, failureTtlDays } = getLinkPreviewCacheConfig()
  const cached = cacheGet(cacheKey, ttlDays)
  if (cached.fresh) return cached.value

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const { response, finalUrl } = await fetchPublicPage(parsed, controller.signal)
    if (!response.ok) {
      throw apiError('LINK_PREVIEW_FETCH_FAILED', 400)
    }

    const type = String(response.headers.get('content-type') || '').toLowerCase()
    if (!type.includes('text/html') && !type.includes('application/xhtml')) {
      throw apiError('LINK_PREVIEW_NOT_HTML', 400)
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
    if (cached.value) {
      extendCacheAfterFailure(cacheKey, ttlDays, failureTtlDays)
      return cached.value
    }
    if (err.status) throw err
    if (err.name === 'AbortError') {
      throw apiError('LINK_PREVIEW_TIMEOUT', 400)
    }
    throw apiError('LINK_PREVIEW_FAILED', 400)
  } finally {
    clearTimeout(timer)
  }
}
