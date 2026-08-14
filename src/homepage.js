import { db } from './db.js'

export function getHomePostIds(database = db) {
  return database.prepare(`
    SELECT homepage_posts.post_id AS id
    FROM homepage_posts
    JOIN posts ON posts.id = homepage_posts.post_id
    WHERE posts.deleted_at IS NULL
    ORDER BY homepage_posts.sort_order ASC, homepage_posts.post_id ASC
  `).all().map((row) => row.id)
}

export function hasHomepagePosts(database = db) {
  return Boolean(database.prepare(`
    SELECT 1
    FROM homepage_posts
    JOIN posts ON posts.id = homepage_posts.post_id
    WHERE posts.deleted_at IS NULL
    LIMIT 1
  `).get())
}

export function getHomepageSortMap(database = db) {
  const map = new Map()
  for (const row of database.prepare('SELECT post_id, sort_order FROM homepage_posts').all()) {
    map.set(row.post_id, row.sort_order)
  }
  return map
}

export function removeHomepagePost(postId, database = db) {
  database.prepare('DELETE FROM homepage_posts WHERE post_id = ?').run(Number(postId))
}

function normalizeSortOrder(value) {
  if (value == null || value === '') return null
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(9999, n))
}

export function applyHomepageFlag(postId, isHomepage, sortOrder = null) {
  const id = Number(postId)
  if (!Number.isFinite(id) || id <= 0) return

  if (!isHomepage) {
    removeHomepagePost(id)
    return
  }

  const existing = db.prepare('SELECT sort_order FROM homepage_posts WHERE post_id = ?').get(id)
  const order = normalizeSortOrder(sortOrder)

  if (existing) {
    if (order != null) {
      db.prepare('UPDATE homepage_posts SET sort_order = ? WHERE post_id = ?').run(order, id)
    }
    return
  }

  const nextOrder = order != null
    ? order
    : (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM homepage_posts').get().m + 1)

  db.prepare('INSERT INTO homepage_posts (post_id, sort_order) VALUES (?, ?)').run(id, nextOrder)
}

/** postIds 배열 순서대로 sort_order를 다시 매깁니다. */
export function setHomepageOrder(postIds) {
  if (!Array.isArray(postIds)) {
    throw Object.assign(new Error('홈페이지 글 순서 형식이 올바르지 않습니다.'), { status: 400 })
  }
  const ids = []
  const seen = new Set()
  for (const raw of postIds) {
    const id = Number(raw)
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }

  if (ids.length) {
    const found = db.prepare(`
      SELECT id FROM posts
      WHERE deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})
    `).all(...ids)
    const foundSet = new Set(found.map((row) => row.id))
    for (const id of ids) {
      if (!foundSet.has(id)) {
        throw Object.assign(new Error(`홈페이지 글을 찾을 수 없습니다: ${id}`), { status: 400 })
      }
    }
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM homepage_posts').run()
    const insert = db.prepare('INSERT INTO homepage_posts (post_id, sort_order) VALUES (?, ?)')
    ids.forEach((id, index) => insert.run(id, index))
  })
  tx()
  return getHomePostIds()
}
