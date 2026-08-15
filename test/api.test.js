import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import bcrypt from 'bcryptjs'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'wikiman-api-'))
process.env.WIKIMAN_DATA_DIR = dataDir
process.env.JWT_SECRET = 'test-jwt-secret-value-ok'
process.env.NODE_ENV = 'test'

const dbModule = await import('../src/db.js')
const { createApp } = await import('../src/app.js')
const { createBackupFile, inspectBackupFile, restoreBackupFile } = await import('../src/backup.js')
const { injectSocialMeta, socialMetaForPath } = await import('../src/socialMeta.js')
const { CURRENT_SCHEMA_VERSION } = dbModule
let { db } = dbModule

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
}

async function json(res) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text, status: res.status }
  }
}

test('schema_version이 정수로 저장된다', () => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get()
  assert.equal(Number(row.value), CURRENT_SCHEMA_VERSION)
  const refs = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'upload_refs'").get()
  assert.ok(refs)
  const topMenu = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'top_menu_items'").get()
  assert.ok(topMenu)
  const quickPosts = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'quick_posts'").get()
  assert.ok(quickPosts)
  const linkPreviewCache = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'link_preview_cache'").get()
  assert.ok(linkPreviewCache)
})

test('검색은 content LIKE 없이 FTS·제목·키워드를 쓰고, 키워드 API는 객체 배열만 반환한다', async (t) => {
  const passwordHash = bcrypt.hashSync('secret12', 4)
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('writer', ?, 'writer')").run(passwordHash)
  const userId = db.prepare("SELECT id FROM users WHERE username = 'writer'").get().id
  db.prepare(`
    INSERT INTO posts (title, slug, author_id, visibility, status, editor_type, content)
    VALUES ('검색제목', 'search-title', ?, 'public', 'published', 'markdown', '본문에만있는단어')
  `).run(userId)
  const postId = db.prepare("SELECT id FROM posts WHERE slug = 'search-title'").get().id
  db.prepare('INSERT INTO post_keywords (post_id, keyword, sort_order) VALUES (?, ?, 0)').run(postId, '키워드A')
  db.prepare(`
    INSERT INTO posts (title, slug, author_id, visibility, status, editor_type, content)
    VALUES ('다른글', 'other-post', ?, 'public', 'published', 'html', '<p>안녕<script>alert(1)</script></p>')
  `).run(userId)
  const htmlId = db.prepare("SELECT id FROM posts WHERE slug = 'other-post'").get().id

  const socialId = Number(db.prepare(`
    INSERT INTO posts (title, slug, author_id, visibility, status, editor_type, content)
    VALUES ('공유 글', 'social-post', ?, 'public', 'published', 'markdown', ?)
  `).run(userId, '공유할 본문입니다.\n\n![대표 그림](https://cdn.example.com/cover.jpg)').lastInsertRowid)
  const social = socialMetaForPath(`/posts/${socialId}`, 'https://wiki.example')
  assert.equal(social.title, '공유 글')
  assert.equal(social.description, '공유할 본문입니다.')
  assert.equal(social.image, 'https://cdn.example.com/cover.jpg')
  assert.equal(social.url, `https://wiki.example/posts/${socialId}`)
  const socialHtml = injectSocialMeta(
    '<html><head><title>기본</title><meta name="description" content="기본"></head><body></body></html>',
    social
  )
  assert.match(socialHtml, /property="og:title" content="공유 글"/)
  assert.match(socialHtml, /property="og:image" content="https:\/\/cdn\.example\.com\/cover\.jpg"/)

  const minifiedHtml = injectSocialMeta(
    '<!DOCTYPE html><html><head><meta charset=utf-8><meta name=description content="개인 위키">'
      + '<meta property=og:title content=Wikiman><meta property=og:type content=website>'
      + '<meta name=twitter:title content=Wikiman><link rel=canonical href=/>'
      + '<meta name=theme-color content=#1b1f24></head><body></body></html>',
    social
  )
  assert.equal(minifiedHtml.match(/og:title/g).length, 1)
  assert.equal(minifiedHtml.match(/twitter:title/g).length, 1)
  assert.equal(minifiedHtml.match(/<title>/g).length, 1)
  assert.equal(minifiedHtml.match(/rel="?canonical"?/g).length, 1)
  assert.match(minifiedHtml, /property="og:type" content="article"/)
  assert.doesNotMatch(minifiedHtml, /content=Wikiman/)
  assert.match(minifiedHtml, /<meta name=theme-color content=#1b1f24>/)

  const untitledId = Number(db.prepare(`
    INSERT INTO posts (title, slug, author_id, visibility, status, editor_type, content)
    VALUES ('', 'untitled-social', ?, 'public', 'published', 'markdown', '제목 없는 본문')
  `).run(userId).lastInsertRowid)
  const untitledSocial = socialMetaForPath(`/posts/${untitledId}`, 'https://wiki.example')
  assert.equal(untitledSocial.title, 'Wikiman')
  assert.equal(untitledSocial.description, '제목 없는 본문')

  const emptyBodyId = Number(db.prepare(`
    INSERT INTO posts (title, slug, author_id, visibility, status, editor_type, content)
    VALUES ('이미지만', 'empty-body-social', ?, 'public', 'published', 'markdown', '![그림](https://cdn.example.com/a.png)')
  `).run(userId).lastInsertRowid)
  const emptyBodySocial = socialMetaForPath(`/posts/${emptyBodyId}`, 'https://wiki.example')
  assert.equal(emptyBodySocial.description, '')
  const emptyBodyHtml = injectSocialMeta('<html><head></head><body></body></html>', emptyBodySocial)
  assert.doesNotMatch(emptyBodyHtml, /name="description"/)
  assert.doesNotMatch(emptyBodyHtml, /og:description/)
  assert.doesNotMatch(emptyBodyHtml, /twitter:description/)
  assert.doesNotMatch(emptyBodyHtml, /개인 위키/)

  const app = createApp()
  const server = await listen(app)
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'writer', password: 'secret12' })
  })
  const session = await json(login)
  assert.ok(session.token)
  const auth = { authorization: `Bearer ${session.token}` }

  const summernotePost = await json(await fetch(`${base}/api/posts`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Summernote 글',
      editorType: 'summernote',
      content: '<p>Summernote</p><script>alert(1)</script>',
      status: 'published',
      visibility: 'public'
    })
  }))
  assert.equal(summernotePost.post.editorType, 'summernote')
  assert.equal(summernotePost.post.content.includes('<script'), false)

  const savedMenu = await json(await fetch(`${base}/api/settings/top-menu`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [
        { label: '검색 문서', postId },
        { label: '외부', url: 'https://example.com/docs' },
        { label: '내부', url: '/keywords' }
      ]
    })
  }))
  assert.equal(savedMenu.items[0].label, '검색 문서')
  assert.equal(savedMenu.items[0].postId, postId)
  assert.equal(savedMenu.items[1].url, 'https://example.com/docs')
  assert.equal(savedMenu.items[2].url, '/keywords')

  const publicSettings = await json(await fetch(`${base}/api/settings`))
  assert.deepEqual(
    publicSettings.topMenuItems.map((item) => ({
      label: item.label,
      postId: item.postId,
      url: item.url || ''
    })),
    [
      { label: '검색 문서', postId, url: '' },
      { label: '외부', postId: null, url: 'https://example.com/docs' },
      { label: '내부', postId: null, url: '/keywords' }
    ]
  )

  const byTitle = await json(await fetch(`${base}/api/posts?q=${encodeURIComponent('검색제목')}`))
  assert.equal(byTitle.posts.some((post) => post.id === postId), true)

  const byKeyword = await json(await fetch(`${base}/api/posts?q=${encodeURIComponent('키워드A')}`))
  assert.equal(byKeyword.posts.some((post) => post.id === postId), true)

  const byContent = await json(await fetch(`${base}/api/posts?q=${encodeURIComponent('본문에만있는단어')}`))
  assert.equal(byContent.posts.some((post) => post.id === postId), true)

  const keywords = await json(await fetch(`${base}/api/posts/keywords`))
  assert.equal(Array.isArray(keywords.keywords), true)
  assert.equal(typeof keywords.keywords[0], 'object')
  assert.equal(keywords.keywords[0].name, '키워드A')
  assert.equal(keywords.keywords[0].count, 1)
  assert.equal('keywordItems' in keywords, false)

  db.prepare("UPDATE posts SET deleted_at = datetime('now') WHERE id = ?").run(postId)
  const keywordsAfterTrash = await json(await fetch(`${base}/api/posts/keywords`))
  assert.equal(
    keywordsAfterTrash.keywords.some((item) => item.name === '키워드A'),
    false,
    '휴지통 글의 키워드는 문서 수에 포함되지 않아야 한다'
  )
  db.prepare('UPDATE posts SET deleted_at = NULL WHERE id = ?').run(postId)

  const htmlPost = await json(await fetch(`${base}/api/posts/${htmlId}`))
  assert.equal(htmlPost.post.content.includes('<script'), false)

  const trashAnon = await fetch(`${base}/api/posts/trash`)
  assert.equal(trashAnon.status, 401)

  const settingsSaved = await json(await fetch(`${base}/api/settings`, {
    method: 'PATCH',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      mobileQuickPostEnabled: true,
      quickPostEditor: 'textarea',
      quickPostPromoteSourceMode: 'ask',
      quickPostPromoteEditor: 'ask',
      linkPreviewCacheTtlDays: 15,
      linkPreviewFailureTtlDays: 2
    })
  }))
  assert.equal(settingsSaved.mobileQuickPostEnabled, true)
  assert.equal(settingsSaved.quickPostEditor, 'textarea')
  assert.equal(settingsSaved.quickPostPromoteSourceMode, 'ask')
  assert.equal(settingsSaved.quickPostPromoteEditor, 'ask')
  assert.equal(settingsSaved.linkPreviewCacheTtlDays, 15)
  assert.equal(settingsSaved.linkPreviewFailureTtlDays, 2)

  const emptyQuick = await fetch(`${base}/api/quick-posts`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ content: '   ' })
  })
  assert.equal(emptyQuick.status, 400)

  const createdQuick = await json(await fetch(`${base}/api/quick-posts`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ content: '간단 메모 내용' })
  }))
  assert.equal(createdQuick.quickPost.content, '간단 메모 내용')
  const quickId = createdQuick.quickPost.id

  const quickList = await json(await fetch(`${base}/api/quick-posts`, { headers: auth }))
  assert.ok(quickList.quickPosts.some((item) => item.id === quickId))

  const patchedQuick = await json(await fetch(`${base}/api/quick-posts/${quickId}`, {
    method: 'PATCH',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ content: '수정된 간단 메모' })
  }))
  assert.equal(patchedQuick.quickPost.content, '수정된 간단 메모')

  const promoted = await json(await fetch(`${base}/api/quick-posts/${quickId}/promote`, {
    method: 'POST',
    headers: auth
  }))
  assert.equal(promoted.post.status, 'draft')
  assert.equal(promoted.post.editorType, 'textarea')
  assert.equal(promoted.post.title, '')
  assert.equal(promoted.post.content, '수정된 간단 메모')
  assert.equal(promoted.post.categoryId, null)
  const gone = db.prepare('SELECT id FROM quick_posts WHERE id = ?').get(quickId)
  assert.equal(gone, undefined)

  const editorQuick = await json(await fetch(`${base}/api/quick-posts`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ content: '첫 문단\n\n둘째 문단' })
  }))
  const editorPromoted = await json(await fetch(`${base}/api/quick-posts/${editorQuick.quickPost.id}/promote`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ editorType: 'editorjs', keepSource: true })
  }))
  assert.equal(editorPromoted.post.editorType, 'editorjs')
  assert.equal(JSON.parse(editorPromoted.post.content).blocks.length, 2)
  assert.equal(editorPromoted.sourceKept, true)
  assert.ok(db.prepare('SELECT id FROM quick_posts WHERE id = ?').get(editorQuick.quickPost.id))
  await fetch(`${base}/api/quick-posts/${editorQuick.quickPost.id}`, {
    method: 'DELETE',
    headers: auth
  })

  const anotherQuick = await json(await fetch(`${base}/api/quick-posts`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ content: '삭제할 메모' })
  }))
  const deleted = await fetch(`${base}/api/quick-posts/${anotherQuick.quickPost.id}`, {
    method: 'DELETE',
    headers: auth
  })
  assert.equal(deleted.status, 200)
})

test('비공개 글 파일은 직접 URL로 열 수 없고, 백업 복구는 스트리밍으로 동작한다', async (t) => {
  const user = db.prepare("SELECT id FROM users WHERE username = 'writer'").get()
  assert.ok(user)
  const stored = 'priv-file.txt'
  fs.writeFileSync(path.join(dbModule.uploadsDir, stored), 'secret-bytes')
  db.prepare(`
    INSERT INTO posts (title, slug, author_id, visibility, status, editor_type, content)
    VALUES ('비밀', 'private-file-post', ?, 'private', 'published', 'markdown', ?)
  `).run(user.id, `![](/api/posts/x/files/${stored})`)
  const post = db.prepare("SELECT id FROM posts WHERE slug = 'private-file-post'").get()
  db.prepare('UPDATE posts SET content = ? WHERE id = ?').run(`![](/api/posts/${post.id}/files/${stored})`, post.id)
  db.prepare('INSERT INTO upload_refs (post_id, stored_name) VALUES (?, ?)').run(post.id, stored)
  const privateSocial = socialMetaForPath(`/posts/${post.id}`, 'https://wiki.example')
  assert.equal(privateSocial.title, 'Wikiman')
  assert.equal(privateSocial.image, 'https://wiki.example/icons/apple-touch-icon.png')

  const app = createApp()
  const server = await listen(app)
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  const denied = await fetch(`${base}/api/files/${stored}`)
  assert.equal(denied.status, 404)
  const deniedPost = await fetch(`${base}/api/posts/${post.id}/files/${stored}`)
  assert.equal(deniedPost.status, 404)

  // 편집 중 붙여넣은(아직 글에 연결되지 않은) 이미지는 미리보기가 되어야 한다
  const draftStored = 'draft-paste.png'
  fs.writeFileSync(path.join(dbModule.uploadsDir, draftStored), 'draft-bytes')
  const draftVisible = await fetch(`${base}/api/files/${draftStored}`)
  assert.equal(draftVisible.status, 200)

  const login = await json(await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'writer', password: 'secret12' })
  }))
  const allowed = await fetch(`${base}/api/posts/${post.id}/files/${stored}`, {
    headers: { authorization: `Bearer ${login.token}` }
  })
  assert.equal(allowed.status, 200)
  assert.equal(await allowed.text(), 'secret-bytes')

  const allowedByCookie = await fetch(`${base}/api/posts/${post.id}/files/${stored}`, {
    headers: { cookie: `wikiman_token=${encodeURIComponent(login.token)}` }
  })
  assert.equal(allowedByCookie.status, 200)
  assert.equal(await allowedByCookie.text(), 'secret-bytes')

  const backupPath = path.join(dataDir, 'sample.wkmbak')
  await createBackupFile(backupPath)
  const info = await inspectBackupFile(backupPath)
  assert.equal(info.ok, true)
  assert.ok(info.fileCount >= 2)

  fs.writeFileSync(path.join(dbModule.uploadsDir, stored), 'changed')
  dbModule.closeDatabase()
  await restoreBackupFile(backupPath)
  db = dbModule.reopenDatabase()
  const restored = fs.readFileSync(path.join(dbModule.uploadsDir, stored), 'utf8')
  assert.equal(restored, 'secret-bytes')
  const version = db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get()
  assert.equal(Number(version.value), CURRENT_SCHEMA_VERSION)
})

test.after(() => {
  try {
    dbModule.closeDatabase()
  } catch {
    // ignore
  }
})
