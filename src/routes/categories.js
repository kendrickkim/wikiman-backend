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

/** 카테고리 또는 상위 중 하나라도 비공개면 로그인 필요 */
export function categoryRequiresLogin(categoryId, database = db) {
  if (categoryId == null || categoryId === '') return false
  let id = Number(categoryId)
  if (!Number.isFinite(id) || id <= 0) return false
  while (id) {
    const row = database.prepare('SELECT parent_id, visibility FROM categories WHERE id = ?').get(id)
    if (!row) return false
    if (row.visibility === 'private') return true
    id = row.parent_id
  }
  return false
}

export function loginRequiredCategoryIds(database = db) {
  const all = database.prepare('SELECT id, parent_id, visibility FROM categories').all()
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

function wouldCreateCycle(id, newParentId) {
  if (!newParentId) return false
  if (Number(newParentId) === Number(id)) return true
  let current = db.prepare('SELECT parent_id FROM categories WHERE id = ?').get(newParentId)
  const seen = new Set([Number(id)])
  while (current) {
    if (seen.has(current.parent_id)) return true
    if (current.parent_id == null) return false
    seen.add(current.parent_id)
    current = db.prepare('SELECT parent_id FROM categories WHERE id = ?').get(current.parent_id)
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
  const parentId = req.body?.parentId ?? req.body?.parent_id ?? null
  const visibility = normalizeVisibility(req.body?.visibility)
  if (!name) {
    return res.status(400).json({ error: '카테고리 이름을 입력하세요.' })
  }

  if (parentId != null) {
    const parent = db.prepare('SELECT id FROM categories WHERE id = ?').get(parentId)
    if (!parent) {
      return res.status(400).json({ error: '상위 카테고리를 찾을 수 없습니다.' })
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
    return res.status(404).json({ error: '카테고리를 찾을 수 없습니다.' })
  }

  const name = req.body?.name != null ? String(req.body.name).trim() : existing.name
  if (!name) {
    return res.status(400).json({ error: '카테고리 이름을 입력하세요.' })
  }

  let parentId = existing.parent_id
  if ('parentId' in (req.body || {}) || 'parent_id' in (req.body || {})) {
    parentId = req.body.parentId ?? req.body.parent_id ?? null
  }

  if (parentId != null) {
    const parent = db.prepare('SELECT id FROM categories WHERE id = ?').get(parentId)
    if (!parent) {
      return res.status(400).json({ error: '상위 카테고리를 찾을 수 없습니다.' })
    }
    if (wouldCreateCycle(id, parentId)) {
      return res.status(400).json({ error: '자기 자신 또는 하위 카테고리로는 이동할 수 없습니다.' })
    }
  }

  const sortOrder = req.body?.sortOrder ?? req.body?.sort_order ?? existing.sort_order
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

router.delete('/:id', requireWriter, (req, res) => {
  const id = Number(req.params.id)
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(id)
  if (!existing) {
    return res.status(404).json({ error: '카테고리를 찾을 수 없습니다.' })
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
