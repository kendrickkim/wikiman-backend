import { db } from './db.js'
import { canReadPost } from './access.js'
import { getSettings } from './settings.js'

const DEFAULT_DESCRIPTION = '개인 위키'
const DEFAULT_ICON = '/icons/apple-touch-icon.png'

function absoluteUrl(origin, value) {
  const raw = String(value || '').trim()
  if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return ''
  try {
    return new URL(raw, origin).toString()
  } catch {
    return ''
  }
}

function decodeBasicEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
}

export function postDescription(content, maxLength = 200) {
  const text = decodeBasicEntities(String(content || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s]+/g, ' ')
    .replace(/[#>*_~`|[\]()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim())
  if (!text) return DEFAULT_DESCRIPTION
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text
}

function htmlImage(content) {
  const match = String(content || '').match(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i)
  return match?.[1] || match?.[2] || match?.[3] || ''
}

function markdownImage(content) {
  const match = String(content || '').match(/!\[[^\]]*]\(\s*(?:<([^>]+)>|([^\s)]+))/)
  return match?.[1] || match?.[2] || ''
}

function editorJsImage(content) {
  try {
    const blocks = JSON.parse(String(content || '{"blocks":[]}')).blocks || []
    const block = blocks.find((item) => item?.type === 'image' && item?.data?.file?.url)
    return block?.data?.file?.url || ''
  } catch {
    return ''
  }
}

function firstAttachmentImage(postId) {
  const row = db.prepare(`
    SELECT stored_name
    FROM post_attachments
    WHERE post_id = ? AND mime_type LIKE 'image/%'
    ORDER BY sort_order ASC, id ASC
    LIMIT 1
  `).get(postId)
  return row?.stored_name ? `/api/posts/${postId}/files/${row.stored_name}` : ''
}

export function firstPostImage(post, origin) {
  let image = ''
  if (post?.editor_type === 'editorjs') image = editorJsImage(post.content)
  if (!image) image = htmlImage(post?.content)
  if (!image && (post?.editor_type === 'markdown' || post?.editor_type === 'tui')) {
    image = markdownImage(post.content)
  }
  if (!image && post?.id) image = firstAttachmentImage(post.id)
  return absoluteUrl(origin, image || DEFAULT_ICON)
}

function siteMeta(origin, canonicalUrl) {
  const settings = getSettings()
  const siteTitle = settings.siteTitle || 'Wikiman'
  return {
    title: siteTitle,
    description: DEFAULT_DESCRIPTION,
    image: absoluteUrl(origin, DEFAULT_ICON),
    url: canonicalUrl,
    type: 'website',
    siteName: siteTitle
  }
}

export function socialMetaForPath(pathname, origin) {
  const canonicalUrl = absoluteUrl(origin, pathname || '/')
  const fallback = siteMeta(origin, canonicalUrl)
  const match = String(pathname || '').match(/^\/posts\/(\d+)\/?$/)
  if (!match) return fallback

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(match[1]))
  if (!canReadPost(post, null)) return fallback

  const title = String(post.title || '').trim() || fallback.siteName
  return {
    ...fallback,
    title,
    description: postDescription(post.content),
    image: firstPostImage(post, origin),
    type: 'article',
    publishedTime: post.created_at,
    modifiedTime: post.updated_at
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function metaTag(attribute, key, value) {
  if (!value) return ''
  return `<meta ${attribute}="${escapeHtml(key)}" content="${escapeHtml(value)}">`
}

export function renderSocialMeta(meta) {
  const tags = [
    `<title>${escapeHtml(meta.title)}</title>`,
    metaTag('name', 'description', meta.description),
    metaTag('property', 'og:title', meta.title),
    metaTag('property', 'og:description', meta.description),
    metaTag('property', 'og:type', meta.type),
    metaTag('property', 'og:url', meta.url),
    metaTag('property', 'og:image', meta.image),
    metaTag('property', 'og:site_name', meta.siteName),
    metaTag('name', 'twitter:card', 'summary_large_image'),
    metaTag('name', 'twitter:title', meta.title),
    metaTag('name', 'twitter:description', meta.description),
    metaTag('name', 'twitter:image', meta.image),
    metaTag('property', 'article:published_time', meta.publishedTime),
    metaTag('property', 'article:modified_time', meta.modifiedTime),
    `<link rel="canonical" href="${escapeHtml(meta.url)}">`
  ].filter(Boolean)
  return `<!-- wikiman:meta:start -->\n    ${tags.join('\n    ')}\n    <!-- wikiman:meta:end -->`
}

// 빌드가 HTML을 최소화하면 주석이 사라지고 속성 따옴표도 빠지므로 두 형태를 모두 지웁니다.
const STALE_META_PATTERNS = [
  /<title\b[^>]*>[\s\S]*?<\/title>/gi,
  /<meta\b[^>]*\bname\s*=\s*(?:"description"|'description'|description(?=[\s/>]))[^>]*>/gi,
  /<meta\b[^>]*\b(?:property|name)\s*=\s*(?:"(?:og|twitter|article):[^"]*"|'(?:og|twitter|article):[^']*'|(?:og|twitter|article):[^\s/>]*)[^>]*>/gi,
  /<link\b[^>]*\brel\s*=\s*(?:"canonical"|'canonical'|canonical(?=[\s/>]))[^>]*>/gi
]

function stripStaleMeta(head) {
  return STALE_META_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, ''), head)
}

export function injectSocialMeta(html, meta) {
  const rendered = renderSocialMeta(meta)
  const source = String(html)
  const headEnd = source.search(/<\/head>/i)
  const head = headEnd >= 0 ? source.slice(0, headEnd) : source
  const tail = headEnd >= 0 ? source.slice(headEnd) : ''

  const marker = /<!--\s*wikiman:meta:start\s*-->[\s\S]*?<!--\s*wikiman:meta:end\s*-->/i
  const slot = '<!--wikiman:meta:slot-->'
  const cleaned = stripStaleMeta(marker.test(head) ? head.replace(marker, slot) : head)

  if (cleaned.includes(slot)) return `${cleaned.replace(slot, rendered)}${tail}`
  if (headEnd < 0) return `${cleaned}\n${rendered}`
  return `${cleaned}    ${rendered}\n  ${tail}`
}
