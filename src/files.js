import fs from 'node:fs'
import path from 'node:path'
import { db } from './db.js'
import { isWriter } from './middleware/auth.js'
import { canReadPost } from './access.js'
import { resolveUploadPath } from './uploadPaths.js'

export { resolveUploadPath } from './uploadPaths.js'

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
}

const FORCE_DOWNLOAD_EXT = new Set(['.html', '.htm', '.svg', '.xhtml', '.xml', '.js', '.mjs', '.css'])

function faviconStoredName() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'favicon'").get()
  const value = String(row?.value || '')
  const match = value.match(/^\/api\/files\/([^/?#]+)$/)
  return match ? path.basename(match[1]) : ''
}

export function canAccessStoredFile(storedName, user, { postId = null } = {}) {
  const name = path.basename(String(storedName || ''))
  if (!name) return false
  if (user && isWriter(user.id)) return true
  if (faviconStoredName() === name) return true

  if (postId != null) {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId)
    if (!canReadPost(post, user)) return false
    const linked = db.prepare(
      'SELECT 1 FROM upload_refs WHERE post_id = ? AND stored_name = ?'
    ).get(postId, name)
    const attached = db.prepare(
      'SELECT 1 FROM post_attachments WHERE post_id = ? AND stored_name = ?'
    ).get(postId, name)
    return Boolean(linked || attached)
  }

  const rows = db.prepare(`
    SELECT posts.*
    FROM posts
    JOIN upload_refs ON upload_refs.post_id = posts.id
    WHERE upload_refs.stored_name = ?
  `).all(name)
  if (rows.some((row) => canReadPost(row, user))) return true

  // 아직 어떤 글에도 연결되지 않은 업로드는 편집 중 미리보기를 위해 열어 둡니다.
  return isUnlinkedUpload(name)
}

function isUnlinkedUpload(storedName) {
  const linked = db.prepare('SELECT 1 FROM upload_refs WHERE stored_name = ?').get(storedName)
  if (linked) return false
  const attached = db.prepare('SELECT 1 FROM post_attachments WHERE stored_name = ?').get(storedName)
  return !attached
}

export function sendUploadFile(res, filePath, { downloadName, mimeType } = {}) {
  const ext = path.extname(filePath).toLowerCase()
  const type = mimeType || MIME[ext] || 'application/octet-stream'
  const filename = downloadName || path.basename(filePath)
  const forceDownload = FORCE_DOWNLOAD_EXT.has(ext)
    || type.includes('html')
    || type.includes('svg')
    || type.includes('xml')
    || type.includes('javascript')

  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Content-Type', forceDownload ? 'application/octet-stream' : type)
  res.setHeader(
    'Content-Disposition',
    `${forceDownload ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename)}`
  )
  fs.createReadStream(filePath).pipe(res)
}
