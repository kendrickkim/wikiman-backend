import { Router } from 'express'
import { db } from '../db.js'
import { requireWriter } from '../middleware/auth.js'

const router = Router()

function normalizeVisibility(value, fallback = 'public') {
  return value === 'private' ? 'private' : (fallback === 'private' ? 'private' : 'public')
}

function mapCategory(row) {
  return {
    id: row.id,
    name: row.name,
    parent_id: row.parent_id,
    sort_order: row.sort_order,
    visibility: normalizeVisibility(row.visibility),
    created_by: row.created_by,
    created_at: row.created_at
  }
}

function listCategories() {
  return db.prepare(`
    SELECT id, name, parent_id, sort_order, visibility, created_by, created_at
    FROM categories
    ORDER BY sort_order ASC, name ASC
  `).all().map(mapCategory)
}

function categoryRows(database = db) {
  return database.prepare('SELECT id, parent_id, visibility FROM categories').all()
}

/** 카테고리 또는 상위 중 하나라도 비공개면 로그인 필요 */
export function categoryRequiresLogin(categoryId, database = db) {
  if (categoryId == null || categoryId === '') return false
  let id = Number(categoryId)
  if (!Number.isFinite(id) || id <= 0) return false
  const byId = new Map(categoryRows(database).map((row) => [row.id, row]))
  const seen = new Set()
  while (id && !seen.has(id)) {
    seen.add(id)
    const row = byId.get(id)
    if (!row) return false
    if (row.visibility === 'private') return true
    id = row.parent_id
  }
  return false
}

export function loginRequiredCategoryIds(database = db) {
  const all = categoryRows(database)
  const byId = new Map(all.map((row) => [row.id, row]))
  const cache = new Map()
  const requires = (id) => {
    if (cache.has(id)) return cache.get(id)
    let cur = id
    const chain = []
    while (cur) {
      if (cache.has(cur)) {
        const value = cache.get(cur)
        for (const item of chain) cache.set(item, value)
        return value
      }
      chain.push(cur)
      const row = byId.get(cur)
      if (!row) {
        for (const item of chain) cache.set(item, false)
        return false
      }
      if (row.visibility === 'private') {
        for (const item of chain) cache.set(item, true)
        return true
      }
      cur = row.parent_id
    }
    for (const item of chain) cache.set(item, false)
    return false
  }
  return all.filter((row) => requires(row.id)).map((row) => row.id)
}

function parseParentId(value) {
  if (value == null || value === '' || value === 0 || value === '0') return null
  const id = Number(value)
  return Number.isFinite(id) && id > 0 ? id : null
}

function wouldCreateCycle(id, newParentId) {
  if (!newParentId) return false
  if (Number(newParentId) === Number(id)) return true
  const byId = new Map(categoryRows().map((row) => [row.id, row]))
  let current = byId.get(Number(newParentId))
  const seen = new Set([Number(id)])
  while (current) {
    if (seen.has(current.parent_id)) return true
    if (current.parent_id == null) return false
    seen.add(current.parent_id)
    current = byId.get(current.parent_id)
  }
  return false
}

router.get('/', (req, res) => {
  let categories = listCategories()
  if (!req.user) {
    const hidden = new Set(loginRequiredCategoryIds())
    categories = categories.filter((category) => !hidden.has(category.id))
  }
  res.json({ categories })
})

router.post('/', requireWriter, (req, res) => {
  const name = String(req.body?.name || '').trim()
  const parentId = parseParentId(req.body?.parentId ?? req.body?.parent_id)
  const visibility = normalizeVisibility(req.body?.visibility)
  if (!name) {
    return res.status(400).json({ error: 'CATEGORY_NAME_REQUIRED' })
  }

  if (parentId != null) {
    const parent = db.prepare('SELECT id FROM categories WHERE id = ?').get(parentId)
    if (!parent) {
      return res.status(400).json({ error: 'PARENT_CATEGORY_NOT_FOUND' })
    }
  }

  const maxOrder = db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM categories WHERE parent_id IS ?'
  ).get(parentId ?? null)

  const result = db.prepare(`
    INSERT INTO categories (name, parent_id, sort_order, visibility, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, parentId ?? null, maxOrder.max_order + 1, visibility, req.user.id)

  const category = mapCategory(db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid))
  res.status(201).json({ category })
})

router.patch('/:id', requireWriter, (req, res) => {
  const id = Number(req.params.id)
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(id)
  if (!existing) {
    return res.status(404).json({ error: 'CATEGORY_NOT_FOUND' })
  }

  const name = req.body?.name != null ? String(req.body.name).trim() : existing.name
  if (!name) {
    return res.status(400).json({ error: 'CATEGORY_NAME_REQUIRED' })
  }

  let parentId = existing.parent_id
  if ('parentId' in (req.body || {}) || 'parent_id' in (req.body || {})) {
    parentId = parseParentId(req.body.parentId ?? req.body.parent_id)
  }

  if (parentId != null) {
    const parent = db.prepare('SELECT id FROM categories WHERE id = ?').get(parentId)
    if (!parent) {
      return res.status(400).json({ error: 'PARENT_CATEGORY_NOT_FOUND' })
    }
    if (wouldCreateCycle(id, parentId)) {
      return res.status(400).json({ error: 'CATEGORY_MOVE_INTO_SELF' })
    }
  }

  const parentChanged = (existing.parent_id ?? null) !== (parentId ?? null)
  let sortOrder = req.body?.sortOrder ?? req.body?.sort_order ?? existing.sort_order
  if (parentChanged && req.body?.sortOrder == null && req.body?.sort_order == null) {
    const maxOrder = db.prepare(
      'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM categories WHERE parent_id IS ?'
    ).get(parentId ?? null)
    sortOrder = maxOrder.max_order + 1
  }
  const visibility = 'visibility' in (req.body || {})
    ? normalizeVisibility(req.body.visibility)
    : normalizeVisibility(existing.visibility)

  db.prepare(`
    UPDATE categories
    SET name = ?, parent_id = ?, sort_order = ?, visibility = ?
    WHERE id = ?
  `).run(name, parentId, sortOrder, visibility, id)

  const category = mapCategory(db.prepare('SELECT * FROM categories WHERE id = ?').get(id))
  res.json({ category })
})

function descendantCategoryIds(categoryId) {
  const rows = categoryRows()
  const children = new Map()
  for (const row of rows) {
    const key = row.parent_id ?? 0
    if (!children.has(key)) children.set(key, [])
    children.get(key).push(row.id)
  }
  const ids = []
  const stack = [Number(categoryId)]
  const seen = new Set()
  while (stack.length) {
    const current = stack.pop()
    if (!Number.isFinite(current) || seen.has(current)) continue
    seen.add(current)
    ids.push(current)
    for (const child of children.get(current) || []) stack.push(child)
  }
  return ids
}

function parseTargetCategoryId(value) {
  if (value == null || value === '' || value === 0 || value === '0') return null
  const id = Number(value)
  return Number.isFinite(id) && id > 0 ? id : null
}

router.get('/:id/post-stats', requireWriter, (req, res) => {
  const id = Number(req.params.id)
  const existing = db.prepare('SELECT id FROM categories WHERE id = ?').get(id)
  if (!existing) {
    return res.status(404).json({ error: 'CATEGORY_NOT_FOUND' })
  }
  const direct = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM posts
    WHERE category_id = ? AND deleted_at IS NULL
  `).get(id)?.count || 0)
  const ids = descendantCategoryIds(id)
  const withDescendants = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM posts
    WHERE deleted_at IS NULL
      AND category_id IN (${ids.map(() => '?').join(',')})
  `).get(...ids)?.count || 0)
  res.json({ direct, withDescendants })
})

router.post('/:id/reassign-posts', requireWriter, (req, res) => {
  const id = Number(req.params.id)
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(id)
  if (!existing) {
    return res.status(404).json({ error: 'CATEGORY_NOT_FOUND' })
  }

  const targetCategoryId = parseTargetCategoryId(req.body?.targetCategoryId ?? req.body?.target_category_id)
  if (targetCategoryId != null) {
    const target = db.prepare('SELECT id FROM categories WHERE id = ?').get(targetCategoryId)
    if (!target) {
      return res.status(400).json({ error: 'CATEGORY_MOVE_TARGET_NOT_FOUND' })
    }
  }
  const includeDescendants = req.body?.includeDescendants === true
    || req.body?.include_descendants === true
  if (targetCategoryId === id && !includeDescendants) {
    return res.status(400).json({ error: 'CATEGORY_MOVE_SAME' })
  }

  const sourceIds = includeDescendants ? descendantCategoryIds(id) : [id]
  const placeholders = sourceIds.map(() => '?').join(',')
  const result = db.prepare(`
    UPDATE posts
    SET category_id = ?, updated_at = datetime('now')
    WHERE deleted_at IS NULL
      AND category_id IN (${placeholders})
  `).run(targetCategoryId, ...sourceIds)

  res.json({
    ok: true,
    moved: result.changes,
    includeDescendants,
    targetCategoryId
  })
})

router.delete('/:id', requireWriter, (req, res) => {
  const id = Number(req.params.id)
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(id)
  if (!existing) {
    return res.status(404).json({ error: 'CATEGORY_NOT_FOUND' })
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE categories SET parent_id = ? WHERE parent_id = ?')
      .run(existing.parent_id, id)
    db.prepare('UPDATE posts SET category_id = ? WHERE category_id = ?')
      .run(existing.parent_id, id)
    db.prepare('DELETE FROM categories WHERE id = ?').run(id)
  })
  tx()

  res.json({ ok: true })
})

export default router
