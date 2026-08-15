import { Router } from 'express'
import { optionalAuth, requireWriter } from '../middleware/auth.js'
import { sendError } from '../errors.js'
import {
  clearLinkPreviewCache,
  fetchLinkPreview,
  getLinkPreviewCacheStats
} from '../linkPreview.js'

const router = Router()
const RATE_WINDOW_MS = 60 * 1000
const RATE_MAX = 30
const hits = new Map()

function clientKey(req) {
  return String(req.user?.id || req.ip || req.headers['x-forwarded-for'] || 'local')
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

router.get('/cache', requireWriter, (_req, res) => {
  res.json(getLinkPreviewCacheStats())
})

router.delete('/cache', requireWriter, (_req, res) => {
  res.json(clearLinkPreviewCache())
})

router.get('/', optionalAuth, async (req, res) => {
  if (rateLimited(req)) {
    return res.status(429).json({ error: 'RATE_LIMITED' })
  }
  try {
    const preview = await fetchLinkPreview(req.query?.url)
    res.json({ preview })
  } catch (err) {
    sendError(res, err, 'LINK_PREVIEW_FAILED', 400)
  }
})

export default router
