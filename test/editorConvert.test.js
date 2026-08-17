import test from 'node:test'
import assert from 'node:assert/strict'
import { convertEditorContent } from '../src/editorConvert.js'

test('같은 형식끼리는 본문을 그대로 둔다', () => {
  assert.equal(convertEditorContent('<p>안녕</p>', 'ckeditor', 'summernote'), '<p>안녕</p>')
  assert.equal(convertEditorContent('![그림](/api/files/a.png)', 'tui', 'markdown'), '![그림](/api/files/a.png)')
})

test('마크다운 이미지를 HTML 에디터에서 img 태그로 옮긴다', () => {
  const html = convertEditorContent(
    '메모\n\n![그림](/api/files/photo.png)',
    'tui',
    'ckeditor'
  )
  assert.match(html, /<p>메모<\/p>/)
  assert.match(html, /<img src="\/api\/files\/photo\.png" alt="그림">/)
  assert.doesNotMatch(html, /!\[그림\]/)
})

test('마크다운 이미지를 Editor.js image 블록으로 옮긴다', () => {
  const blocks = JSON.parse(convertEditorContent(
    '메모\n\n![](/api/files/photo.png)',
    'tui',
    'editorjs'
  )).blocks
  assert.equal(blocks[0].type, 'paragraph')
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].data.file.url, '/api/files/photo.png')
})

test('텍스트를 Editor.js 문단 블록으로 옮긴다', () => {
  const blocks = JSON.parse(convertEditorContent('첫 문단\n\n둘째 문단', 'textarea', 'editorjs')).blocks
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'paragraph')
  assert.match(blocks[0].data.text, /첫 문단/)
})
