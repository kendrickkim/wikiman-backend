import { Router } from 'express'
import { requireWriter } from '../middleware/auth.js'
import { getSettings, updateSettings } from '../settings.js'
import {
  getTopMenuEditorItems,
  getTopMenuPostOptions,
  replaceTopMenuItems
} from '../topMenu.js'

const router = Router()

router.get('/', (req, res) => {
  res.json(getSettings(req.user))
})

router.patch('/', requireWriter, (req, res) => {
  try {
    res.json(updateSettings(req.body || {}, req.user))
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message })
  }
})

router.get('/top-menu', requireWriter, (_req, res) => {
  res.json({
    items: getTopMenuEditorItems(),
    posts: getTopMenuPostOptions()
  })
})

router.put('/top-menu', requireWriter, (req, res) => {
  try {
    res.json({ items: replaceTopMenuItems(req.body?.items) })
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message })
  }
})

export default router
