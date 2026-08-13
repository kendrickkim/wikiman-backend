import { db } from './db.js'
import { normalizeEditorType } from './editors.js'

const DEFAULT_PLANTUML = 'https://www.plantuml.com/plantuml'

function rowMap() {
  const map = {
    site_title: 'Wikiman',
    theme: 'light',
    plantuml_server: DEFAULT_PLANTUML,
    default_editor: 'editorjs'
  }
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    map[row.key] = row.value
  }
  return map
}

export function getHomePostId() {
  const id = Number(String(rowMap().home_post_id || '').trim())
  return Number.isFinite(id) && id > 0 ? id : null
}

export function setHomePostId(id) {
  upsert('home_post_id', id == null ? '' : String(id))
}

export function applyHomepageFlag(postId, isHomepage) {
  const id = Number(postId)
  if (!Number.isFinite(id) || id <= 0) return
  if (isHomepage) setHomePostId(id)
  else if (getHomePostId() === id) setHomePostId(null)
}

export function getSettings() {
  const map = rowMap()
  return {
    siteTitle: String(map.site_title || 'Wikiman').trim() || 'Wikiman',
    theme: map.theme === 'dark' ? 'dark' : 'light',
    plantumlServer: String(map.plantuml_server || DEFAULT_PLANTUML).replace(/\/$/, ''),
    defaultEditor: normalizeEditorType(map.default_editor),
    homePostId: getHomePostId()
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
      throw Object.assign(new Error('기본 작성 방식은 Editor.js, Markdown, HTML만 선택할 수 있습니다.'), { status: 400 })
    }
  }

  const tx = db.transaction(() => {
    upsert('site_title', next.siteTitle)
    upsert('theme', next.theme)
    upsert('plantuml_server', next.plantumlServer)
    upsert('default_editor', next.defaultEditor)
  })
  tx()
  return getSettings()
}
