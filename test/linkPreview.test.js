import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePreviewUrl, fetchLinkPreview } from '../src/linkPreview.js'

test('link preview는 http(s)만 허용하고 내부 주소를 거부한다', () => {
  assert.equal(normalizePreviewUrl('https://example.com/a').hostname, 'example.com')
  assert.equal(normalizePreviewUrl('ftp://example.com'), null)
  assert.equal(normalizePreviewUrl('http://localhost/x'), null)
  assert.equal(normalizePreviewUrl('http://127.0.0.1/x'), null)
  assert.equal(normalizePreviewUrl('http://192.168.0.1/x'), null)
})

test('link preview는 HTML 메타 태그를 파싱한다', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    url: 'https://example.com/article',
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null
      }
    },
    async arrayBuffer() {
      const html = `
        <html><head>
          <meta property="og:title" content="미리보기 제목">
          <meta property="og:description" content="설명입니다">
          <meta property="og:image" content="/img.png">
          <meta property="og:site_name" content="Example">
          <title>무시</title>
        </head></html>
      `
      return Buffer.from(html, 'utf8')
    }
  })
  try {
    const preview = await fetchLinkPreview('https://example.com/article')
    assert.equal(preview.title, '미리보기 제목')
    assert.equal(preview.description, '설명입니다')
    assert.equal(preview.siteName, 'Example')
    assert.equal(preview.image, 'https://example.com/img.png')
    assert.equal(preview.url, 'https://example.com/article')
  } finally {
    globalThis.fetch = originalFetch
  }
})
