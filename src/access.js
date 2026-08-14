import { db } from './db.js'
import { categoryRequiresLogin, loginRequiredCategoryIds } from './routes/categories.js'

export function visibilityFilter(user, database = db) {
  if (user) {
    return {
      sql: `posts.deleted_at IS NULL AND ((posts.status = 'published' AND (posts.visibility = 'public' OR posts.author_id = ?)) OR (posts.status = 'draft' AND posts.author_id = ?))`,
      params: [user.id, user.id]
    }
  }

  const privateCats = loginRequiredCategoryIds(database)
  if (!privateCats.length) {
    return {
      sql: "posts.deleted_at IS NULL AND posts.status = 'published' AND posts.visibility = 'public'",
      params: []
    }
  }
  return {
    sql: `posts.deleted_at IS NULL AND posts.status = 'published' AND posts.visibility = 'public'
      AND (posts.category_id IS NULL OR posts.category_id NOT IN (${privateCats.map(() => '?').join(',')}))`,
    params: [...privateCats]
  }
}

export function canReadPost(row, user, database = db) {
  if (!row || row.deleted_at) return false
  const isOwner = user?.id === row.author_id
  if (row.status === 'draft' && !isOwner) return false
  if (row.visibility === 'private' && !isOwner) return false
  if (!user && categoryRequiresLogin(row.category_id, database)) return false
  return true
}
