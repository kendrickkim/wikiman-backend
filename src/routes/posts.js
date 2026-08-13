import { Router } from 'express'
import { db } from '../db.js'
import { requireWriter } from '../middleware/auth.js'

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
      sql: `((posts.status = 'published' AND (posts.visibility = 'public' OR posts.author_id = ?)) OR (posts.status = 'draft' AND posts.author_id = ?))`,
      params: [user.id, user.id]
    }
  }
  return { sql: "posts.status = 'published' AND posts.visibility = 'public'", params: [] }
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

function mapPost(row, { includeContent = false } = {}) {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
  if (includeContent) post.content = row.content
  return post
}

const LIST_SELECT = `
  SELECT
    posts.id, posts.title, posts.slug, posts.category_id, posts.author_id,
    posts.visibility, posts.status, posts.editor_type, posts.created_at, posts.updated_at,
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
  if (q) {
    const like = `%${q.replace(/[%_]/g, '')}%`
    const ftsQuery = q
      .replace(/['"]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => `"${term}"*`)
      .join(' AND ')
    if (ftsQuery) {
      where.push(`(
        posts.id IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)
        OR posts.title LIKE ? OR posts.content LIKE ?
      )`)
      queryParams.push(ftsQuery, like, like)
    } else {
      where.push('(posts.title LIKE ? OR posts.content LIKE ?)')
      queryParams.push(like, like)
    }
  }

  let rows
  try {
    rows = db.prepare(`
      ${LIST_SELECT}
      WHERE ${where.join(' AND ')}
      ORDER BY posts.updated_at DESC, posts.id DESC
    `).all(...queryParams)
  } catch {
    const like = `%${q.replace(/[%_]/g, '')}%`
    const { sql, params } = visibilityFilter(req.user)
    rows = db.prepare(`
      ${LIST_SELECT}
      WHERE ${sql} AND (posts.title LIKE ? OR posts.content LIKE ?)
      ORDER BY posts.updated_at DESC, posts.id DESC
    `).all(...params, like, like)
  }

  res.json({ posts: rows.map((row) => mapPost(row)) })
})

router.get('/:id', (req, res) => {
  const row = db.prepare(`
    ${LIST_SELECT.replace('posts.updated_at', 'posts.updated_at, posts.content')}
    WHERE posts.id = ?
  `).get(req.params.id)

  if (!row) {
    return res.status(404).json({ error: '글을 찾을 수 없습니다.' })
  }
  const isOwner = req.user?.id === row.author_id
  if (row.status === 'draft' && !isOwner) {
    return res.status(404).json({ error: '글을 찾을 수 없습니다.' })
  }
  if (row.visibility === 'private' && !isOwner) {
    return res.status(404).json({ error: '글을 찾을 수 없습니다.' })
  }

  res.json({ post: mapPost(row, { includeContent: true }) })
})

router.post('/', requireWriter, (req, res) => {
  const title = String(req.body?.title || '').trim()
  const visibility = req.body?.visibility === 'private' ? 'private' : 'public'
  const status = req.body?.status === 'published' ? 'published' : 'draft'
  const editorType = req.body?.editorType === 'markdown' ? 'markdown' : 'editorjs'
  const content = req.body?.content == null ? (editorType === 'markdown' ? '' : '{"blocks":[]}') : String(req.body.content)
  let categoryId = req.body?.categoryId ?? req.body?.category_id ?? null
  if (categoryId === '' || categoryId === 0) categoryId = null

  if (!title) {
    return res.status(400).json({ error: '제목을 입력하세요.' })
  }
  if (categoryId != null) {
    const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId)
    if (!category) {
      return res.status(400).json({ error: '카테고리를 찾을 수 없습니다.' })
    }
  }

  const slug = slugify(title)
  const result = db.prepare(`
    INSERT INTO posts (title, slug, category_id, author_id, visibility, status, editor_type, content)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, slug, categoryId, req.user.id, visibility, status, editorType, content)

  const row = db.prepare(`
    ${LIST_SELECT.replace('posts.updated_at', 'posts.updated_at, posts.content')}
    WHERE posts.id = ?
  `).get(result.lastInsertRowid)

  res.status(201).json({ post: mapPost(row, { includeContent: true }) })
})

router.patch('/:id', requireWriter, (req, res) => {
  const existing = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id)
  if (!existing) {
    return res.status(404).json({ error: '글을 찾을 수 없습니다.' })
  }

  const title = req.body?.title != null ? String(req.body.title).trim() : existing.title
  if (!title) {
    return res.status(400).json({ error: '제목을 입력하세요.' })
  }

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
    ? (req.body.editorType === 'markdown' ? 'markdown' : 'editorjs')
    : existing.editor_type
  const content = req.body?.content != null ? String(req.body.content) : existing.content
  const slug = title !== existing.title ? slugify(title) : existing.slug

  db.prepare(`
    UPDATE posts
    SET title = ?, slug = ?, category_id = ?, visibility = ?, status = ?, editor_type = ?, content = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(title, slug, categoryId, visibility, status, editorType, content, existing.id)

  const row = db.prepare(`
    ${LIST_SELECT.replace('posts.updated_at', 'posts.updated_at, posts.content')}
    WHERE posts.id = ?
  `).get(existing.id)

  res.json({ post: mapPost(row, { includeContent: true }) })
})

router.delete('/:id', requireWriter, (req, res) => {
  const existing = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id)
  if (!existing) {
    return res.status(404).json({ error: '글을 찾을 수 없습니다.' })
  }
  db.prepare('DELETE FROM posts WHERE id = ?').run(existing.id)
  res.json({ ok: true })
})

export default router
