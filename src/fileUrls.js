import path from 'node:path'

/** Markdown URL의 닫는 괄호는 파일명에 포함하지 않습니다. */
export const FILE_URL_RE = /\/api\/(?:posts\/\d+\/files|files)\/([^/?#"'\s<>\\)]+)/g
export const LEGACY_FILE_URL_RE = /\/api\/files\/([^/?#"'\s<>\\)]+)/g

export function storedNameFromMatch(raw) {
  let value = String(raw || '')
  try {
    value = decodeURIComponent(value)
  } catch {
    // keep raw
  }
  const storedName = path.basename(value)
  if (!storedName || storedName.includes('..')) return ''
  return storedName
}

export function extractStoredNamesFromContent(content) {
  const names = new Set()
  const text = String(content || '')
  FILE_URL_RE.lastIndex = 0
  let match
  while ((match = FILE_URL_RE.exec(text))) {
    const storedName = storedNameFromMatch(match[1])
    if (storedName) names.add(storedName)
  }
  return names
}

export function rewriteContentFileUrls(content, postId) {
  const id = Number(postId)
  if (!Number.isFinite(id) || id <= 0) return String(content || '')
  return String(content || '').replace(LEGACY_FILE_URL_RE, `/api/posts/${id}/files/$1`)
}

export function fileUrlForPost(postId, storedName) {
  const name = path.basename(String(storedName || ''))
  const id = Number(postId)
  if (Number.isFinite(id) && id > 0 && name) {
    return `/api/posts/${id}/files/${name}`
  }
  return name ? `/api/files/${name}` : ''
}
