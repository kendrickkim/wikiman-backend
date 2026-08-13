import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import multer from 'multer'
import { uploadsDir } from '../db.js'
import { requireWriter } from '../middleware/auth.js'

const allowed = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])
const extByMime = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg'
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = extByMime[file.mimetype] || path.extname(file.originalname) || '.bin'
    cb(null, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${ext}`)
  }
})

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!allowed.has(file.mimetype)) {
      cb(new Error('이미지 파일만 업로드할 수 있습니다.'))
      return
    }
    cb(null, true)
  }
})

const router = Router()

router.post('/', requireWriter, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: 0, error: err.message })
    }
    if (!req.file) {
      return res.status(400).json({ success: 0, error: '이미지 파일이 필요합니다.' })
    }
    const url = `/api/files/${req.file.filename}`
    res.status(201).json({
      success: 1,
      file: { url },
      url
    })
  })
})

router.get('/:filename', (req, res) => {
  const filename = path.basename(req.params.filename)
  const filePath = path.join(uploadsDir, filename)
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '파일을 찾을 수 없습니다.' })
  }
  res.sendFile(filePath)
})

export default router
