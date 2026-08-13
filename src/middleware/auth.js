import jwt from 'jsonwebtoken'
import { db } from '../db.js'

function jwtSecret() {
  return process.env.JWT_SECRET || 'dev-secret-change-me'
}

export function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    jwtSecret(),
    { expiresIn: '7d' }
  )
}

export function publicUser(row) {
  const role = row.role === 'writer' ? 'writer' : 'reader'
  return {
    id: row.id,
    username: row.username,
    role,
    canWrite: role === 'writer'
  }
}

export function isWriter(userId) {
  const row = db.prepare('SELECT role FROM users WHERE id = ?').get(userId)
  return row?.role === 'writer'
}

export function writerExists() {
  return Boolean(db.prepare("SELECT id FROM users WHERE role = 'writer' LIMIT 1").get())
}

export function optionalAuth(req, _res, next) {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(header.slice(7), jwtSecret())
    } catch {
      req.user = null
    }
  }
  next()
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: '로그인이 필요합니다.' })
  }
  try {
    req.user = jwt.verify(header.slice(7), jwtSecret())
    next()
  } catch {
    return res.status(401).json({ error: '세션이 만료되었습니다. 다시 로그인하세요.' })
  }
}

export function requireWriter(req, res, next) {
  requireAuth(req, res, () => {
    if (!isWriter(req.user.id)) {
      return res.status(403).json({ error: '글 작성은 위키 작성자만 할 수 있습니다.' })
    }
    next()
  })
}
