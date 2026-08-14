import fs from 'node:fs'
import path from 'node:path'
import { uploadsDir } from './db.js'

export const MAX_FILES_PER_REQUEST = 20
export const MAX_ATTACHMENTS = 50
/** @deprecated 설정값 getMaxAttachmentBytes()를 사용하세요 */
export const MAX_FILE_SIZE = 20 * 1024 * 1024

// Markdown URL의 닫는 괄호는 파일명에 포함하지 않습니다.
// 예: ![이미지](/api/files/example.png)
const FILE_URL_RE = /\/api\/files\/([^/?#"'\s<>\\)]+)/g

export function mapAttachment(row) {
  return {
    id: row.id,
    storedName: row.stored_name,
    originalName: row.original_name,
    mimeType: row.mime_type,
    size: row.size,
    url: `/api/files/${row.stored_name}`,
    downloadUrl: `/api/posts/${row.post_id}/attachments/${row.id}`
  }
}

export function attachmentsByPostIds(db, postIds) {
  const map = new Map()
  if (!postIds.length) return map
  const rows = db.prepare(`
    SELECT id, post_id, stored_name, original_name, mime_type, size
    FROM post_attachments
    WHERE post_id IN (${postIds.map(() => '?').join(',')})
    ORDER BY sort_order ASC, id ASC
  `).all(...postIds)
  for (const row of rows) {
    if (!map.has(row.post_id)) map.set(row.post_id, [])
    map.get(row.post_id).push(mapAttachment(row))
  }
  return map
}

export function normalizeAttachments(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const list = []
  for (const item of input) {
    const storedName = path.basename(String(item?.storedName || item?.stored_name || ''))
    if (!storedName || storedName.includes('..')) continue
    if (seen.has(storedName)) continue
    if (!fs.existsSync(path.join(uploadsDir, storedName))) continue
    seen.add(storedName)
    const originalName = String(item?.originalName || item?.original_name || storedName).trim().slice(0, 200) || storedName
    const mimeType = String(item?.mimeType || item?.mime_type || 'application/octet-stream').slice(0, 120)
    const size = Math.max(0, Number(item?.size) || 0)
    list.push({ storedName, originalName, mimeType, size })
    if (list.length >= MAX_ATTACHMENTS) break
  }
  return list
}

export function extractStoredNamesFromContent(content) {
  const names = new Set()
  const text = String(content || '')
  FILE_URL_RE.lastIndex = 0
  let match
  while ((match = FILE_URL_RE.exec(text))) {
    let raw = match[1]
    try {
      raw = decodeURIComponent(raw)
    } catch {
      // keep raw
    }
    const storedName = path.basename(raw)
    if (!storedName || storedName.includes('..')) continue
    names.add(storedName)
  }
  return names
}

function faviconStoredName(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'favicon'").get()
  const value = String(row?.value || '')
  const match = value.match(/^\/api\/files\/([^/?#]+)$/)
  return match ? path.basename(match[1]) : ''
}

function collectUsedStoredNames(db, excludePostId = null) {
  const used = new Set()
  const favicon = faviconStoredName(db)
  if (favicon) used.add(favicon)

  const attachmentSql = excludePostId == null
    ? 'SELECT stored_name FROM post_attachments'
    : 'SELECT stored_name FROM post_attachments WHERE post_id != ?'
  const attachmentRows = excludePostId == null
    ? db.prepare(attachmentSql).all()
    : db.prepare(attachmentSql).all(excludePostId)
  for (const row of attachmentRows) used.add(row.stored_name)

  const postSql = excludePostId == null
    ? 'SELECT content FROM posts'
    : 'SELECT content FROM posts WHERE id != ?'
  const posts = excludePostId == null
    ? db.prepare(postSql).all()
    : db.prepare(postSql).all(excludePostId)
  for (const post of posts) {
    for (const name of extractStoredNamesFromContent(post.content)) used.add(name)
  }
  return used
}

/** 업로드 폴더에서 글 첨부·본문·파비콘에 쓰이지 않는 파일을 찾습니다. */
export function listOrphanUploads(db) {
  const used = collectUsedStoredNames(db)
  const orphans = []
  for (const entry of fs.readdirSync(uploadsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const name = entry.name
    if (!name || name.startsWith('.')) continue
    if (used.has(name)) continue
    let size = 0
    try {
      size = fs.statSync(path.join(uploadsDir, name)).size
    } catch {
      continue
    }
    orphans.push({ name, size })
  }
  orphans.sort((a, b) => a.name.localeCompare(b.name, 'ko'))
  return orphans
}

export function summarizeOrphanUploads(db) {
  const files = listOrphanUploads(db)
  return {
    count: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    files
  }
}

export function deleteOrphanUploads(db) {
  const files = listOrphanUploads(db)
  let deletedBytes = 0
  for (const file of files) {
    unlinkStoredName(file.name)
    deletedBytes += file.size
  }
  return {
    deletedCount: files.length,
    deletedBytes,
    files: files.map((file) => file.name)
  }
}

function unlinkStoredName(storedName) {
  try {
    fs.unlinkSync(path.join(uploadsDir, storedName))
  } catch {
    // ignore missing files
  }
}

export function replacePostAttachments(db, postId, attachments) {
  const previous = db.prepare('SELECT stored_name FROM post_attachments WHERE post_id = ?').all(postId)
  db.prepare('DELETE FROM post_attachments WHERE post_id = ?').run(postId)
  const insert = db.prepare(`
    INSERT INTO post_attachments (post_id, stored_name, original_name, mime_type, size, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  attachments.forEach((file, index) => {
    insert.run(postId, file.storedName, file.originalName, file.mimeType, file.size, index)
  })

  const post = db.prepare('SELECT content FROM posts WHERE id = ?').get(postId)
  const stillInContent = extractStoredNamesFromContent(post?.content)
  const kept = new Set(attachments.map((file) => file.storedName))
  const usedElsewhere = collectUsedStoredNames(db, postId)

  for (const row of previous) {
    if (kept.has(row.stored_name)) continue
    if (stillInContent.has(row.stored_name)) continue
    if (usedElsewhere.has(row.stored_name)) continue
    unlinkStoredName(row.stored_name)
  }
}

/** @deprecated use deletePostUploadFiles */
export function deleteAttachmentFiles(db, postId) {
  const post = db.prepare('SELECT id, content FROM posts WHERE id = ?').get(postId)
  if (!post) return
  deletePostUploadFiles(db, post)
}

/** 글의 첨부·본문 이미지 등 업로드 파일을 정리합니다. 다른 글/파비콘이 쓰는 파일은 남깁니다. */
export function deletePostUploadFiles(db, post) {
  if (!post?.id) return
  const names = new Set()
  for (const row of db.prepare('SELECT stored_name FROM post_attachments WHERE post_id = ?').all(post.id)) {
    names.add(row.stored_name)
  }
  for (const name of extractStoredNamesFromContent(post.content)) {
    names.add(name)
  }

  const usedElsewhere = collectUsedStoredNames(db, post.id)
  for (const storedName of names) {
    if (usedElsewhere.has(storedName)) continue
    unlinkStoredName(storedName)
  }
  db.prepare('DELETE FROM post_attachments WHERE post_id = ?').run(post.id)
}
