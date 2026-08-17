import fs from 'node:fs'
import path from 'node:path'
import { extractStoredNamesFromContent, fileUrlForPost } from './fileUrls.js'
import { resolveUploadPath, walkUploadFiles } from './uploadPaths.js'

export const MAX_FILES_PER_REQUEST = 20
export const MAX_ATTACHMENTS = 50

export function mapAttachment(row) {
  return {
    id: row.id,
    storedName: row.stored_name,
    originalName: row.original_name,
    mimeType: row.mime_type,
    size: row.size,
    url: fileUrlForPost(row.post_id, row.stored_name),
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
    const filePath = resolveUploadPath(storedName)
    if (!filePath) continue
    seen.add(storedName)
    const originalName = String(item?.originalName || item?.original_name || storedName).trim().slice(0, 200) || storedName
    const mimeType = String(item?.mimeType || item?.mime_type || 'application/octet-stream').slice(0, 120)
    const size = Math.max(0, Number(item?.size) || 0)
    list.push({ storedName, originalName, mimeType, size })
    if (list.length >= MAX_ATTACHMENTS) break
  }
  return list
}

function faviconStoredName(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'favicon'").get()
  const value = String(row?.value || '')
  const match = value.match(/^\/api\/files\/([^/?#]+)$/)
  return match ? path.basename(match[1]) : ''
}

function usedStoredNames(db, excludePostId = null) {
  const used = new Set()
  const favicon = faviconStoredName(db)
  if (favicon) used.add(favicon)

  const refSql = excludePostId == null
    ? 'SELECT DISTINCT stored_name FROM upload_refs'
    : 'SELECT DISTINCT stored_name FROM upload_refs WHERE post_id != ?'
  const refRows = excludePostId == null
    ? db.prepare(refSql).all()
    : db.prepare(refSql).all(excludePostId)
  for (const row of refRows) used.add(row.stored_name)

  const attachmentSql = excludePostId == null
    ? 'SELECT DISTINCT stored_name FROM post_attachments'
    : 'SELECT DISTINCT stored_name FROM post_attachments WHERE post_id != ?'
  const attachmentRows = excludePostId == null
    ? db.prepare(attachmentSql).all()
    : db.prepare(attachmentSql).all(excludePostId)
  for (const row of attachmentRows) used.add(row.stored_name)

  return used
}

export function syncUploadRefs(db, postId) {
  const post = db.prepare('SELECT content FROM posts WHERE id = ?').get(postId)
  db.prepare('DELETE FROM upload_refs WHERE post_id = ?').run(postId)
  const insert = db.prepare('INSERT OR IGNORE INTO upload_refs (post_id, stored_name) VALUES (?, ?)')
  for (const row of db.prepare('SELECT stored_name FROM post_attachments WHERE post_id = ?').all(postId)) {
    insert.run(postId, row.stored_name)
  }
  for (const name of extractStoredNamesFromContent(post?.content)) {
    insert.run(postId, name)
  }
}

/** 업로드 폴더에서 글 첨부·본문·파비콘에 쓰이지 않는 파일을 찾습니다. */
export function listOrphanUploads(db) {
  const used = usedStoredNames(db)
  const orphans = []
  for (const file of walkUploadFiles()) {
    if (used.has(file.name)) continue
    orphans.push({ name: file.name, size: file.size })
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
  const filePath = resolveUploadPath(storedName)
  if (!filePath) return
  try {
    fs.unlinkSync(filePath)
  } catch {
    // ignore missing files
  }
}

export function unlinkStoredNames(names) {
  for (const name of names || []) unlinkStoredName(name)
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

  syncUploadRefs(db, postId)
  const used = usedStoredNames(db)
  const kept = new Set(attachments.map((file) => file.storedName))
  const toUnlink = []
  for (const row of previous) {
    if (kept.has(row.stored_name)) continue
    if (used.has(row.stored_name)) continue
    toUnlink.push(row.stored_name)
  }
  return toUnlink
}

/** 글의 첨부·본문 이미지 등 업로드 파일을 정리합니다. 다른 글/파비콘이 쓰는 파일은 남깁니다. */
export function deletePostUploadFiles(db, post) {
  if (!post?.id) return []
  const names = new Set()
  for (const row of db.prepare('SELECT stored_name FROM post_attachments WHERE post_id = ?').all(post.id)) {
    names.add(row.stored_name)
  }
  for (const name of extractStoredNamesFromContent(post.content)) {
    names.add(name)
  }

  const usedElsewhere = usedStoredNames(db, post.id)
  db.prepare('DELETE FROM post_attachments WHERE post_id = ?').run(post.id)
  db.prepare('DELETE FROM upload_refs WHERE post_id = ?').run(post.id)

  const toUnlink = []
  for (const storedName of names) {
    if (usedElsewhere.has(storedName)) continue
    toUnlink.push(storedName)
  }
  return toUnlink
}
