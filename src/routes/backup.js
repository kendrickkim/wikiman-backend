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

const router = Router()

const upload = multer({
  dest: path.join(dataDir, 'tmp-uploads'),
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || '').toLowerCase()
    if (!name.endsWith(BACKUP_EXTENSION)) {
      cb(new Error(`백업 파일은 ${BACKUP_EXTENSION} 확장자만 올릴 수 있습니다.`))
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

function restoreErrorMessage(err) {
  const raw = String(err?.message || '')
  if (/malformed|not a database|disk i\/o error/i.test(raw)) {
    return '데이터베이스 파일이 손상되어 있습니다. 백업을 다시 만든 뒤 복구해 주세요.'
  }
  return err?.message || '복구에 실패했습니다.'
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
        res.status(500).json({ error: '백업 파일을 내려받지 못했습니다.' })
      }
    })
  } catch (err) {
    cleanup(outPath)
    res.status(err.status || 500).json({ error: err.message || '백업에 실패했습니다.' })
  }
})

router.post('/inspect', requireWriter, (req, res) => {
  upload.single('backup')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || '백업 파일을 올릴 수 없습니다.' })
    }
    const filePath = req.file?.path
    if (!filePath) {
      return res.status(400).json({ error: '백업 파일이 필요합니다.' })
    }
    try {
      const info = await inspectBackupFile(filePath)
      res.json(info)
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message || '백업 파일을 확인할 수 없습니다.' })
    } finally {
      cleanup(filePath)
    }
  })
})

router.post('/restore', requireWriter, (req, res) => {
  upload.single('backup')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || '백업 파일을 올릴 수 없습니다.' })
    }
    const filePath = req.file?.path
    if (!filePath) {
      return res.status(400).json({ error: '백업 파일이 필요합니다.' })
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
          throw Object.assign(
            new Error(`복구 후 데이터베이스를 열 수 없습니다: ${restoreErrorMessage(reopenErr)}`),
            { status: 500 }
          )
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
      res.status(e.status || 400).json({ error: restoreErrorMessage(e) })
    } finally {
      cleanup(filePath)
    }
  })
})

export default router
