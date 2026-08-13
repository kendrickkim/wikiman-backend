import { Router } from 'express'
import { requireWriter } from '../middleware/auth.js'
import { getSettings, updateSettings } from '../settings.js'

const router = Router()

router.get('/', (_req, res) => {
  res.json(getSettings())
})

router.patch('/', requireWriter, (req, res) => {
  try {
    res.json(updateSettings(req.body || {}))
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message })
  }
})

export default router
