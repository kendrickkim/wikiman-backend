import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { db } from '../db.js'
import { publicUser, requireAuth, signToken, writerExists } from '../middleware/auth.js'
import { apiError, sendError } from '../errors.js'

const router = Router()
const allowRegister = (process.env.ALLOW_REGISTER ?? 'true') !== 'false'

router.get('/status', (_req, res) => {
  res.json({ canRegister: allowRegister && !writerExists() })
})

router.post('/register', (req, res) => {
  if (!allowRegister || writerExists()) {
    return sendError(res, apiError('REGISTER_CLOSED', 403))
  }

  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')

  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    return sendError(res, apiError('USERNAME_INVALID', 400))
  }
  if (password.length < 6) {
    return sendError(res, apiError('PASSWORD_TOO_SHORT', 400))
  }

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (exists) {
    return sendError(res, apiError('USERNAME_TAKEN', 409))
  }

  const passwordHash = bcrypt.hashSync(password, 10)
  const result = db.prepare(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
  ).run(username, passwordHash, 'writer')

  const row = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(result.lastInsertRowid)
  const user = publicUser(row)
  res.status(201).json({ token: signToken(user), user })
})

router.post('/login', (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')

  const row = db.prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?').get(username)
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return sendError(res, apiError('INVALID_CREDENTIALS', 401))
  }

  const user = publicUser(row)
  res.json({ token: signToken(user), user })
})

router.get('/me', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(req.user.id)
  if (!row) {
    return sendError(res, apiError('USER_NOT_FOUND', 401))
  }
  res.json({ user: publicUser(row) })
})

export default router
