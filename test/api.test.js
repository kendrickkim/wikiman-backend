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
  assert.equal('keywordItems' in keywords, false)

  const htmlPost = await json(await fetch(`${base}/api/posts/${htmlId}`))
  assert.equal(htmlPost.post.content.includes('<script'), false)

  const trashAnon = await fetch(`${base}/api/posts/trash`)
  assert.equal(trashAnon.status, 401)
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

  const app = createApp()
  const server = await listen(app)
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  const denied = await fetch(`${base}/api/files/${stored}`)
  assert.equal(denied.status, 404)
  const deniedPost = await fetch(`${base}/api/posts/${post.id}/files/${stored}`)
  assert.equal(deniedPost.status, 404)

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
