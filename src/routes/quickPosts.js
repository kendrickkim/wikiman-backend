import { Router } from 'express'
import { db } from '../db.js'
import { requireWriter } from '../middleware/auth.js'
import { sanitizePostContent } from '../sanitize.js'
import { rewriteContentFileUrls } from '../fileUrls.js'
import { syncUploadRefs } from '../attachments.js'
import { normalizeEditorType } from '../editors.js'
import { getSettings } from '../settings.js'
import { apiError, sendError } from '../errors.js'

const router = Router()

function mapQuickPost(row) {
  return {
    id: row.id,
    content: row.content || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function normalizeContent(raw) {
  const content = String(raw ?? '').trim()
  if (!content) {
    throw apiError('QUICK_POST_CONTENT_REQUIRED', 400)
  }
  return content
}

function getOwnedQuickPost(id, userId) {
  const row = db.prepare('SELECT * FROM quick_posts WHERE id = ?').get(id)
  if (!row || row.author_id !== userId) return null
  return row
}

function slugify(title) {
  const base = String(title)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'post'
  return `${base}-${Date.now().toString(36)}`
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function contentForEditor(content, editorType) {
  if (editorType === 'editorjs') {
    const blocks = String(content)
      .split(/\n{2,}/)
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text) => ({
        type: 'paragraph',
        data: { text: escapeHtml(text).replace(/\n/g, '<br>') }
      }))
    return JSON.stringify({ blocks })
  }
  if (editorType === 'ckeditor' || editorType === 'summernote' || editorType === 'html') {
    return String(content)
      .split(/\n{2,}/)
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text) => `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`)
      .join('')
  }
  return content
}

router.get('/', requireWriter, (req, res) => {
  const rows = db.prepare(`
    SELECT id, content, created_at, updated_at
    FROM quick_posts
    WHERE author_id = ?
    ORDER BY updated_at DESC, id DESC
  `).all(req.user.id)
  res.json({ quickPosts: rows.map(mapQuickPost) })
})

router.get('/:id', requireWriter, (req, res) => {
  const row = getOwnedQuickPost(req.params.id, req.user.id)
  if (!row) {
    return res.status(404).json({ error: 'QUICK_POST_NOT_FOUND' })
  }
  res.json({ quickPost: mapQuickPost(row) })
})

router.post('/', requireWriter, (req, res) => {
  try {
    const content = normalizeContent(req.body?.content)
    const result = db.prepare(`
      INSERT INTO quick_posts (author_id, content)
      VALUES (?, ?)
    `).run(req.user.id, content)
    const row = db.prepare('SELECT * FROM quick_posts WHERE id = ?').get(result.lastInsertRowid)
    res.status(201).json({ quickPost: mapQuickPost(row) })
  } catch (err) {
    sendError(res, err, 'QUICK_POST_INVALID', 400)
  }
})

router.patch('/:id', requireWriter, (req, res) => {
  const existing = getOwnedQuickPost(req.params.id, req.user.id)
  if (!existing) {
    return res.status(404).json({ error: 'QUICK_POST_NOT_FOUND' })
  }
  try {
    const content = normalizeContent(req.body?.content)
    db.prepare(`
      UPDATE quick_posts
      SET content = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(content, existing.id)
    const row = db.prepare('SELECT * FROM quick_posts WHERE id = ?').get(existing.id)
    res.json({ quickPost: mapQuickPost(row) })
  } catch (err) {
    sendError(res, err, 'QUICK_POST_INVALID', 400)
  }
})

router.delete('/:id', requireWriter, (req, res) => {
  const existing = getOwnedQuickPost(req.params.id, req.user.id)
  if (!existing) {
    return res.status(404).json({ error: 'QUICK_POST_NOT_FOUND' })
  }
  db.prepare('DELETE FROM quick_posts WHERE id = ?').run(existing.id)
  res.json({ ok: true })
})

router.post('/:id/promote', requireWriter, (req, res) => {
  const existing = getOwnedQuickPost(req.params.id, req.user.id)
  if (!existing) {
    return res.status(404).json({ error: 'QUICK_POST_NOT_FOUND' })
  }
  const content = String(existing.content || '').trim()
  if (!content) {
    return res.status(400).json({ error: 'QUICK_POST_EMPTY_PROMOTE' })
  }
  const settings = getSettings(req.user)
  const editorPref = settings.quickPostPromoteEditor
  const editorType = editorPref === 'ask'
    ? normalizeEditorType(req.body?.editorType, 'textarea')
    : editorPref
  const sourceMode = settings.quickPostPromoteSourceMode
  const keepSource = sourceMode === 'keep'
    || (sourceMode === 'ask' && req.body?.keepSource === true)

  try {
    const postId = db.transaction(() => {
      const sanitized = sanitizePostContent(editorType, contentForEditor(content, editorType))
      const slug = slugify('')
      const inserted = db.prepare(`
        INSERT INTO posts (title, slug, category_id, author_id, visibility, status, editor_type, content)
        VALUES (?, ?, NULL, ?, 'public', 'draft', ?, ?)
      `).run('', slug, req.user.id, editorType, sanitized)
      const id = Number(inserted.lastInsertRowid)
      const rewritten = rewriteContentFileUrls(sanitized, id)
      if (rewritten !== sanitized) {
        db.prepare('UPDATE posts SET content = ? WHERE id = ?').run(rewritten, id)
      }
      syncUploadRefs(db, id)
      if (!keepSource) {
        db.prepare('DELETE FROM quick_posts WHERE id = ?').run(existing.id)
      }
      return id
    })()

    const row = db.prepare(`
      SELECT
        posts.id, posts.title, posts.slug, posts.category_id, posts.author_id,
        posts.visibility, posts.status, posts.editor_type, posts.content,
        posts.created_at, posts.updated_at, posts.deleted_at,
        users.username AS author_name
      FROM posts
      JOIN users ON users.id = posts.author_id
      WHERE posts.id = ?
    `).get(postId)

    res.status(201).json({
      sourceKept: keepSource,
      post: {
        id: row.id,
        title: row.title,
        slug: row.slug,
        categoryId: row.category_id,
        authorId: row.author_id,
        authorName: row.author_name,
        visibility: row.visibility,
        status: row.status,
        editorType: row.editor_type,
        content: row.content,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        keywords: [],
        attachments: [],
        isHomepage: false,
        homepageSort: null
      }
    })
  } catch (err) {
    sendError(res, err, 'QUICK_POST_PROMOTE_FAILED', 500)
  }
})

export default router
