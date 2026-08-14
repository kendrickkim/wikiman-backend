import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeHtml, sanitizePostContent } from '../src/sanitize.js'

test('script과 이벤트 핸들러를 제거한다', () => {
  const html = `<p onclick="alert(1)">안녕</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>`
  const clean = sanitizeHtml(html)
  assert.equal(clean.includes('<script'), false)
  assert.equal(clean.includes('onclick'), false)
  assert.equal(clean.includes('javascript:'), false)
  assert.equal(clean.includes('안녕'), true)
})

test('허용된 태그와 안전한 링크는 남긴다', () => {
  const html = '<p>본문</p><a href="/posts/1">글</a><img src="/api/files/a.png" alt="그림">'
  const clean = sanitizeHtml(html)
  assert.equal(clean.includes('<p>본문</p>'), true)
  assert.equal(clean.includes('href="/posts/1"'), true)
  assert.equal(clean.includes('src="/api/files/a.png"'), true)
})

test('HTML 글 본문을 저장 전에 정제한다', () => {
  const content = sanitizePostContent('html', '<div>ok<iframe src="x"></iframe></div>')
  assert.equal(content.includes('iframe'), false)
  assert.equal(content.includes('ok'), true)
})
