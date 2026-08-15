import { db } from './db.js'
import path from 'node:path'
import { EDITOR_TYPES, normalizeEditorType } from './editors.js'
import { getHomePostIds } from './homepage.js'
import { getTopMenuItems } from './topMenu.js'
import { apiError } from './errors.js'

const DEFAULT_PLANTUML = 'https://www.plantuml.com/plantuml'
export const SITE_LANGUAGES = ['ko-KR', 'en-US']
export const DEFAULT_SITE_LANGUAGE = 'ko-KR'
const DEFAULT_MAX_ATTACHMENT_MB = 20
const MIN_MAX_ATTACHMENT_MB = 1
const MAX_MAX_ATTACHMENT_MB = 200
export const DEFAULT_LINK_PREVIEW_CACHE_TTL_DAYS = 10
export const DEFAULT_LINK_PREVIEW_FAILURE_TTL_DAYS = 1
const MIN_LINK_PREVIEW_TTL_DAYS = 1
const MAX_LINK_PREVIEW_TTL_DAYS = 365

export function normalizeSiteLanguage(value, fallback = DEFAULT_SITE_LANGUAGE) {
  const raw = String(value ?? '').trim()
  if (SITE_LANGUAGES.includes(raw)) return raw
  if (raw === 'ko' || raw === 'ko_KR') return 'ko-KR'
  if (raw === 'en' || raw === 'en_US') return 'en-US'
  if (fallback === null) return null
  return fallback
}

function normalizeFavicon(value, fallback) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const match = raw.match(/^\/api\/files\/([^/?#]+)$/)
  const name = match ? path.basename(match[1]) : ''
  if (!name || name !== match[1]) {
    if (fallback === undefined) {
      throw apiError('FAVICON_UPLOAD_ONLY', 400)
    }
    return fallback
  }
  return `/api/files/${name}`
}

export function normalizeMaxAttachmentMb(value, fallback = DEFAULT_MAX_ATTACHMENT_MB) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n < MIN_MAX_ATTACHMENT_MB || n > MAX_MAX_ATTACHMENT_MB) {
    if (fallback === null) return null
    return fallback
  }
  return n
}

const TREE_EXPAND_VALUES = ['expanded', 'collapsed', 'root']

export function normalizeCategoryTreeExpand(value, fallback = 'expanded') {
  const v = String(value ?? '').trim()
  if (TREE_EXPAND_VALUES.includes(v)) return v
  if (fallback === null) return null
  return fallback
}

const TREE_SIDE_VALUES = ['left', 'right']

export function normalizeCategoryTreeSide(value, fallback = 'left') {
  const v = String(value ?? '').trim()
  if (TREE_SIDE_VALUES.includes(v)) return v
  if (fallback === null) return null
  return fallback
}

export const FONT_SCALES = [60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120]
const MIN_FONT_SCALE = 60
const MAX_FONT_SCALE = 120
const DEFAULT_FONT_SCALE = 100

export function normalizeFontScale(value, fallback = DEFAULT_FONT_SCALE) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n < MIN_FONT_SCALE || n > MAX_FONT_SCALE) {
    if (fallback === null) return null
    return fallback
  }
  return n
}

export function normalizeTopMenuVisible(value, fallback = true) {
  if (value === true || value === false) return value
  const v = String(value ?? '').trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false
  if (fallback === null) return null
  return fallback
}

export function normalizeRightMenuDefaultOpen(value, fallback = true) {
  return normalizeTopMenuVisible(value, fallback)
}

export function normalizeMobileQuickPostEnabled(value, fallback = false) {
  if (value === true || value === false) return value
  const v = String(value ?? '').trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false
  if (fallback === null) return null
  return fallback
}

export function normalizeBlogMode(value, fallback = false) {
  return normalizeMobileQuickPostEnabled(value, fallback)
}

export function normalizeBlogShowHomepage(value, fallback = false) {
  return normalizeMobileQuickPostEnabled(value, fallback)
}

export function normalizeCodeLineNumbers(value, fallback = false) {
  return normalizeMobileQuickPostEnabled(value, fallback)
}

const MIN_BLOG_POSTS_PER_PAGE = 1
const MAX_BLOG_POSTS_PER_PAGE = 100

export function normalizeBlogPostsPerPage(value, fallback = 10) {
  const n = Math.round(Number(value))
  if (Number.isFinite(n) && n >= MIN_BLOG_POSTS_PER_PAGE && n <= MAX_BLOG_POSTS_PER_PAGE) return n
  if (fallback === null) return null
  const fb = Math.round(Number(fallback))
  if (Number.isFinite(fb) && fb >= MIN_BLOG_POSTS_PER_PAGE && fb <= MAX_BLOG_POSTS_PER_PAGE) return fb
  return 10
}

const QUICK_POST_PROMOTE_SOURCE_MODES = ['ask', 'delete', 'keep']

export function normalizeQuickPostPromoteSourceMode(value, fallback = 'ask') {
  const mode = String(value ?? '').trim()
  if (QUICK_POST_PROMOTE_SOURCE_MODES.includes(mode)) return mode
  if (fallback === null) return null
  return fallback
}

export function normalizeQuickPostPromoteEditor(value, fallback = 'ask') {
  const mode = String(value ?? '').trim()
  if (mode === 'ask') return 'ask'
  if (EDITOR_TYPES.includes(mode)) return mode
  if (fallback === null) return null
  return fallback === 'ask' || EDITOR_TYPES.includes(fallback) ? fallback : 'ask'
}

export function normalizeQuickPostEditor(value, fallback = 'tui') {
  return normalizeEditorType(value, fallback)
}

export function normalizeLinkPreviewTtlDays(value, fallback) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n < MIN_LINK_PREVIEW_TTL_DAYS || n > MAX_LINK_PREVIEW_TTL_DAYS) {
    if (fallback === null) return null
    return fallback
  }
  return n
}

function rowMap() {
  const map = {
    site_title: 'Wikiman',
    site_language: 'ko-KR',
    theme: 'light',
    plantuml_server: DEFAULT_PLANTUML,
    default_editor: 'ckeditor',
    default_editor_mobile: 'ckeditor',
    favicon: '',
    max_attachment_mb: String(DEFAULT_MAX_ATTACHMENT_MB),
    category_tree_expand: 'expanded',
    category_tree_side: 'left',
    right_menu_default_open: '1',
    font_scale: '100',
    top_menu_visible: '1',
    mobile_quick_post_enabled: '0',
    blog_mode: '0',
    blog_show_homepage: '0',
    blog_posts_per_page: '10',
    code_line_numbers: '0',
    quick_post_editor: 'tui',
    quick_post_promote_source_mode: 'ask',
    quick_post_promote_editor: 'ask',
    link_preview_cache_ttl_days: String(DEFAULT_LINK_PREVIEW_CACHE_TTL_DAYS),
    link_preview_failure_ttl_days: String(DEFAULT_LINK_PREVIEW_FAILURE_TTL_DAYS)
  }
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    map[row.key] = row.value
  }
  return map
}

export function getMaxAttachmentMb() {
  return normalizeMaxAttachmentMb(rowMap().max_attachment_mb, DEFAULT_MAX_ATTACHMENT_MB)
}

export function getMaxAttachmentBytes() {
  return getMaxAttachmentMb() * 1024 * 1024
}

export function getLinkPreviewCacheConfig() {
  const map = rowMap()
  return {
    ttlDays: normalizeLinkPreviewTtlDays(
      map.link_preview_cache_ttl_days,
      DEFAULT_LINK_PREVIEW_CACHE_TTL_DAYS
    ),
    failureTtlDays: normalizeLinkPreviewTtlDays(
      map.link_preview_failure_ttl_days,
      DEFAULT_LINK_PREVIEW_FAILURE_TTL_DAYS
    )
  }
}

export function getSettings(user) {
  const map = rowMap()
  const homePostIds = getHomePostIds()
  return {
    siteTitle: String(map.site_title || 'Wikiman').trim() || 'Wikiman',
    siteLanguage: normalizeSiteLanguage(map.site_language, 'ko-KR'),
    theme: map.theme === 'dark' ? 'dark' : 'light',
    plantumlServer: String(map.plantuml_server || DEFAULT_PLANTUML).replace(/\/$/, ''),
    defaultEditor: normalizeEditorType(map.default_editor),
    defaultEditorMobile: normalizeEditorType(map.default_editor_mobile || map.default_editor),
    favicon: normalizeFavicon(map.favicon, ''),
    maxAttachmentMb: normalizeMaxAttachmentMb(map.max_attachment_mb, DEFAULT_MAX_ATTACHMENT_MB),
    categoryTreeExpand: normalizeCategoryTreeExpand(map.category_tree_expand, 'expanded'),
    categoryTreeSide: normalizeCategoryTreeSide(map.category_tree_side, 'left'),
    rightMenuDefaultOpen: normalizeRightMenuDefaultOpen(map.right_menu_default_open, true),
    fontScale: normalizeFontScale(map.font_scale, 100),
    topMenuVisible: normalizeTopMenuVisible(map.top_menu_visible, true),
    mobileQuickPostEnabled: normalizeMobileQuickPostEnabled(map.mobile_quick_post_enabled, false),
    blogMode: normalizeBlogMode(map.blog_mode, false),
    blogShowHomepage: normalizeBlogShowHomepage(map.blog_show_homepage, false),
    blogPostsPerPage: normalizeBlogPostsPerPage(map.blog_posts_per_page, 10),
    codeLineNumbers: normalizeCodeLineNumbers(map.code_line_numbers, false),
    quickPostEditor: normalizeQuickPostEditor(map.quick_post_editor, 'tui'),
    quickPostPromoteSourceMode: normalizeQuickPostPromoteSourceMode(
      map.quick_post_promote_source_mode,
      'ask'
    ),
    quickPostPromoteEditor: normalizeQuickPostPromoteEditor(
      map.quick_post_promote_editor,
      'ask'
    ),
    linkPreviewCacheTtlDays: normalizeLinkPreviewTtlDays(
      map.link_preview_cache_ttl_days,
      DEFAULT_LINK_PREVIEW_CACHE_TTL_DAYS
    ),
    linkPreviewFailureTtlDays: normalizeLinkPreviewTtlDays(
      map.link_preview_failure_ttl_days,
      DEFAULT_LINK_PREVIEW_FAILURE_TTL_DAYS
    ),
    homePostIds,
    hasHomepage: homePostIds.length > 0,
    topMenuItems: getTopMenuItems(user)
  }
}

function upsert(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value)
}

export function updateSettings(input = {}, user) {
  const current = getSettings()
  const next = { ...current }

  if (input.siteTitle != null) {
    const title = String(input.siteTitle).trim()
    if (!title || title.length > 80) {
      throw apiError('SITE_TITLE_LENGTH', 400)
    }
    next.siteTitle = title
  }

  if (input.theme != null) {
    if (input.theme !== 'light' && input.theme !== 'dark') {
      throw apiError('THEME_INVALID', 400)
    }
    next.theme = input.theme
  }

  if (input.plantumlServer != null) {
    const url = String(input.plantumlServer).trim().replace(/\/$/, '')
    if (!/^https?:\/\/[^\s]+$/i.test(url)) {
      throw apiError('PLANTUML_URL_INVALID', 400)
    }
    next.plantumlServer = url
  }

  if (input.defaultEditor != null) {
    next.defaultEditor = normalizeEditorType(input.defaultEditor, null)
    if (!next.defaultEditor) {
      throw apiError('DEFAULT_EDITOR_INVALID', 400)
    }
  }

  if (input.defaultEditorMobile != null) {
    next.defaultEditorMobile = normalizeEditorType(input.defaultEditorMobile, null)
    if (!next.defaultEditorMobile) {
      throw apiError('DEFAULT_EDITOR_MOBILE_INVALID', 400)
    }
  }

  if (input.favicon != null) {
    next.favicon = normalizeFavicon(input.favicon)
  }

  if (input.maxAttachmentMb != null) {
    const mb = normalizeMaxAttachmentMb(input.maxAttachmentMb, null)
    if (mb == null) {
      throw apiError('MAX_ATTACHMENT_MB_INVALID', 400)
    }
    next.maxAttachmentMb = mb
  }

  if (input.categoryTreeExpand != null) {
    const mode = normalizeCategoryTreeExpand(input.categoryTreeExpand, null)
    if (!mode) {
      throw apiError('CATEGORY_TREE_EXPAND_INVALID', 400)
    }
    next.categoryTreeExpand = mode
  }

  if (input.categoryTreeSide != null) {
    const side = normalizeCategoryTreeSide(input.categoryTreeSide, null)
    if (!side) {
      throw apiError('CATEGORY_TREE_SIDE_INVALID', 400)
    }
    next.categoryTreeSide = side
  }

  if (input.rightMenuDefaultOpen != null) {
    const open = normalizeRightMenuDefaultOpen(input.rightMenuDefaultOpen, null)
    if (open == null) {
      throw apiError('RIGHT_MENU_DEFAULT_OPEN_INVALID', 400)
    }
    next.rightMenuDefaultOpen = open
  }

  if (input.fontScale != null) {
    const scale = normalizeFontScale(input.fontScale, null)
    if (scale == null) {
      throw apiError('FONT_SCALE_INVALID', 400)
    }
    next.fontScale = scale
  }

  if (input.topMenuVisible != null) {
    const visible = normalizeTopMenuVisible(input.topMenuVisible, null)
    if (visible == null) {
      throw apiError('TOP_MENU_VISIBLE_INVALID', 400)
    }
    next.topMenuVisible = visible
  }

  if (input.mobileQuickPostEnabled != null) {
    const enabled = normalizeMobileQuickPostEnabled(input.mobileQuickPostEnabled, null)
    if (enabled == null) {
      throw apiError('MOBILE_QUICK_POST_INVALID', 400)
    }
    next.mobileQuickPostEnabled = enabled
  }

  if (input.blogMode != null) {
    const enabled = normalizeBlogMode(input.blogMode, null)
    if (enabled == null) {
      throw apiError('BLOG_MODE_INVALID', 400)
    }
    next.blogMode = enabled
  }

  if (input.blogShowHomepage != null) {
    const enabled = normalizeBlogShowHomepage(input.blogShowHomepage, null)
    if (enabled == null) {
      throw apiError('BLOG_SHOW_HOMEPAGE_INVALID', 400)
    }
    next.blogShowHomepage = enabled
  }

  if (input.blogPostsPerPage != null) {
    const size = normalizeBlogPostsPerPage(input.blogPostsPerPage, null)
    if (size == null) {
      throw apiError('BLOG_POSTS_PER_PAGE_INVALID', 400)
    }
    next.blogPostsPerPage = size
  }

  if (input.siteLanguage != null) {
    const language = normalizeSiteLanguage(input.siteLanguage, null)
    if (!language) {
      throw apiError('SITE_LANGUAGE_INVALID', 400)
    }
    next.siteLanguage = language
  }

  if (input.codeLineNumbers != null) {
    const enabled = normalizeCodeLineNumbers(input.codeLineNumbers, null)
    if (enabled == null) {
      throw apiError('CODE_LINE_NUMBERS_INVALID', 400)
    }
    next.codeLineNumbers = enabled
  }

  if (input.quickPostEditor != null) {
    next.quickPostEditor = normalizeQuickPostEditor(input.quickPostEditor, null)
    if (!next.quickPostEditor) {
      throw apiError('QUICK_POST_EDITOR_INVALID', 400)
    }
  }

  if (input.quickPostPromoteSourceMode != null) {
    const mode = normalizeQuickPostPromoteSourceMode(input.quickPostPromoteSourceMode, null)
    if (!mode) {
      throw apiError('QUICK_POST_PROMOTE_SOURCE_INVALID', 400)
    }
    next.quickPostPromoteSourceMode = mode
  }

  if (input.quickPostPromoteEditor != null) {
    const editor = normalizeQuickPostPromoteEditor(input.quickPostPromoteEditor, null)
    if (!editor) {
      throw apiError('QUICK_POST_PROMOTE_EDITOR_INVALID', 400)
    }
    next.quickPostPromoteEditor = editor
  }

  if (input.linkPreviewCacheTtlDays != null) {
    const days = normalizeLinkPreviewTtlDays(input.linkPreviewCacheTtlDays, null)
    if (days == null) {
      throw apiError('LINK_PREVIEW_CACHE_TTL_INVALID', 400)
    }
    next.linkPreviewCacheTtlDays = days
  }

  if (input.linkPreviewFailureTtlDays != null) {
    const days = normalizeLinkPreviewTtlDays(input.linkPreviewFailureTtlDays, null)
    if (days == null) {
      throw apiError('LINK_PREVIEW_FAILURE_TTL_INVALID', 400)
    }
    next.linkPreviewFailureTtlDays = days
  }

  const tx = db.transaction(() => {
    upsert('site_title', next.siteTitle)
    upsert('site_language', next.siteLanguage)
    upsert('theme', next.theme)
    upsert('plantuml_server', next.plantumlServer)
    upsert('default_editor', next.defaultEditor)
    upsert('default_editor_mobile', next.defaultEditorMobile)
    upsert('favicon', next.favicon)
    upsert('max_attachment_mb', String(next.maxAttachmentMb))
    upsert('category_tree_expand', next.categoryTreeExpand)
    upsert('category_tree_side', next.categoryTreeSide)
    upsert('right_menu_default_open', next.rightMenuDefaultOpen ? '1' : '0')
    upsert('font_scale', String(next.fontScale))
    upsert('top_menu_visible', next.topMenuVisible ? '1' : '0')
    upsert('mobile_quick_post_enabled', next.mobileQuickPostEnabled ? '1' : '0')
    upsert('blog_mode', next.blogMode ? '1' : '0')
    upsert('blog_show_homepage', next.blogShowHomepage ? '1' : '0')
    upsert('blog_posts_per_page', String(next.blogPostsPerPage))
    upsert('code_line_numbers', next.codeLineNumbers ? '1' : '0')
    upsert('quick_post_editor', next.quickPostEditor)
    upsert('quick_post_promote_source_mode', next.quickPostPromoteSourceMode)
    upsert('quick_post_promote_editor', next.quickPostPromoteEditor)
    upsert('link_preview_cache_ttl_days', String(next.linkPreviewCacheTtlDays))
    upsert('link_preview_failure_ttl_days', String(next.linkPreviewFailureTtlDays))
  })
  tx()
  return getSettings(user)
}
