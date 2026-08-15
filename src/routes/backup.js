import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import multer from 'multer'
import { dataDir } from '../db.js'
import { closeDatabase, reopenDatabase } from '../db.js'
import { requireWriter } from '../middleware/auth.js'
import { beginMaintenance, endMaintenance } from '../maintenance.js'
import {
  BACKUP_EXTENSION,
  createBackupFile,
  inspectBackupFile,
  restoreBackupFile
} from '../backup.js'
import { getSettings } from '../settings.js'
import { apiError, sendError } from '../errors.js'

const router = Router()

const upload = multer({
  dest: path.join(dataDir, 'tmp-uploads'),
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || '').toLowerCase()
    if (!name.endsWith(BACKUP_EXTENSION)) {
      cb(apiError('BACKUP_EXTENSION_ONLY', 400, { extension: BACKUP_EXTENSION }))
      return
    }
    cb(null, true)
  }
})

fs.mkdirSync(path.join(dataDir, 'tmp-uploads'), { recursive: true })

function cleanup(filePath) {
  if (!filePath) return
  try {
    fs.unlinkSync(filePath)
  } catch {
    // ignore
  }
}

function restoreError(err) {
  const raw = String(err?.message || '')
  if (/malformed|not a database|disk i\/o error/i.test(raw)) {
    return apiError('BACKUP_DATABASE_CORRUPT', err?.status || 400)
  }
  if (err?.code && /^[A-Z][A-Z0-9_]*$/.test(err.code)) return err
  return apiError('BACKUP_RESTORE_FAILED', err?.status || 400)
}

function stampName() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `wikiman-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${BACKUP_EXTENSION}`
}

router.get('/download', requireWriter, async (_req, res) => {
  // 파일명이 '.'으로 시작하면 Express send가 숨김 파일로 무시합니다.
  const outPath = path.join(dataDir, `tmp-backup-${Date.now()}${BACKUP_EXTENSION}`)
  try {
    await createBackupFile(outPath)
    res.download(outPath, stampName(), (err) => {
      cleanup(outPath)
      if (err && !res.headersSent) {
        console.error(err)
        sendError(res, apiError('BACKUP_DOWNLOAD_FAILED', 500), 'BACKUP_DOWNLOAD_FAILED', 500)
      }
    })
  } catch (err) {
    cleanup(outPath)
    sendError(res, err, 'BACKUP_FAILED', 500)
  }
})

router.post('/inspect', requireWriter, (req, res) => {
  upload.single('backup')(req, res, async (err) => {
    if (err) {
      return sendError(res, err, 'BACKUP_UPLOAD_FAILED', 400)
    }
    const filePath = req.file?.path
    if (!filePath) {
      return sendError(res, apiError('BACKUP_FILE_REQUIRED', 400), 'BACKUP_FILE_REQUIRED', 400)
    }
    try {
      const info = await inspectBackupFile(filePath)
      res.json(info)
    } catch (e) {
      sendError(res, e, 'BACKUP_INSPECT_FAILED', 400)
    } finally {
      cleanup(filePath)
    }
  })
})

router.post('/restore', requireWriter, (req, res) => {
  upload.single('backup')(req, res, async (err) => {
    if (err) {
      return sendError(res, err, 'BACKUP_UPLOAD_FAILED', 400)
    }
    const filePath = req.file?.path
    if (!filePath) {
      return sendError(res, apiError('BACKUP_FILE_REQUIRED', 400), 'BACKUP_FILE_REQUIRED', 400)
    }
    try {
      // 복구 전 구조 재확인
      await inspectBackupFile(filePath)
      beginMaintenance()
      closeDatabase()
      await new Promise((resolve) => setTimeout(resolve, 100))
      try {
        const result = await restoreBackupFile(filePath)
        try {
          reopenDatabase()
        } catch (reopenErr) {
          console.error(reopenErr)
          throw apiError('BACKUP_REOPEN_FAILED', 500)
        }
        res.json({
          ...result,
          settings: getSettings()
        })
      } catch (restoreErr) {
        try {
          reopenDatabase()
        } catch (reopenErr) {
          console.error(reopenErr)
        }
        throw restoreErr
      } finally {
        endMaintenance()
      }
    } catch (e) {
      sendError(res, restoreError(e), 'BACKUP_RESTORE_FAILED', 400)
    } finally {
      cleanup(filePath)
    }
  })
})

export default router
