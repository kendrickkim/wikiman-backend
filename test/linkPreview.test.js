import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/db.js'
import {
  clearLinkPreviewCache,
  fetchLinkPreview,
  getLinkPreviewCacheStats,
  normalizePreviewUrl
} from '../src/linkPreview.js'

test('link preview는 http(s)만 허용하고 내부 주소를 거부한다', () => {
  assert.equal(normalizePreviewUrl('https://example.com/a').hostname, 'example.com')
  assert.equal(normalizePreviewUrl('ftp://example.com'), null)
  assert.equal(normalizePreviewUrl('http://localhost/x'), null)
  assert.equal(normalizePreviewUrl('http://127.0.0.1/x'), null)
  assert.equal(normalizePreviewUrl('http://192.168.0.1/x'), null)
})

test('link preview는 HTML 메타 태그를 파싱하고 DB에 캐시한다', async () => {
  clearLinkPreviewCache()
  let fetchCount = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    fetchCount += 1
    return {
      ok: true,
      status: 200,
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
    }
  }
  try {
    const preview = await fetchLinkPreview('https://example.com/article')
    assert.equal(preview.title, '미리보기 제목')
    assert.equal(preview.description, '설명입니다')
    assert.equal(preview.siteName, 'Example')
    assert.equal(preview.image, 'https://example.com/img.png')
    assert.equal(preview.url, 'https://example.com/article')
    assert.equal(fetchCount, 1)

    const cached = await fetchLinkPreview('https://example.com/article')
    assert.equal(cached.title, '미리보기 제목')
    assert.equal(fetchCount, 1)

    db.prepare(`
      UPDATE link_preview_cache
      SET fetched_at = datetime('now', '-11 days')
      WHERE url = ?
    `).run('https://example.com/article')
    globalThis.fetch = async () => {
      fetchCount += 1
      throw new Error('외부 사이트 연결 실패')
    }
    const staleFallback = await fetchLinkPreview('https://example.com/article')
    assert.equal(staleFallback.title, '미리보기 제목')
    assert.equal(fetchCount, 2)
    const extended = await fetchLinkPreview('https://example.com/article')
    assert.equal(extended.title, '미리보기 제목')
    assert.equal(fetchCount, 2)

    const stats = getLinkPreviewCacheStats()
    assert.equal(stats.count, 1)
    assert.equal(stats.ttlDays, 10)
    assert.equal(stats.failureTtlDays, 1)

    const cleared = clearLinkPreviewCache()
    assert.equal(cleared.deleted, 1)
    assert.equal(getLinkPreviewCacheStats().count, 0)
  } finally {
    globalThis.fetch = originalFetch
    clearLinkPreviewCache()
  }
})
