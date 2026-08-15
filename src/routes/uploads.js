import { Router } from 'express'
import path from 'node:path'
import multer from 'multer'
import { MAX_FILES_PER_REQUEST, deleteOrphanUploads, summarizeOrphanUploads } from '../attachments.js'
import { db, uploadsDir } from '../db.js'
import { requireWriter } from '../middleware/auth.js'
import { getMaxAttachmentBytes, getMaxAttachmentMb } from '../settings.js'
import { apiError, errorPayload, sendError } from '../errors.js'

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
  if (err?.code === 'LIMIT_FILE_SIZE') return apiError('UPLOAD_TOO_LARGE', 400, { max: maxMb })
  if (err?.code === 'LIMIT_FILE_COUNT') {
    return apiError('UPLOAD_TOO_MANY', 400, { max: MAX_FILES_PER_REQUEST })
  }
  if (err?.code === 'FAVICON_TYPE_INVALID' || err?.code === 'IMAGE_TYPE_INVALID') return err
  return apiError('UPLOAD_FAILED', 400)
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
      cb(apiError('FAVICON_TYPE_INVALID', 400))
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
        cb(apiError('IMAGE_TYPE_INVALID', 400))
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
      return res.status(400).json({ success: 0, ...errorPayload(multerError(err, maxMb), 'UPLOAD_FAILED') })
    }
    if (!req.file) {
      return res.status(400).json({ success: 0, error: 'IMAGE_REQUIRED' })
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
      const error = err.code === 'LIMIT_FILE_SIZE'
        ? apiError('FAVICON_TOO_LARGE', 400)
        : multerError(err)
      return sendError(res, error, 'UPLOAD_FAILED', 400)
    }
    if (!req.file) {
      return res.status(400).json({ error: 'FAVICON_REQUIRED' })
    }
    const url = `/api/files/${req.file.filename}`
    res.status(201).json({ url })
  })
})

router.post('/files', requireWriter, (req, res) => {
  const maxMb = getMaxAttachmentMb()
  createFileUpload().array('files', MAX_FILES_PER_REQUEST)(req, res, (err) => {
    if (err) {
      return sendError(res, multerError(err, maxMb), 'UPLOAD_FAILED', 400)
    }
    const uploaded = req.files || []
    if (!uploaded.length) {
      return res.status(400).json({ error: 'FILES_REQUIRED' })
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
