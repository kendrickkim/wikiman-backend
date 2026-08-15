import { db } from './db.js'
import { canReadPost } from './access.js'
import { apiError } from './errors.js'

const MAX_MENU_ITEMS = 20
const MAX_MENU_LABEL_LENGTH = 30
const MAX_MENU_URL_LENGTH = 500

function menuRows(database = db) {
  return database.prepare(`
    SELECT
      top_menu_items.id,
      top_menu_items.label,
      top_menu_items.post_id,
      top_menu_items.url,
      top_menu_items.sort_order,
      posts.title,
      posts.author_id,
      posts.category_id,
      posts.visibility,
      posts.status,
      posts.deleted_at
    FROM top_menu_items
    LEFT JOIN posts ON posts.id = top_menu_items.post_id
    ORDER BY top_menu_items.sort_order ASC, top_menu_items.id ASC
  `).all()
}

function mapMenuItem(row) {
  const postId = row.post_id == null ? null : Number(row.post_id)
  return {
    id: row.id,
    label: row.label,
    postId: Number.isInteger(postId) && postId > 0 ? postId : null,
    postTitle: row.title || '',
    url: row.url ? String(row.url) : ''
  }
}

function isReadableMenuRow(row, user, database) {
  if (row.post_id == null) {
    return Boolean(row.url)
  }
  return canReadPost(row, user, database)
}

export function normalizeTopMenuUrl(raw) {
  let url = String(raw ?? '').trim()
  if (!url) {
    throw apiError('URL_REQUIRED', 400)
  }
  if (url.length > MAX_MENU_URL_LENGTH) {
    throw apiError('URL_TOO_LONG', 400, { max: MAX_MENU_URL_LENGTH })
  }
  if (/\s/.test(url) || /[\u0000-\u001F\u007F]/.test(url)) {
    throw apiError('URL_WHITESPACE', 400)
  }

  if (url.startsWith('/')) {
    if (url.startsWith('//') || url.includes('\\')) {
      throw apiError('INTERNAL_PATH_INVALID', 400)
    }
    return url
  }

  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`
  }
  if (url.length > MAX_MENU_URL_LENGTH) {
    throw apiError('URL_TOO_LONG', 400, { max: MAX_MENU_URL_LENGTH })
  }

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw apiError('URL_INVALID', 400)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw apiError('EXTERNAL_URL_INVALID', 400)
  }
  return parsed.toString()
}

export function getTopMenuItems(user, database = db) {
  return menuRows(database)
    .filter((row) => isReadableMenuRow(row, user, database))
    .map(mapMenuItem)
}

export function getTopMenuEditorItems(database = db) {
  return menuRows(database).map(mapMenuItem)
}

export function getTopMenuPostOptions(database = db) {
  return database.prepare(`
    SELECT id, title, status, visibility
    FROM posts
    WHERE deleted_at IS NULL
    ORDER BY updated_at DESC, id DESC
  `).all().map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    visibility: row.visibility
  }))
}

export function replaceTopMenuItems(input, database = db) {
  if (!Array.isArray(input)) {
    throw apiError('TOP_MENU_NOT_ARRAY', 400)
  }
  if (input.length > MAX_MENU_ITEMS) {
    throw apiError('TOP_MENU_MAX_ITEMS', 400, { max: MAX_MENU_ITEMS })
  }

  const normalized = []
  const postIds = new Set()
  const urls = new Set()
  for (const item of input) {
    const label = String(item?.label ?? '').trim().replace(/\s+/g, ' ')
    if (!label || label.length > MAX_MENU_LABEL_LENGTH) {
      throw apiError('TOP_MENU_LABEL_LENGTH', 400, { max: MAX_MENU_LABEL_LENGTH })
    }

    const hasPost = item?.postId != null && item?.postId !== ''
    const hasUrl = item?.url != null && String(item.url).trim() !== ''
    if (hasPost && hasUrl) {
      throw apiError('TOP_MENU_POST_AND_URL', 400)
    }
    if (!hasPost && !hasUrl) {
      throw apiError('TOP_MENU_NEED_TARGET', 400)
    }

    if (hasPost) {
      const postId = Number(item.postId)
      if (!Number.isInteger(postId) || postId <= 0) {
        throw apiError('TOP_MENU_NEED_POST', 400)
      }
      if (postIds.has(postId)) {
        throw apiError('TOP_MENU_DUPLICATE_POST', 400)
      }
      const post = database.prepare('SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL').get(postId)
      if (!post) {
        throw apiError('TOP_MENU_POST_NOT_FOUND', 400)
      }
      postIds.add(postId)
      normalized.push({ label, postId, url: null })
      continue
    }

    const url = normalizeTopMenuUrl(item.url)
    if (urls.has(url)) {
      throw apiError('TOP_MENU_DUPLICATE_URL', 400)
    }
    urls.add(url)
    normalized.push({ label, postId: null, url })
  }

  const insert = database.prepare(`
    INSERT INTO top_menu_items (label, post_id, url, sort_order)
    VALUES (?, ?, ?, ?)
  `)
  database.transaction(() => {
    database.prepare('DELETE FROM top_menu_items').run()
    normalized.forEach((item, index) => {
      insert.run(item.label, item.postId, item.url, index)
    })
  })()

  return getTopMenuEditorItems(database)
}
