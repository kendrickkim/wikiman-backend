import { Router } from 'express'
import multer from 'multer'
import { MAX_FILES_PER_REQUEST, deleteOrphanUploads, summarizeOrphanUploads } from '../attachments.js'
import { db, uploadsDir } from '../db.js'
import { requireWriter } from '../middleware/auth.js'
import { getMaxAttachmentBytes, getMaxAttachmentMb } from '../settings.js'

const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])
const imageExt = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg'
}

function safeExt(filename, mimeType) {
  const fromName = path.extname(String(filename || '')).slice(0, 12)
  if (/^\.[a-zA-Z0-9.]+$/.test(fromName)) return fromName
  return faviconExt[mimeType] || imageExt[mimeType] || ''
}

function storedName(file) {
  const ext = safeExt(file.originalname, file.mimetype)
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${ext}`
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => cb(null, storedName(file))
})

function multerError(err, maxMb = getMaxAttachmentMb()) {
  if (err?.code === 'LIMIT_FILE_SIZE') return `파일 크기는 ${maxMb}MB를 넘을 수 없습니다.`
  if (err?.code === 'LIMIT_FILE_COUNT') return `한 번에 최대 ${MAX_FILES_PER_REQUEST}개까지 올릴 수 있습니다.`
  return err?.message || '파일을 올릴 수 없습니다.'
}

const faviconTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.microsoft.icon'
])
const faviconExt = {
  ...imageExt,
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico'
}

function isFaviconFile(file) {
  if (faviconTypes.has(file.mimetype)) return true
  return /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(file.originalname || '')
}

const faviconUpload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!isFaviconFile(file)) {
      cb(new Error('파비콘은 PNG, ICO, SVG, WebP, JPEG만 올릴 수 있습니다.'))
      return
    }
    cb(null, true)
  }
})

function createImageUpload() {
  return multer({
    storage,
    limits: { fileSize: getMaxAttachmentBytes() },
    fileFilter: (_req, file, cb) => {
      if (!imageTypes.has(file.mimetype)) {
        cb(new Error('이미지 파일만 업로드할 수 있습니다.'))
        return
      }
      cb(null, true)
    }
  })
}

function createFileUpload() {
  return multer({
    storage,
    limits: { fileSize: getMaxAttachmentBytes(), files: MAX_FILES_PER_REQUEST }
  })
}

const router = Router()

router.post('/', requireWriter, (req, res) => {
  const maxMb = getMaxAttachmentMb()
  createImageUpload().single('image')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: 0, error: multerError(err, maxMb) })
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

router.post('/favicon', requireWriter, (req, res) => {
  faviconUpload.single('image')(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? '파비콘은 2MB를 넘을 수 없습니다.'
        : multerError(err)
      return res.status(400).json({ error: message })
    }
    if (!req.file) {
      return res.status(400).json({ error: '파비콘 이미지가 필요합니다.' })
    }
    const url = `/api/files/${req.file.filename}`
    res.status(201).json({ url })
  })
})

router.post('/files', requireWriter, (req, res) => {
  const maxMb = getMaxAttachmentMb()
  createFileUpload().array('files', MAX_FILES_PER_REQUEST)(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: multerError(err, maxMb) })
    }
    const uploaded = req.files || []
    if (!uploaded.length) {
      return res.status(400).json({ error: '올릴 파일이 필요합니다.' })
    }
    res.status(201).json({
      files: uploaded.map((file) => ({
        storedName: file.filename,
        originalName: path.basename(file.originalname || file.filename).slice(0, 200) || file.filename,
        mimeType: file.mimetype || 'application/octet-stream',
        size: file.size,
        url: `/api/files/${file.filename}`
      }))
    })
  })
})

router.get('/orphans', requireWriter, (_req, res) => {
  res.json(summarizeOrphanUploads(db))
})

router.post('/orphans/cleanup', requireWriter, (_req, res) => {
  res.json(deleteOrphanUploads(db))
})

export default router
