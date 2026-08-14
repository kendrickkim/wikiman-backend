import { Router } from 'express'
import { canAccessStoredFile, resolveUploadPath, sendUploadFile } from '../files.js'

const router = Router()

router.get('/:name', (req, res) => {
  const storedName = req.params.name
  if (!canAccessStoredFile(storedName, req.user)) {
    return res.status(404).json({ error: '파일을 찾을 수 없습니다.' })
  }
  const filePath = resolveUploadPath(storedName)
  if (!filePath) {
    return res.status(404).json({ error: '파일을 찾을 수 없습니다.' })
  }
  sendUploadFile(res, filePath)
})

export default router
