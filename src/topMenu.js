import { db } from './db.js'
import { canReadPost } from './access.js'

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
  const url = String(raw ?? '').trim()
  if (!url) {
    throw Object.assign(new Error('URL을 입력하세요.'), { status: 400 })
  }
  if (url.length > MAX_MENU_URL_LENGTH) {
    throw Object.assign(
      new Error(`URL은 ${MAX_MENU_URL_LENGTH}자 이하여야 합니다.`),
      { status: 400 }
    )
  }
  if (/\s/.test(url) || /[\u0000-\u001F\u007F]/.test(url)) {
    throw Object.assign(new Error('URL에 공백이나 제어 문자를 넣을 수 없습니다.'), { status: 400 })
  }

  if (url.startsWith('/')) {
    if (url.startsWith('//') || url.includes('\\')) {
      throw Object.assign(new Error('내부 경로는 /로 시작하는 사이트 경로만 사용할 수 있습니다.'), { status: 400 })
    }
    return url
  }

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw Object.assign(
      new Error('URL은 http(s):// 주소이거나 /로 시작하는 경로여야 합니다.'),
      { status: 400 }
    )
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw Object.assign(new Error('외부 URL은 http 또는 https만 사용할 수 있습니다.'), { status: 400 })
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
    throw Object.assign(new Error('상단 메뉴 항목은 배열이어야 합니다.'), { status: 400 })
  }
  if (input.length > MAX_MENU_ITEMS) {
    throw Object.assign(new Error(`상단 메뉴는 최대 ${MAX_MENU_ITEMS}개까지 추가할 수 있습니다.`), { status: 400 })
  }

  const normalized = []
  const postIds = new Set()
  const urls = new Set()
  for (const item of input) {
    const label = String(item?.label ?? '').trim().replace(/\s+/g, ' ')
    if (!label || label.length > MAX_MENU_LABEL_LENGTH) {
      throw Object.assign(
        new Error(`메뉴명은 1~${MAX_MENU_LABEL_LENGTH}자로 입력하세요.`),
        { status: 400 }
      )
    }

    const hasPost = item?.postId != null && item?.postId !== ''
    const hasUrl = item?.url != null && String(item.url).trim() !== ''
    if (hasPost && hasUrl) {
      throw Object.assign(new Error('글과 URL은 동시에 지정할 수 없습니다.'), { status: 400 })
    }
    if (!hasPost && !hasUrl) {
      throw Object.assign(new Error('연결할 글을 선택하거나 URL을 입력하세요.'), { status: 400 })
    }

    if (hasPost) {
      const postId = Number(item.postId)
      if (!Number.isInteger(postId) || postId <= 0) {
        throw Object.assign(new Error('연결할 글을 선택하세요.'), { status: 400 })
      }
      if (postIds.has(postId)) {
        throw Object.assign(new Error('같은 글은 상단 메뉴에 한 번만 연결할 수 있습니다.'), { status: 400 })
      }
      const post = database.prepare('SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL').get(postId)
      if (!post) {
        throw Object.assign(new Error('연결할 글을 찾을 수 없습니다.'), { status: 400 })
      }
      postIds.add(postId)
      normalized.push({ label, postId, url: null })
      continue
    }

    const url = normalizeTopMenuUrl(item.url)
    if (urls.has(url)) {
      throw Object.assign(new Error('같은 URL은 상단 메뉴에 한 번만 추가할 수 있습니다.'), { status: 400 })
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
