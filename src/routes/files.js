import { Router } from 'express'
import { canAccessStoredFile, resolveUploadPath, sendUploadFile } from '../files.js'

const router = Router()

router.get('/:name', (req, res) => {
  const storedName = req.params.name
  if (!canAccessStoredFile(storedName, req.user)) {
    return res.status(404).json({ error: 'FILE_NOT_FOUND' })
  }
  const filePath = resolveUploadPath(storedName)
  if (!filePath) {
    return res.status(404).json({ error: 'FILE_NOT_FOUND' })
  }
  sendUploadFile(res, filePath)
})

export default router
