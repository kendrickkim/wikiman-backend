import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { db, uploadsDir } from '../db.js'
import { emptyEditorContent, normalizeEditorType } from '../editors.js'
import { keywordsByPostIds, normalizeKeywords, replacePostKeywords } from '../keywords.js'
import {
  attachmentsByPostIds,
  deletePostUploadFiles,
  normalizeAttachments,
  replacePostAttachments,
  syncUploadRefs,
  unlinkStoredNames
} from '../attachments.js'
import { requireWriter } from '../middleware/auth.js'
import {
  applyHomepageFlag,
  getHomePostIds,
  getHomepageSortMap,
  removeHomepagePost,
  setHomepageOrder
} from '../homepage.js'
import { canReadPost, visibilityFilter } from '../access.js'
import { rewriteContentFileUrls } from '../fileUrls.js'
import { sanitizePostContent } from '../sanitize.js'
import { canAccessStoredFile, resolveUploadPath, sendUploadFile } from '../files.js'
import { sendError } from '../errors.js'

const router = Router()

let stmts = null
let stmtsDb = null

function statements() {
  if (stmts && stmtsDb === db) return stmts
  stmtsDb = db
  stmts = {
    getPost: db.prepare('SELECT * FROM posts WHERE id = ?'),
    getCategory: db.prepare('SELECT id FROM categories WHERE id = ?'),
    allCategories: db.prepare('SELECT id, parent_id FROM categories')
  }
  return stmts
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

function descendantIds(categoryId) {
  const all = statements().allCategories.all()
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

function mapPost(row, { includeContent = false, keywords = [], isHomepage = false, homepageSort = null } = {}) {
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
    homepageSort,
    deletedAt: row.deleted_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
  if (includeContent) {
    post.content = sanitizePostContent(row.editor_type, row.content)
  }
  return post
}

function withKeywords(rows, options = {}) {
  const map = keywordsByPostIds(db, rows.map((row) => row.id))
  const files = options.includeContent ? attachmentsByPostIds(db, rows.map((row) => row.id)) : null
  return rows.map((row) => {
    const sort = row.homepage_sort != null ? Number(row.homepage_sort) : null
    const post = mapPost(row, {
      ...options,
      keywords: map.get(row.id) || [],
      isHomepage: sort != null,
      homepageSort: sort
    })
    if (files) post.attachments = files.get(row.id) || []
    return post
  })
}

function parseHomepageFlag(body) {
  if (!body || !('isHomepage' in body)) return null
  return body.isHomepage === true || body.isHomepage === 'true' || body.isHomepage === 1 || body.isHomepage === '1'
}

function parseHomepageSort(body) {
  if (!body || !('homepageSort' in body)) return null
  const n = Math.round(Number(body.homepageSort))
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(9999, n))
}

function prepareContent(editorType, content, postId) {
  const sanitized = sanitizePostContent(editorType, content)
  return rewriteContentFileUrls(sanitized, postId)
}

const LIST_SELECT = `
  SELECT
    posts.id, posts.title, posts.slug, posts.category_id, posts.author_id,
    posts.visibility, posts.status, posts.editor_type, posts.created_at, posts.updated_at, posts.deleted_at,
    users.username AS author_name,
    categories.name AS category_name,
    homepage_posts.sort_order AS homepage_sort
  FROM posts
  JOIN users ON users.id = posts.author_id
  LEFT JOIN categories ON categories.id = posts.category_id
  LEFT JOIN homepage_posts ON homepage_posts.post_id = posts.id
`

const DEFAULT_PAGE_SIZE = 10
const MIN_PAGE_SIZE = 1
const MAX_PAGE_SIZE = 100

function parsePaging(query) {
  const sizeRaw = Math.round(Number(query?.pageSize ?? query?.limit))
  const pageSize = Number.isFinite(sizeRaw) && sizeRaw >= MIN_PAGE_SIZE && sizeRaw <= MAX_PAGE_SIZE
    ? sizeRaw
    : DEFAULT_PAGE_SIZE
  const pageRaw = Math.floor(Number(query?.page))
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1
  return { page, pageSize }
}

function listFromSql(fromSql, whereSql, queryParams, orderSql, orderParams, paging, { includeContent = false } = {}) {
  const countRow = db.prepare(`
    SELECT COUNT(*) AS total
    ${fromSql}
    WHERE ${whereSql}
  `).get(...queryParams)
  const total = Number(countRow?.total) || 0
  const pageCount = Math.max(1, Math.ceil(total / paging.pageSize) || 1)
  const page = Math.min(paging.page, pageCount)
  const offset = (page - 1) * paging.pageSize
  const selectSql = includeContent
    ? LIST_SELECT.replace('posts.updated_at, posts.deleted_at', 'posts.updated_at, posts.deleted_at, posts.content')
    : LIST_SELECT
  const rows = db.prepare(`
    ${selectSql}
    WHERE ${whereSql}
    ${orderSql}
    LIMIT ? OFFSET ?
  `).all(...queryParams, ...orderParams, paging.pageSize, offset)
  return { rows, total, page, pageSize: paging.pageSize }
}

function searchClauses(q) {
  const like = `%${q.replace(/[%_]/g, '')}%`
  const ftsQuery = q
    .replace(/['"]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term}"*`)
    .join(' AND ')
  const keywordTitle = `(
    EXISTS (
      SELECT 1 FROM post_keywords pk
      WHERE pk.post_id = posts.id AND pk.keyword LIKE ?
    )
    OR posts.title LIKE ?
  )`
  const withFts = ftsQuery
    ? `(
        EXISTS (
          SELECT 1 FROM post_keywords pk
          WHERE pk.post_id = posts.id AND pk.keyword LIKE ?
        )
        OR posts.id IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)
        OR posts.title LIKE ?
      )`
    : keywordTitle
  const ftsParams = ftsQuery ? [like, ftsQuery, like] : [like, like]
  const fallbackParams = [like, like]
  const orderSql = `
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
      posts.created_at DESC, posts.id DESC
  `
  return {
    like,
    withFts,
    ftsParams,
    keywordTitle,
    fallbackParams,
    orderSql,
    orderParams: [q, like, like]
  }
}

router.get('/', (req, res) => {
  const { sql, params } = visibilityFilter(req.user)
  const where = [sql]
  const queryParams = [...params]
  const paging = parsePaging(req.query)
  const includeContent = req.query.includeContent === '1'
    || req.query.includeContent === 'true'
    || req.query.includeContent === true
  const fromSql = `
    FROM posts
    JOIN users ON users.id = posts.author_id
    LEFT JOIN categories ON categories.id = posts.category_id
  `

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

  const keyword = String(req.query.keyword || '').trim()
  if (keyword) {
    where.push(`EXISTS (
      SELECT 1 FROM post_keywords pk
      WHERE pk.post_id = posts.id AND lower(pk.keyword) = lower(?)
    )`)
    queryParams.push(keyword)
  }

  const q = String(req.query.q || '').trim()
  let orderSql = 'ORDER BY posts.created_at DESC, posts.id DESC'
  let orderParams = []
  const baseWhere = [...where]
  const baseParams = [...queryParams]
  let search = null
  if (q) {
    search = searchClauses(q)
    where.push(search.withFts)
    queryParams.push(...search.ftsParams)
    orderSql = search.orderSql
    orderParams = search.orderParams
  }

  const whereSql = where.join(' AND ')
  let result
  try {
    result = listFromSql(fromSql, whereSql, queryParams, orderSql, orderParams, paging, { includeContent })
  } catch (err) {
    if (!search) throw err
    const fallbackWhere = [...baseWhere, search.keywordTitle]
    result = listFromSql(
      fromSql,
      fallbackWhere.join(' AND '),
      [...baseParams, ...search.fallbackParams],
      search.orderSql,
      search.orderParams,
      paging,
      { includeContent }
    )
  }

  res.json({
    posts: withKeywords(result.rows, { includeContent }),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize
  })
})

router.get('/keywords', (req, res) => {
  const { sql, params } = visibilityFilter(req.user)
  const q = String(req.query.q || '').trim().replace(/[%_]/g, '')
  const where = ['posts.deleted_at IS NULL', sql]
  const queryParams = [...params]
  if (q) {
    where.push('pk.keyword LIKE ?')
    queryParams.push(`%${q}%`)
  }
  const rows = db.prepare(`
    SELECT pk.keyword, COUNT(*) AS count
    FROM post_keywords pk
    JOIN posts ON posts.id = pk.post_id
    WHERE ${where.join(' AND ')}
    GROUP BY lower(pk.keyword)
    ORDER BY count DESC, pk.keyword COLLATE NOCASE ASC
    LIMIT 500
  `).all(...queryParams)
  res.json({
    keywords: rows.map((row) => ({
      name: row.keyword,
      count: Number(row.count) || 0
    }))
  })
})

router.get('/homepage', (req, res) => {
  const ids = getHomePostIds()
  if (!ids.length) {
    return res.json({ posts: [] })
  }
  const rows = db.prepare(`
    ${LIST_SELECT.replace('posts.updated_at, posts.deleted_at', 'posts.updated_at, posts.deleted_at, posts.content')}
    WHERE posts.id IN (${ids.map(() => '?').join(',')})
  `).all(...ids)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean).filter((row) => canReadPost(row, req.user))
  res.json({ posts: withKeywords(ordered, { includeContent: true }) })
})

router.put('/homepage/order', requireWriter, (req, res) => {
  try {
    const ids = setHomepageOrder(req.body?.postIds || req.body?.homePostIds || [])
    res.json({ homePostIds: ids, hasHomepage: ids.length > 0 })
  } catch (err) {
    sendError(res, err, 'HOMEPAGE_ORDER_INVALID', 400)
  }
})

router.get('/trash', requireWriter, (req, res) => {
  const rows = db.prepare(`
    ${LIST_SELECT}
    WHERE posts.deleted_at IS NOT NULL
    ORDER BY posts.deleted_at DESC, posts.id DESC
  `).all()
  res.json({ posts: withKeywords(rows) })
})

router.delete('/trash', requireWriter, (req, res) => {
  const rows = db.prepare(`
    SELECT id, content FROM posts WHERE deleted_at IS NOT NULL
  `).all()
  let pendingUnlink = []
  db.transaction(() => {
    for (const row of rows) {
      pendingUnlink.push(...deletePostUploadFiles(db, row))
      db.prepare('DELETE FROM posts WHERE id = ?').run(row.id)
    }
  })()
  unlinkStoredNames([...new Set(pendingUnlink)])
  res.json({ ok: true, deleted: rows.length })
})

router.post('/:id/restore', requireWriter, (req, res) => {
  const existing = statements().getPost.get(req.params.id)
  if (!existing || !existing.deleted_at) {
    return res.status(404).json({ error: 'POST_NOT_IN_TRASH' })
  }
  db.prepare("UPDATE posts SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?").run(existing.id)
  const row = db.prepare(`
    ${LIST_SELECT.replace('posts.updated_at, posts.deleted_at', 'posts.updated_at, posts.deleted_at, posts.content')}
    WHERE posts.id = ?
  `).get(existing.id)
  res.json({ post: withKeywords([row], { includeContent: true })[0] })
})

router.delete('/:id/permanent', requireWriter, (req, res) => {
  const existing = statements().getPost.get(req.params.id)
  if (!existing || !existing.deleted_at) {
    return res.status(404).json({ error: 'POST_NOT_IN_TRASH' })
  }
  let pendingUnlink = []
  db.transaction(() => {
    pendingUnlink = deletePostUploadFiles(db, existing)
    db.prepare('DELETE FROM posts WHERE id = ?').run(existing.id)
  })()
  unlinkStoredNames(pendingUnlink)
  res.json({ ok: true })
})

router.get('/:id/files/:name', (req, res) => {
  const storedName = path.basename(req.params.name)
  if (!canAccessStoredFile(storedName, req.user, { postId: Number(req.params.id) })) {
    return res.status(404).json({ error: 'FILE_NOT_FOUND' })
  }
  const filePath = resolveUploadPath(storedName)
  if (!filePath) {
    return res.status(404).json({ error: 'FILE_NOT_FOUND' })
  }
  sendUploadFile(res, filePath)
})

router.get('/:id', (req, res) => {
  const row = db.prepare(`
    ${LIST_SELECT.replace('posts.updated_at, posts.deleted_at', 'posts.updated_at, posts.deleted_at, posts.content')}
    WHERE posts.id = ?
  `).get(req.params.id)

  if (!canReadPost(row, req.user)) {
    return res.status(404).json({ error: 'POST_NOT_FOUND' })
  }

  res.json({ post: withKeywords([row], { includeContent: true })[0] })
})

router.get('/:id/attachments/:attachmentId', (req, res) => {
  const post = statements().getPost.get(req.params.id)
  if (!canReadPost(post, req.user)) {
    return res.status(404).json({ error: 'FILE_NOT_FOUND' })
  }
  const row = db.prepare(`
    SELECT * FROM post_attachments WHERE id = ? AND post_id = ?
  `).get(req.params.attachmentId, req.params.id)
  if (!row) {
    return res.status(404).json({ error: 'FILE_NOT_FOUND' })
  }
  const filePath = path.join(uploadsDir, path.basename(row.stored_name))
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'FILE_NOT_FOUND' })
  }
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.download(filePath, row.original_name)
})

router.post('/', requireWriter, (req, res) => {
  const title = String(req.body?.title || '').trim()
  const visibility = req.body?.visibility === 'private' ? 'private' : 'public'
  const status = req.body?.status === 'published' ? 'published' : 'draft'
  const editorType = normalizeEditorType(req.body?.editorType)
  const rawContent = req.body?.content == null ? emptyEditorContent(editorType) : String(req.body.content)
  let categoryId = req.body?.categoryId ?? req.body?.category_id ?? null
  if (categoryId === '' || categoryId === 0) categoryId = null

  if (categoryId != null) {
    const category = statements().getCategory.get(categoryId)
    if (!category) {
      return res.status(400).json({ error: 'CATEGORY_NOT_FOUND' })
    }
  }

  const keywords = normalizeKeywords(req.body?.keywords)
  const attachments = normalizeAttachments(req.body?.attachments)
  const slug = slugify(title)
  let pendingUnlink = []
  const result = db.transaction(() => {
    const content = sanitizePostContent(editorType, rawContent)
    const inserted = db.prepare(`
      INSERT INTO posts (title, slug, category_id, author_id, visibility, status, editor_type, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(title, slug, categoryId, req.user.id, visibility, status, editorType, content)
    const postId = inserted.lastInsertRowid
    const rewritten = rewriteContentFileUrls(content, postId)
    if (rewritten !== content) {
      db.prepare('UPDATE posts SET content = ? WHERE id = ?').run(rewritten, postId)
    }
    replacePostKeywords(db, postId, keywords)
    pendingUnlink = replacePostAttachments(db, postId, attachments)
    const homepage = parseHomepageFlag(req.body)
    if (homepage != null) applyHomepageFlag(postId, homepage, parseHomepageSort(req.body))
    return postId
  })()
  unlinkStoredNames(pendingUnlink)

  const row = db.prepare(`
    ${LIST_SELECT.replace('posts.updated_at, posts.deleted_at', 'posts.updated_at, posts.deleted_at, posts.content')}
    WHERE posts.id = ?
  `).get(result)

  res.status(201).json({ post: withKeywords([row], { includeContent: true })[0] })
})

router.patch('/:id', requireWriter, (req, res) => {
  const existing = statements().getPost.get(req.params.id)
  if (!existing || existing.deleted_at) {
    return res.status(404).json({ error: 'POST_NOT_FOUND' })
  }

  const title = req.body?.title != null ? String(req.body.title).trim() : existing.title

  let categoryId = existing.category_id
  if ('categoryId' in (req.body || {}) || 'category_id' in (req.body || {})) {
    categoryId = req.body.categoryId ?? req.body.category_id ?? null
    if (categoryId === '' || categoryId === 0) categoryId = null
  }
  if (categoryId != null) {
    const category = statements().getCategory.get(categoryId)
    if (!category) {
      return res.status(400).json({ error: 'CATEGORY_NOT_FOUND' })
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
  const content = req.body?.content != null
    ? prepareContent(editorType, req.body.content, existing.id)
    : rewriteContentFileUrls(existing.content, existing.id)
  const slug = title !== existing.title ? slugify(title) : existing.slug
  const keywords = 'keywords' in (req.body || {})
    ? normalizeKeywords(req.body.keywords)
    : null
  const attachments = 'attachments' in (req.body || {})
    ? normalizeAttachments(req.body.attachments)
    : null

  let pendingUnlink = []
  db.transaction(() => {
    db.prepare(`
      UPDATE posts
      SET title = ?, slug = ?, category_id = ?, visibility = ?, status = ?, editor_type = ?, content = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(title, slug, categoryId, visibility, status, editorType, content, existing.id)
    if (keywords) replacePostKeywords(db, existing.id, keywords)
    if (attachments) pendingUnlink = replacePostAttachments(db, existing.id, attachments)
    else syncUploadRefs(db, existing.id)
    const homepage = parseHomepageFlag(req.body)
    if (homepage != null) applyHomepageFlag(existing.id, homepage, parseHomepageSort(req.body))
    else if ('homepageSort' in (req.body || {})) {
      const sort = getHomepageSortMap().get(existing.id)
      if (sort != null) applyHomepageFlag(existing.id, true, parseHomepageSort(req.body))
    }
  })()
  unlinkStoredNames(pendingUnlink)

  const row = db.prepare(`
    ${LIST_SELECT.replace('posts.updated_at, posts.deleted_at', 'posts.updated_at, posts.deleted_at, posts.content')}
    WHERE posts.id = ?
  `).get(existing.id)

  res.json({ post: withKeywords([row], { includeContent: true })[0] })
})

router.delete('/:id', requireWriter, (req, res) => {
  const existing = statements().getPost.get(req.params.id)
  if (!existing || existing.deleted_at) {
    return res.status(404).json({ error: 'POST_NOT_FOUND' })
  }
  db.transaction(() => {
    db.prepare("UPDATE posts SET deleted_at = datetime('now') WHERE id = ?").run(existing.id)
    removeHomepagePost(existing.id)
  })()
  res.json({ ok: true, trashed: true })
})

export default router
