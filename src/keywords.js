const MAX_KEYWORDS = 20
const MAX_KEYWORD_LENGTH = 40

export function normalizeKeywords(input) {
  const list = Array.isArray(input)
    ? input
    : String(input || '').split(/[,，]/)
  const seen = new Set()
  const keywords = []
  for (const raw of list) {
    const keyword = String(raw ?? '').trim().replace(/\s+/g, ' ')
    if (!keyword || keyword.length > MAX_KEYWORD_LENGTH) continue
    const key = keyword.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    keywords.push(keyword)
    if (keywords.length >= MAX_KEYWORDS) break
  }
  return keywords
}

export function replacePostKeywords(db, postId, keywords) {
  db.prepare('DELETE FROM post_keywords WHERE post_id = ?').run(postId)
  const insert = db.prepare(
    'INSERT INTO post_keywords (post_id, keyword, sort_order) VALUES (?, ?, ?)'
  )
  keywords.forEach((keyword, index) => {
    insert.run(postId, keyword, index)
  })
}

export function keywordsByPostIds(db, postIds) {
  const map = new Map()
  if (!postIds.length) return map
  const rows = db.prepare(`
    SELECT post_id, keyword
    FROM post_keywords
    WHERE post_id IN (${postIds.map(() => '?').join(',')})
    ORDER BY sort_order ASC, keyword COLLATE NOCASE ASC
  `).all(...postIds)
  for (const row of rows) {
    if (!map.has(row.post_id)) map.set(row.post_id, [])
    map.get(row.post_id).push(row.keyword)
  }
  return map
}
