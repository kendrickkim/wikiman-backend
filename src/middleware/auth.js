import jwt from 'jsonwebtoken'
import { db } from '../db.js'
import { jwtSecret } from '../jwt.js'
import { apiError, sendError } from '../errors.js'

export { jwtSecret, assertJwtSecret } from '../jwt.js'

const TOKEN_COOKIE = 'wikiman_token'

function parseCookies(header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (!key) continue
    try {
      out[key] = decodeURIComponent(value)
    } catch {
      out[key] = value
    }
  }
  return out
}

function tokenFromRequest(req) {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7)
  const cookies = parseCookies(req.headers.cookie)
  return cookies[TOKEN_COOKIE] || ''
}

function userFromToken(token) {
  if (!token) return null
  try {
    return jwt.verify(token, jwtSecret())
  } catch {
    return null
  }
}

export function signToken(user) {
  const canWrite = user.canWrite === true || user.role === 'writer'
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: canWrite ? 'writer' : 'reader',
      canWrite
    },
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
  req.user = userFromToken(tokenFromRequest(req))
  next()
}

export function requireAuth(req, res, next) {
  const user = userFromToken(tokenFromRequest(req))
  if (!user) {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ') && !parseCookies(req.headers.cookie)[TOKEN_COOKIE]) {
      return sendError(res, apiError('UNAUTHORIZED', 401))
    }
    return sendError(res, apiError('SESSION_EXPIRED', 401))
  }
  req.user = user
  next()
}

export function requireWriter(req, res, next) {
  requireAuth(req, res, () => {
    if (!isWriter(req.user.id) || req.user.canWrite === false) {
      return sendError(res, apiError('WRITER_ONLY', 403))
    }
    req.user.canWrite = true
    next()
  })
}
