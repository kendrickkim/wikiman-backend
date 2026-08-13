import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { db } from '../db.js'
import { publicUser, requireAuth, signToken, writerExists } from '../middleware/auth.js'

const router = Router()
const allowRegister = (process.env.ALLOW_REGISTER ?? 'true') !== 'false'

router.get('/status', (_req, res) => {
  res.json({ canRegister: allowRegister && !writerExists() })
})

router.post('/register', (req, res) => {
  if (!allowRegister || writerExists()) {
    return res.status(403).json({ error: '이 위키는 작성자 한 명만 가입할 수 있습니다.' })
  }

  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')

  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    return res.status(400).json({ error: '아이디는 3~32자의 영문, 숫자, 밑줄만 사용할 수 있습니다.' })
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' })
  }

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (exists) {
    return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' })
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
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' })
  }

  const user = publicUser(row)
  res.json({ token: signToken(user), user })
})

router.get('/me', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(req.user.id)
  if (!row) {
    return res.status(401).json({ error: '사용자를 찾을 수 없습니다.' })
  }
  res.json({ user: publicUser(row) })
})

export default router
