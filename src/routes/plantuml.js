import { Router } from 'express'
import plantumlEncoder from 'plantuml-encoder'
import { getSettings } from '../settings.js'
import { apiError, sendError } from '../errors.js'

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
      throw apiError('PLANTUML_RENDER_FAILED', 502)
    }
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > MAX_SVG_BYTES) {
      throw apiError('PLANTUML_RESULT_TOO_LARGE', 502)
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
    return res.status(429).json({ error: 'PLANTUML_RATE_LIMITED' })
  }
  const source = String(req.body?.source || req.body?.text || '')
  if (!source.trim()) {
    return res.status(400).json({ error: 'PLANTUML_SOURCE_REQUIRED' })
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    return res.status(400).json({ error: 'PLANTUML_SOURCE_TOO_LONG' })
  }
  try {
    const svg = await renderSvg(source)
    res.type('image/svg+xml').send(svg)
  } catch (err) {
    const aborted = err?.name === 'AbortError'
    sendError(res, aborted ? apiError('PLANTUML_TIMEOUT', 502) : err, 'PLANTUML_UNREACHABLE', 502)
  }
})

router.get('/:encoded', async (req, res) => {
  if (rateLimited(req)) {
    return res.status(429).json({ error: 'PLANTUML_RATE_LIMITED' })
  }
  try {
    const encoded = String(req.params.encoded || '')
    if (!encoded || encoded.length > 20000) {
      return res.status(400).json({ error: 'PLANTUML_REQUEST_INVALID' })
    }
    const svg = await fetchSvg(`${plantumlServer()}/svg/${encoded}`)
    res.type('image/svg+xml').send(svg)
  } catch (err) {
    const aborted = err?.name === 'AbortError'
    sendError(res, aborted ? apiError('PLANTUML_TIMEOUT', 502) : err, 'PLANTUML_UNREACHABLE', 502)
  }
})

export default router
