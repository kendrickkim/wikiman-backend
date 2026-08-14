import { db } from './db.js'
import path from 'node:path'
import { normalizeEditorType } from './editors.js'
import { getHomePostIds, hasHomepagePosts } from './homepage.js'

const DEFAULT_PLANTUML = 'https://www.plantuml.com/plantuml'
const DEFAULT_MAX_ATTACHMENT_MB = 20
const MIN_MAX_ATTACHMENT_MB = 1
const MAX_MAX_ATTACHMENT_MB = 200

function normalizeFavicon(value, fallback) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const match = raw.match(/^\/api\/files\/([^/?#]+)$/)
  const name = match ? path.basename(match[1]) : ''
  if (!name || name !== match[1]) {
    if (fallback === undefined) {
      throw Object.assign(new Error('파비콘은 업로드한 이미지만 사용할 수 있습니다.'), { status: 400 })
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

function rowMap() {
  const map = {
    site_title: 'Wikiman',
    theme: 'light',
    plantuml_server: DEFAULT_PLANTUML,
    default_editor: 'ckeditor',
    favicon: '',
    max_attachment_mb: String(DEFAULT_MAX_ATTACHMENT_MB),
    category_tree_expand: 'expanded',
    font_scale: '100'
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

export function getSettings() {
  const map = rowMap()
  const homePostIds = getHomePostIds()
  return {
    siteTitle: String(map.site_title || 'Wikiman').trim() || 'Wikiman',
    theme: map.theme === 'dark' ? 'dark' : 'light',
    plantumlServer: String(map.plantuml_server || DEFAULT_PLANTUML).replace(/\/$/, ''),
    defaultEditor: normalizeEditorType(map.default_editor),
    favicon: normalizeFavicon(map.favicon, ''),
    maxAttachmentMb: normalizeMaxAttachmentMb(map.max_attachment_mb, DEFAULT_MAX_ATTACHMENT_MB),
    categoryTreeExpand: normalizeCategoryTreeExpand(map.category_tree_expand, 'expanded'),
    fontScale: normalizeFontScale(map.font_scale, 100),
    homePostIds,
    hasHomepage: hasHomepagePosts()
  }
}

function upsert(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value)
}

export function updateSettings(input = {}) {
  const current = getSettings()
  const next = { ...current }

  if (input.siteTitle != null) {
    const title = String(input.siteTitle).trim()
    if (!title || title.length > 80) {
      throw Object.assign(new Error('사이트 제목은 1~80자로 입력하세요.'), { status: 400 })
    }
    next.siteTitle = title
  }

  if (input.theme != null) {
    if (input.theme !== 'light' && input.theme !== 'dark') {
      throw Object.assign(new Error('테마는 밝은 또는 어두운만 선택할 수 있습니다.'), { status: 400 })
    }
    next.theme = input.theme
  }

  if (input.plantumlServer != null) {
    const url = String(input.plantumlServer).trim().replace(/\/$/, '')
    if (!/^https?:\/\/[^\s]+$/i.test(url)) {
      throw Object.assign(new Error('PlantUML 서버 주소는 http(s) URL이어야 합니다.'), { status: 400 })
    }
    next.plantumlServer = url
  }

  if (input.defaultEditor != null) {
    next.defaultEditor = normalizeEditorType(input.defaultEditor, null)
    if (!next.defaultEditor) {
      throw Object.assign(new Error('기본 작성 방식은 CKEditor, Editor.js, Markdown, HTML만 선택할 수 있습니다.'), { status: 400 })
    }
  }

  if (input.favicon != null) {
    next.favicon = normalizeFavicon(input.favicon)
  }

  if (input.maxAttachmentMb != null) {
    const mb = normalizeMaxAttachmentMb(input.maxAttachmentMb, null)
    if (mb == null) {
      throw Object.assign(
        new Error(`첨부 파일 최대 용량은 ${MIN_MAX_ATTACHMENT_MB}~${MAX_MAX_ATTACHMENT_MB}MB로 입력하세요.`),
        { status: 400 }
      )
    }
    next.maxAttachmentMb = mb
  }

  if (input.categoryTreeExpand != null) {
    const mode = normalizeCategoryTreeExpand(input.categoryTreeExpand, null)
    if (!mode) {
      throw Object.assign(new Error('카테고리 트리는 모두 펼침, 모두 접힘, 1단계만 펼침만 선택할 수 있습니다.'), { status: 400 })
    }
    next.categoryTreeExpand = mode
  }

  if (input.fontScale != null) {
    const scale = normalizeFontScale(input.fontScale, null)
    if (scale == null) {
      throw Object.assign(new Error('글자 스케일은 60~120%로 입력하세요.'), { status: 400 })
    }
    next.fontScale = scale
  }

  const tx = db.transaction(() => {
    upsert('site_title', next.siteTitle)
    upsert('theme', next.theme)
    upsert('plantuml_server', next.plantumlServer)
    upsert('default_editor', next.defaultEditor)
    upsert('favicon', next.favicon)
    upsert('max_attachment_mb', String(next.maxAttachmentMb))
    upsert('category_tree_expand', next.categoryTreeExpand)
    upsert('font_scale', String(next.fontScale))
  })
  tx()
  return getSettings()
}
