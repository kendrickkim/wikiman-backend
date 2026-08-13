import { Router } from 'express'
import { db } from '../db.js'
import { requireWriter } from '../middleware/auth.js'

const router = Router()

function listCategories() {
  return db.prepare(`
    SELECT id, name, parent_id, sort_order, created_by, created_at
    FROM categories
    ORDER BY sort_order ASC, name ASC
  `).all()
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

router.get('/', (_req, res) => {
  res.json({ categories: listCategories() })
})

router.post('/', requireWriter, (req, res) => {
  const name = String(req.body?.name || '').trim()
  const parentId = req.body?.parentId ?? req.body?.parent_id ?? null
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
    INSERT INTO categories (name, parent_id, sort_order, created_by)
    VALUES (?, ?, ?, ?)
  `).run(name, parentId ?? null, maxOrder.max_order + 1, req.user.id)

  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid)
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

  db.prepare(`
    UPDATE categories
    SET name = ?, parent_id = ?, sort_order = ?
    WHERE id = ?
  `).run(name, parentId, sortOrder, id)

  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(id)
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
