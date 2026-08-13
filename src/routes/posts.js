import { Router } from 'express'
import { db } from '../db.js'
import { emptyEditorContent, normalizeEditorType } from '../editors.js'
import { keywordsByPostIds, listKeywords, normalizeKeywords, replacePostKeywords } from '../keywords.js'
import { requireAuth, requireWriter } from '../middleware/auth.js'
import { applyHomepageFlag, getHomePostId, setHomePostId } from '../settings.js'

const router = Router()

function slugify(title) {
  const base = String(title)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'post'
  return `${base}-${Date.now().toString(36)}`
}

function visibilityFilter(user) {
  if (user) {
    return {
      sql: `posts.deleted_at IS NULL AND ((posts.status = 'published' AND (posts.visibility = 'public' OR posts.author_id = ?)) OR (posts.status = 'draft' AND posts.author_id = ?))`,
      params: [user.id, user.id]
    }
  }
  return { sql: "posts.deleted_at IS NULL AND posts.status = 'published' AND posts.visibility = 'public'", params: [] }
}

function descendantIds(categoryId) {
  const all = db.prepare('SELECT id, parent_id FROM categories').all()
  const children = new Map()
  for (const row of all) {
    const key = row.parent_id ?? 0
    if (!children.has(key)) children.set(key, [])
    children.get(key).push(row.id)
  }
  const ids = []
  const stack = [Number(categoryId)]
  while (stack.length) {
    const current = stack.pop()
    ids.push(current)
    for (const child of children.get(current) || []) stack.push(child)
  }
  return ids
}

function mapPost(row, { includeContent = false, keywords = [], isHomepage = false } = {}) {
  if (!row) return null
  const post = {
    id: row.id,
    title: row.title,
    slug: row.slug,
    categoryId: row.category_id,
    categoryName: row.category_name ?? null,
    authorId: row.author_id,
    authorName: row.author_name,
    visibility: row.visibility,
    status: row.status || 'published',
    editorType: row.editor_type,
    keywords,
    isHomepage,
    deletedAt: row.deleted_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
  if (includeContent) post.content = row.content
  return post
}

function withKeywords(rows, options = {}) {
  const map = keywordsByPostIds(db, rows.map((row) => row.id))
  const homePostId = getHomePostId()
  return rows.map((row) => mapPost(row, {
    ...options,
    keywords: map.get(row.id) || [],
    isHomepage: row.id === homePostId
  }))
}

function parseHomepageFlag(body) {
  if (!body || !('isHomepage' in body)) return null
  return body.isHomepage === true || body.isHomepage === 'true' || body.isHomepage === 1 || body.isHomepage === '1'
}

const LIST_SELECT = `
  SELECT
    posts.id, posts.title, posts.slug, posts.category_id, posts.author_id,
    posts.visibility, posts.status, posts.editor_type, posts.created_at, posts.updated_at, posts.deleted_at,
    users.username AS author_name,
    categories.name AS category_name
  FROM posts
  JOIN users ON users.id = posts.author_id
  LEFT JOIN categories ON categories.id = posts.category_id
`

router.get('/', (req, res) => {
  const { sql, params } = visibilityFilter(req.user)
  const where = [sql]
  const queryParams = [...params]

  const categoryId = req.query.categoryId ?? req.query.category_id
  if (categoryId === 'uncategorized' || categoryId === '0') {
    where.push('posts.category_id IS NULL')
  } else if (categoryId && Number.isFinite(Number(categoryId))) {
    const ids = descendantIds(categoryId)
    where.push(`posts.category_id IN (${ids.map(() => '?').join(',')})`)
    queryParams.push(...ids)
  }

  const status = req.query.status
  if (status === 'draft' || status === 'published') {
    where.push('posts.status = ?')
    queryParams.push(status)
  }

  const q = String(req.query.q || '').trim()
  const like = q ? `%${q.replace(/[%_]/g, '')}%` : ''
  let orderSql = 'ORDER BY posts.updated_at DESC, posts.id DESC'
  if (q) {
    const ftsQuery = q
      .replace(/['"]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => `"${term}"*`)
      .join(' AND ')
    if (ftsQuery) {
      where.push(`(
        EXISTS (
          SELECT 1 FROM post_keywords pk
          WHERE pk.post_id = posts.id AND pk.keyword LIKE ?
        )
        OR posts.id IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)
        OR posts.title LIKE ? OR posts.content LIKE ?
      )`)
      queryParams.push(like, ftsQuery, like, like)
    } else {
      where.push(`(
        EXISTS (
          SELECT 1 FROM post_keywords pk
          WHERE pk.post_id = posts.id AND pk.keyword LIKE ?
        )
        OR posts.title LIKE ? OR posts.content LIKE ?
      )`)
      queryParams.push(like, like, like)
    }
    orderSql = `
      ORDER BY
        CASE
          WHEN EXISTS (
            SELECT 1 FROM post_keywords pk
            WHERE pk.post_id = posts.id AND lower(pk.keyword) = lower(?)
          ) THEN 0
          WHEN EXISTS (
            SELECT 1 FROM post_keywords pk
            WHERE pk.post_id = posts.id AND pk.keyword LIKE ?
          ) THEN 1
          WHEN posts.title LIKE ? THEN 2
          ELSE 3
        END,
        posts.updated_at DESC, posts.id DESC
    `
  }

  let rows
  try {
    const orderParams = q ? [q, like, like] : []
    rows = db.prepare(`
      ${LIST_SELECT}
      WHERE ${where.join(' AND ')}
      ${orderSql}
    `).all(...queryParams, ...orderParams)
  } catch {
    const fallbackLike = `%${q.replace(/[%_]/g, '')}%`
    const vis = visibilityFilter(req.user)
    rows = db.prepare(`
      ${LIST_SELECT}
      WHERE ${vis.sql} AND (
        EXISTS (
          SELECT 1 FROM post_keywords pk
          WHERE pk.post_id = posts.id AND pk.keyword LIKE ?
        )
        OR posts.title LIKE ? OR posts.content LIKE ?
      )
      ORDER BY
        CASE
          WHEN EXISTS (
            SELECT 1 FROM post_keywords pk
            WHERE pk.post_id = posts.id AND lower(pk.keyword) = lower(?)
          ) THEN 0
          WHEN EXISTS (
            SELECT 1 FROM post_keywords pk
            WHERE pk.post_id = posts.id AND pk.keyword LIKE ?
          ) THEN 1
          WHEN posts.title LIKE ? THEN 2
          ELSE 3
        END,
        posts.updated_at DESC, posts.id DESC
    `).all(...vis.params, fallbackLike, fallbackLike, fallbackLike, q, fallbackLike, fallbackLike)
  }

  res.json({ posts: withKeywords(rows) })
})

router.get('/keywords', (req, res) => {
  res.json({ keywords: listKeywords(db, req.query.q) })
})

router.get('/trash', requireAuth, (req, res) => {
  const rows = db.prepare(`
    ${LIST_SELECT}
    WHERE posts.deleted_at IS NOT NULL
    ORDER BY posts.deleted_at DESC, posts.id DESC
  `).all()
  res.json({ posts: withKeywords(rows) })
})

router.post('/:id/restore', requireWriter, (req, res) => {
  const existing = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id)
  if (!existing || !existing.deleted_at) {
    return res.status(404).json({ error: '휴지통에서 글을 찾을 수 없습니다.' })
  }
  db.prepare("UPDATE posts SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?").run(existing.id)
  const row = db.prepare(`
    ${LIST_SELECT.replace('posts.updated_at', 'posts.updated_at, posts.content')}
    WHERE posts.id = ?
  `).get(existing.id)
  res.json({ post: withKeywords([row], { includeContent: true })[0] })
})

router.delete('/:id/permanent', requireWriter, (req, res) => {
  const existing = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id)
  if (!existing || !existing.deleted_at) {
    return res.status(404).json({ error: '휴지통에서 글을 찾을 수 없습니다.' })
  }
  db.prepare('DELETE FROM posts WHERE id = ?').run(existing.id)
  if (getHomePostId() === existing.id) setHomePostId(null)
  res.json({ ok: true })
})

router.get('/:id', (req, res) => {
  const row = db.prepare(`
    ${LIST_SELECT.replace('posts.updated_at', 'posts.updated_at, posts.content')}
    WHERE posts.id = ?
  `).get(req.params.id)

  if (!row || row.deleted_at) {
    return res.status(404).json({ error: '글을 찾을 수 없습니다.' })
  }
  const isOwner = req.user?.id === row.author_id
  if (row.status === 'draft' && !isOwner) {
    return res.status(404).json({ error: '글을 찾을 수 없습니다.' })
  }
  if (row.visibility === 'private' && !isOwner) {
    return res.status(404).json({ error: '글을 찾을 수 없습니다.' })
  }

  res.json({ post: withKeywords([row], { includeContent: true })[0] })
})

router.post('/', requireWriter, (req, res) => {
  const title = String(req.body?.title || '').trim()
  const visibility = req.body?.visibility === 'private' ? 'private' : 'public'
  const status = req.body?.status === 'published' ? 'published' : 'draft'
  const editorType = normalizeEditorType(req.body?.editorType)
  const content = req.body?.content == null ? emptyEditorContent(editorType) : String(req.body.content)
  let categoryId = req.body?.categoryId ?? req.body?.category_id ?? null
  if (categoryId === '' || categoryId === 0) categoryId = null

  if (categoryId != null) {
    const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId)
    if (!category) {
      return res.status(400).json({ error: '카테고리를 찾을 수 없습니다.' })
    }
  }

  const keywords = normalizeKeywords(req.body?.keywords)
  const slug = slugify(title)
  const result = db.transaction(() => {
    const inserted = db.prepare(`
      INSERT INTO posts (title, slug, category_id, author_id, visibility, status, editor_type, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(title, slug, categoryId, req.user.id, visibility, status, editorType, content)
    replacePostKeywords(db, inserted.lastInsertRowid, keywords)
    const homepage = parseHomepageFlag(req.body)
    if (homepage != null) applyHomepageFlag(inserted.lastInsertRowid, homepage)
    return inserted.lastInsertRowid
  })()

  const row = db.prepare(`
    ${LIST_SELECT.replace('posts.updated_at', 'posts.updated_at, posts.content')}
    WHERE posts.id = ?
  `).get(result)

  res.status(201).json({ post: withKeywords([row], { includeContent: true })[0] })
})

router.patch('/:id', requireWriter, (req, res) => {
  const existing = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id)
  if (!existing || existing.deleted_at) {
    return res.status(404).json({ error: '글을 찾을 수 없습니다.' })
  }

  const title = req.body?.title != null ? String(req.body.title).trim() : existing.title

  let categoryId = existing.category_id
  if ('categoryId' in (req.body || {}) || 'category_id' in (req.body || {})) {
    categoryId = req.body.categoryId ?? req.body.category_id ?? null
    if (categoryId === '' || categoryId === 0) categoryId = null
  }
  if (categoryId != null) {
    const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId)
    if (!category) {
      return res.status(400).json({ error: '카테고리를 찾을 수 없습니다.' })
    }
  }

  const visibility = req.body?.visibility
    ? (req.body.visibility === 'private' ? 'private' : 'public')
    : existing.visibility
  const status = req.body?.status
    ? (req.body.status === 'published' ? 'published' : 'draft')
    : (existing.status || 'published')
  const editorType = req.body?.editorType
    ? normalizeEditorType(req.body.editorType)
    : existing.editor_type
  const content = req.body?.content != null ? String(req.body.content) : existing.content
  const slug = title !== existing.title ? slugify(title) : existing.slug
  const keywords = 'keywords' in (req.body || {})
    ? normalizeKeywords(req.body.keywords)
    : null

  db.transaction(() => {
    db.prepare(`
      UPDATE posts
      SET title = ?, slug = ?, category_id = ?, visibility = ?, status = ?, editor_type = ?, content = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(title, slug, categoryId, visibility, status, editorType, content, existing.id)
    if (keywords) replacePostKeywords(db, existing.id, keywords)
    const homepage = parseHomepageFlag(req.body)
    if (homepage != null) applyHomepageFlag(existing.id, homepage)
  })()

  const row = db.prepare(`
    ${LIST_SELECT.replace('posts.updated_at', 'posts.updated_at, posts.content')}
    WHERE posts.id = ?
  `).get(existing.id)

  res.json({ post: withKeywords([row], { includeContent: true })[0] })
})

router.delete('/:id', requireWriter, (req, res) => {
  const existing = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id)
  if (!existing || existing.deleted_at) {
    return res.status(404).json({ error: '글을 찾을 수 없습니다.' })
  }
  db.prepare("UPDATE posts SET deleted_at = datetime('now') WHERE id = ?").run(existing.id)
  res.json({ ok: true, trashed: true })
})

export default router
