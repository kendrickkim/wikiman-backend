/**
 * DokuWiki data/pages + data/media → Wikiman 가져오기
 *
 * 사용 전 SFTP로 서버의 data/pages, data/media 를 로컬에 받아 두세요.
 *
 *   npm run import:dokuwiki
 *   → DokuWiki 경로, API, 계정 정보를 입력받습니다.
 *
 * 환경 변수가 있으면 기본값으로 쓰입니다 (DOKUWIKI_ROOT, WIKIMAN_API, WIKIMAN_USER, WIKIMAN_PASS).
 *
 * 옵션:
 *   --dry-run   실제 저장 없이 대상만 출력
 *   --limit=N   앞에서 N개만
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DEFAULT_ROOT = path.resolve(process.env.DOKUWIKI_ROOT || path.join(__dirname, '../data/dokuwiki'))
const DEFAULT_API = (process.env.WIKIMAN_API || 'http://localhost:85').replace(/\/$/, '')

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const limitArg = args.find((a) => a.startsWith('--limit='))
const LIMIT = limitArg ? Number(limitArg.slice(8)) : Infinity

/** @type {string} */
let ROOT = DEFAULT_ROOT
/** @type {string} */
let PAGES = path.join(ROOT, 'pages')
/** @type {string} */
let MEDIA = path.join(ROOT, 'media')
/** @type {string} */
let API = DEFAULT_API
/** @type {string} */
let USER = process.env.WIKIMAN_USER || ''
/** @type {string} */
let PASS = process.env.WIKIMAN_PASS || ''

function fail(msg) {
  console.error(msg)
  process.exit(1)
}

function createRl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout })
}

function ask(rl, question, defaultValue = '') {
  const hint = defaultValue ? ` [${defaultValue}]` : ''
  return new Promise((resolve) => {
    rl.question(`${question}${hint}: `, (answer) => {
      const v = String(answer ?? '').trim()
      resolve(v || defaultValue)
    })
  })
}

async function promptConfig() {
  const rl = createRl()
  try {
    console.log('DokuWiki → Wikiman 가져오기')
    console.log('(Enter만 누르면 기본값 사용)\n')

    const rootIn = await ask(rl, 'DokuWiki 경로 (pages·media 가 있는 폴더)', DEFAULT_ROOT)
    ROOT = path.resolve(rootIn)
    PAGES = path.join(ROOT, 'pages')
    MEDIA = path.join(ROOT, 'media')

    API = (await ask(rl, 'Wikiman API URL', DEFAULT_API)).replace(/\/$/, '')
    USER = await ask(rl, 'Wikiman 사용자 아이디', USER)
    // Windows에서 raw mode 비밀번호 입력은 readline과 충돌해 프로세스가 종료됨 → 일반 입력 사용
    PASS = await ask(rl, 'Wikiman 비밀번호', '')
    if (!PASS && process.env.WIKIMAN_PASS) PASS = process.env.WIKIMAN_PASS
  } finally {
    rl.close()
  }
}

async function api(method, urlPath, { token, body, formData, timeout = 120000 } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  let payload
  if (formData) {
    payload = formData
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(timeout)
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status} ${urlPath}`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

function walkTxtFiles(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) walkTxtFiles(full, base, out)
    else if (name.toLowerCase().endsWith('.txt')) {
      const rel = path.relative(base, full).replace(/\\/g, '/')
      out.push({ full, rel })
    }
  }
  return out
}

/** pages/amlogic/roadmap.txt → amlogic:roadmap */
function pageIdFromRel(rel) {
  return rel
    .replace(/\.txt$/i, '')
    .split('/')
    .map((part) => decodeURIComponent(part))
    .join(':')
    .toLowerCase()
}

function titleFromContent(content, fallbackId) {
  const lines = String(content || '').split(/\r?\n/)
  for (const line of lines) {
    const m = line.match(/^={2,6}\s*(.+?)\s*={2,6}\s*$/)
    if (m) {
      const t = m[1].trim()
      if (t) return t.slice(0, 200)
    }
  }
  const last = fallbackId.split(':').pop() || fallbackId
  return last.replace(/_/g, ' ')
}

function headingLevel(marks) {
  // DokuWiki: more = means bigger heading. ====== h1, ===== h2, ... == h5
  const n = marks.length
  if (n >= 6) return 1
  if (n === 5) return 2
  if (n === 4) return 3
  if (n === 3) return 4
  return 5
}

function mediaPathFromId(mediaId) {
  // :foo:bar.png or foo:bar.png → media/foo/bar.png
  let id = String(mediaId || '').trim()
  id = id.replace(/^:+/, '').replace(/\?.*$/, '')
  const parts = id.split(':').filter(Boolean)
  return path.join(MEDIA, ...parts)
}

function dokuToMarkdown(src) {
  let text = String(src || '').replace(/\r\n/g, '\n')

  // code blocks <code> / <file>
  text = text.replace(/<(code|file)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>/gi, (_, _t, body) => {
    const clean = body.replace(/^\n/, '').replace(/\n$/, '')
    return `\n\`\`\`\n${clean}\n\`\`\`\n`
  })

  // nowiki
  text = text.replace(/<nowiki>([\s\S]*?)<\/nowiki>/gi, '$1')

  const lines = text.split('\n')
  const out = []
  for (let line of lines) {
    // headings
    const hm = line.match(/^(={2,6})\s*(.+?)\s*\1\s*$/)
    if (hm) {
      out.push(`${'#'.repeat(headingLevel(hm[1]))} ${hm[2].trim()}`)
      continue
    }

    // hr
    if (/^-{4,}\s*$/.test(line)) {
      out.push('---')
      continue
    }

    const lm = line.match(/^(\s*)([*-])\s+(.*)$/)
    if (lm) {
      const depth = Math.floor(lm[1].replace(/\t/g, '  ').length / 2)
      out.push(`${'  '.repeat(depth)}- ${convertInline(lm[3])}`)
      continue
    }

    out.push(convertInline(line))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

function convertInline(line) {
  let s = line
  // images {{id}} or {{id?opts|title}}
  s = s.replace(/\{\{([^}|]+)(?:\|([^}]*))?\}\}/g, (_, raw, title) => {
    const id = raw.trim()
    const alt = (title || id.split(':').pop() || 'image').trim()
    return `![${alt}](doku-media:${id.replace(/\?.*$/, '').trim()})`
  })
  // links [[id|text]] or [[id]]
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => {
    const t = target.trim()
    const text = (label || t).trim()
    if (/^https?:\/\//i.test(t)) return `[${text}](${t})`
    // internal — keep as markdown link placeholder
    return `[${text}](doku-page:${t.replace(/^:+/, '')})`
  })
  // bold ** **
  s = s.replace(/\*\*(.+?)\*\*/g, '**$1**')
  // italic // //
  s = s.replace(/\/\/(.+?)\/\//g, '*$1*')
  // mono '' ''
  s = s.replace(/''(.+?)''/g, '`$1`')
  // delete <del>
  s = s.replace(/<del>(.*?)<\/del>/gi, '~~$1~~')
  // line break \\
  s = s.replace(/\\\\\s*$/g, '  ')
  return s
}

function collectMediaRefs(markdown) {
  const set = new Set()
  const re = /doku-media:([^)\s]+)/g
  let m
  while ((m = re.exec(markdown))) set.add(m[1])
  return [...set]
}

async function ensureCategoryPath(token, cache, parts, { privateNs }) {
  let parentId = null
  let pathKey = ''
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]
    pathKey = pathKey ? `${pathKey}:${name}` : name
    if (cache.has(pathKey)) {
      parentId = cache.get(pathKey)
      continue
    }
    const visibility = privateNs || name.toLowerCase() === 'private' ? 'private' : 'public'
    if (DRY) {
      const fake = -(cache.size + 1)
      cache.set(pathKey, fake)
      parentId = fake
      console.log(`  [dry] category ${pathKey} (${visibility})`)
      continue
    }
    const created = await api('POST', '/api/categories', {
      token,
      body: { name, parentId, visibility }
    })
    parentId = created.category.id
    cache.set(pathKey, parentId)
    console.log(`  + category ${pathKey} #${parentId}`)
  }
  return parentId
}

async function uploadMedia(token, mediaId, uploadCache) {
  if (uploadCache.has(mediaId)) return uploadCache.get(mediaId)
  const filePath = mediaPathFromId(mediaId)
  if (!fs.existsSync(filePath)) {
    console.warn(`  ! media missing: ${mediaId} (${filePath})`)
    uploadCache.set(mediaId, null)
    return null
  }
  if (DRY) {
    const fake = `/api/files/dry-${path.basename(filePath)}`
    uploadCache.set(mediaId, fake)
    return fake
  }
  const buf = await fsp.readFile(filePath)
  const form = new FormData()
  const blob = new Blob([buf])
  form.append('image', blob, path.basename(filePath))
  try {
    const data = await api('POST', '/api/uploads', { token, formData: form, timeout: 180000 })
    const url = data.file?.url || data.url
    uploadCache.set(mediaId, url)
    console.log(`  ↑ media ${mediaId} → ${url}`)
    return url
  } catch (err) {
    // 이미지가 아니면 files 업로드 시도
    const form2 = new FormData()
    form2.append('files', new Blob([buf]), path.basename(filePath))
    const data = await api('POST', '/api/uploads/files', { token, formData: form2, timeout: 180000 })
    const file = data.files?.[0]
    const url = file?.url || null
    uploadCache.set(mediaId, url)
    if (url) console.log(`  ↑ file ${mediaId} → ${url}`)
    else console.warn(`  ! upload failed ${mediaId}: ${err.message}`)
    return url
  }
}

async function main() {
  await promptConfig()

  if (!fs.existsSync(PAGES)) {
    fail(`pages 폴더가 없습니다: ${PAGES}\nSFTP로 data/pages 와 data/media 를 ${ROOT} 아래에 받아 주세요.`)
  }
  if (!USER || !PASS) {
    fail('사용자 아이디와 비밀번호가 필요합니다.')
  }

  console.log(`\nDokuWiki root: ${ROOT}`)
  console.log(`API: ${API}`)
  console.log(DRY ? '모드: dry-run' : '모드: import')

  const login = await api('POST', '/api/auth/login', {
    body: { username: USER, password: PASS }
  })
  const token = login.token
  if (!token) fail('로그인 토큰을 받지 못했습니다.')
  console.log(`로그인: ${login.user?.username}`)

  const catCache = new Map()

  const pages = walkTxtFiles(PAGES)
    .map((p) => ({ ...p, id: pageIdFromRel(p.rel) }))
    .sort((a, b) => a.id.localeCompare(b.id, 'en'))

  console.log(`페이지 ${pages.length}개 발견`)

  const uploadCache = new Map()
  let ok = 0
  let skip = 0
  let failCount = 0

  for (const page of pages.slice(0, LIMIT)) {
    try {
      const raw = await fsp.readFile(page.full, 'utf8')
      if (!raw.trim()) {
        skip++
        continue
      }
      const title = titleFromContent(raw, page.id)
      let md = dokuToMarkdown(raw)

      const mediaIds = collectMediaRefs(md)
      for (const mid of mediaIds) {
        const url = await uploadMedia(token, mid, uploadCache)
        if (url) {
          md = md.split(`doku-media:${mid}`).join(url)
        }
      }

      // internal page links → leave as text hint (post IDs unknown yet)
      md = md.replace(/\[([^\]]+)\]\(doku-page:([^)]+)\)/g, '[$1](#doku:$2)')

      const parts = page.id.split(':').filter(Boolean)
      const ns = parts.slice(0, -1)
      const privateNs = parts[0] === 'private'
      let categoryId = null
      if (ns.length) {
        categoryId = await ensureCategoryPath(token, catCache, ns, { privateNs })
      }

      const payload = {
        title,
        categoryId,
        visibility: 'public',
        status: 'published',
        editorType: 'markdown',
        content: md,
        keywords: parts.length > 1 ? parts.slice(0, -1) : [],
        isHomepage: page.id === 'start'
      }

      console.log(`→ ${page.id} | ${title}`)
      if (!DRY) {
        await api('POST', '/api/posts', { token, body: payload, timeout: 120000 })
      }
      ok++
    } catch (err) {
      failCount++
      console.error(`✗ ${page.id}: ${err.message}`)
    }
  }

  console.log(`\n완료: 성공 ${ok}, 건너뜀 ${skip}, 실패 ${failCount}`)
  if (DRY) console.log('dry-run 이었습니다. 실제 반영하려면 --dry-run 없이 실행하세요.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
