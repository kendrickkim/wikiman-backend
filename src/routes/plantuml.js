import { Router } from 'express'
import plantumlEncoder from 'plantuml-encoder'
import { getSettings } from '../settings.js'

const router = Router()
const MAX_SOURCE_BYTES = 32 * 1024
const MAX_SVG_BYTES = 2 * 1024 * 1024
const FETCH_TIMEOUT_MS = 12000
const RATE_WINDOW_MS = 60 * 1000
const RATE_MAX = 20
const hits = new Map()

function plantumlServer() {
  return getSettings().plantumlServer || 'https://www.plantuml.com/plantuml'
}

function clientKey(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || 'local')
}

function rateLimited(req) {
  const key = clientKey(req)
  const now = Date.now()
  const recent = (hits.get(key) || []).filter((ts) => now - ts < RATE_WINDOW_MS)
  if (recent.length >= RATE_MAX) {
    hits.set(key, recent)
    return true
  }
  recent.push(now)
  hits.set(key, recent)
  return false
}

async function fetchSvg(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error('PlantUML 렌더링에 실패했습니다.')
    }
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > MAX_SVG_BYTES) {
      throw new Error('PlantUML 결과가 너무 큽니다.')
    }
    return buf.toString('utf8')
  } finally {
    clearTimeout(timer)
  }
}

async function renderSvg(source) {
  const encoded = plantumlEncoder.encode(source)
  return fetchSvg(`${plantumlServer()}/svg/${encoded}`)
}

router.post('/', async (req, res) => {
  if (rateLimited(req)) {
    return res.status(429).json({ error: 'PlantUML 요청이 너무 많습니다. 잠시 후 다시 시도하세요.' })
  }
  const source = String(req.body?.source || req.body?.text || '')
  if (!source.trim()) {
    return res.status(400).json({ error: 'PlantUML 소스가 필요합니다.' })
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    return res.status(400).json({ error: 'PlantUML 소스가 너무 깁니다.' })
  }
  try {
    const svg = await renderSvg(source)
    res.type('image/svg+xml').send(svg)
  } catch (err) {
    const aborted = err?.name === 'AbortError'
    res.status(502).json({ error: aborted ? 'PlantUML 서버 응답이 지연되었습니다.' : (err.message || 'PlantUML 서버에 연결할 수 없습니다.') })
  }
})

router.get('/:encoded', async (req, res) => {
  if (rateLimited(req)) {
    return res.status(429).json({ error: 'PlantUML 요청이 너무 많습니다. 잠시 후 다시 시도하세요.' })
  }
  try {
    const encoded = String(req.params.encoded || '')
    if (!encoded || encoded.length > 20000) {
      return res.status(400).json({ error: 'PlantUML 요청이 올바르지 않습니다.' })
    }
    const svg = await fetchSvg(`${plantumlServer()}/svg/${encoded}`)
    res.type('image/svg+xml').send(svg)
  } catch (err) {
    const aborted = err?.name === 'AbortError'
    res.status(502).json({ error: aborted ? 'PlantUML 서버 응답이 지연되었습니다.' : 'PlantUML 서버에 연결할 수 없습니다.' })
  }
})

export default router
