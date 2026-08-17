const EMPTY_EDITORJS = '{"blocks":[]}'

const EDITOR_KINDS = {
  textarea: 'text',
  ckeditor: 'html',
  summernote: 'html',
  html: 'html',
  tui: 'markdown',
  markdown: 'markdown',
  editorjs: 'editorjs'
}

const KEEP_INLINE_TAGS = new Set(['a', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'mark', 'code', 'br'])
const IMAGE_MD_RE = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^)\s]+))\s*(?:"[^"]*")?\)/g

export function editorKind(editorType) {
  return EDITOR_KINDS[editorType] || 'html'
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
}

function textToHtml(text) {
  const value = String(text ?? '')
  if (!value.trim()) return ''
  return value
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
}

function htmlToText(html) {
  const value = String(html ?? '')
  if (!value.trim()) return ''
  return decodeEntities(
    value
      .replace(/<\s*(br|hr)\s*\/?>/gi, '\n')
      .replace(/<\/\s*(p|div|li|tr|h[1-6]|pre|blockquote|figure|figcaption)\s*>/gi, '\n')
      .replace(/<\s*li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function parseBlocks(content) {
  try {
    const parsed = JSON.parse(content || EMPTY_EDITORJS)
    if (Array.isArray(parsed)) return parsed
    return Array.isArray(parsed?.blocks) ? parsed.blocks : []
  } catch {
    return []
  }
}

function listItemContent(item) {
  if (typeof item === 'string') return item
  return item?.content ?? item?.text ?? ''
}

function listToHtml(items, style) {
  if (!Array.isArray(items) || !items.length) return ''
  const tag = style === 'ordered' ? 'ol' : 'ul'
  const body = items.map((item) => {
    const children = listToHtml(item?.items || [], style)
    return `<li>${listItemContent(item)}${children}</li>`
  }).join('')
  return `<${tag}>${body}</${tag}>`
}

function editorjsToHtml(content) {
  return parseBlocks(content).map((block) => {
    const data = block?.data || {}
    switch (block?.type) {
      case 'header': {
        const level = Math.min(Math.max(Number(data.level) || 2, 1), 6)
        return `<h${level}>${data.text || ''}</h${level}>`
      }
      case 'list':
        return listToHtml(data.items || [], data.style || 'unordered')
      case 'code':
        return `<pre><code>${escapeHtml(data.code || '')}</code></pre>`
      case 'image': {
        const url = data.file?.url || data.url || ''
        if (!url) return data.caption ? `<p>${data.caption}</p>` : ''
        const caption = data.caption ? `<figcaption>${escapeHtml(data.caption)}</figcaption>` : ''
        return `<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(data.caption || '')}">${caption}</figure>`
      }
      case 'paragraph':
        return `<p>${data.text || ''}</p>`
      default: {
        const text = data.text || data.caption || data.code || ''
        return text ? `<p>${text}</p>` : ''
      }
    }
  }).filter(Boolean).join('\n')
}

function keepInlineOnly(html) {
  return String(html ?? '').replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (full, rawName) => {
    const name = String(rawName).toLowerCase()
    if (!KEEP_INLINE_TAGS.has(name)) return ''
    if (name === 'br') return '<br>'
    if (name === 'a') return full.startsWith('</') ? '</a>' : full
    return full.startsWith('</') ? `</${name}>` : `<${name}>`
  }).trim()
}

function paragraphBlock(text) {
  const value = String(text ?? '').trim()
  return value ? { type: 'paragraph', data: { text: value } } : null
}

function attrValue(tag, name) {
  const match = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return match?.[1] || match?.[2] || match?.[3] || ''
}

function imageBlockFromHtml(html) {
  const src = attrValue(html, 'src')
  if (!src) return null
  return {
    type: 'image',
    data: {
      file: { url: src },
      caption: attrValue(html, 'alt') || ''
    }
  }
}

function pushHtmlElement(blocks, html) {
  const value = String(html || '').trim()
  if (!value) return
  if (/^<img\b/i.test(value) || /<img\b/i.test(value)) {
    const image = imageBlockFromHtml(value)
    if (image) blocks.push(image)
    return
  }
  const heading = value.match(/^<h([1-6])\b[^>]*>([\s\S]*)<\/h\1>$/i)
  if (heading) {
    const text = keepInlineOnly(heading[2])
    if (text) blocks.push({ type: 'header', data: { text, level: Number(heading[1]) } })
    return
  }
  const pre = value.match(/^<pre\b[^>]*>([\s\S]*)<\/pre>$/i)
  if (pre) {
    const code = htmlToText(pre[1])
    if (code.trim()) blocks.push({ type: 'code', data: { code } })
    return
  }
  const list = value.match(/^<(ul|ol)\b[^>]*>([\s\S]*)<\/\1>$/i)
  if (list) {
    const items = [...String(list[2]).matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
      .map((item) => paragraphBlock(`- ${keepInlineOnly(item[1])}`))
      .filter(Boolean)
    blocks.push(...items)
    return
  }
  const inner = value.replace(/^<[a-zA-Z][a-zA-Z0-9]*\b[^>]*>/, '').replace(/<\/[a-zA-Z][a-zA-Z0-9]*>$/, '')
  const paragraph = paragraphBlock(keepInlineOnly(inner || value))
  if (paragraph) blocks.push(paragraph)
}

function htmlToEditorjs(html) {
  const value = String(html ?? '')
  if (!value.trim()) return EMPTY_EDITORJS
  const blocks = []
  const re = /<figure\b[\s\S]*?<\/figure>|<img\b[^>]*>|<(h[1-6]|p|pre|ul|ol|blockquote|div|section)\b[^>]*>[\s\S]*?<\/\1>/gi
  let last = 0
  let match
  while ((match = re.exec(value))) {
    const before = value.slice(last, match.index).trim()
    if (before) {
      const text = htmlToText(before)
      const fallback = paragraphBlock(escapeHtml(text).replace(/\n/g, '<br>'))
      if (fallback) blocks.push(fallback)
    }
    pushHtmlElement(blocks, match[0])
    last = match.index + match[0].length
  }
  const after = value.slice(last).trim()
  if (after) {
    const text = htmlToText(after)
    const fallback = paragraphBlock(escapeHtml(text).replace(/\n/g, '<br>'))
    if (fallback) blocks.push(fallback)
  }
  if (!blocks.length) {
    const text = htmlToText(value)
    const fallback = paragraphBlock(escapeHtml(text).replace(/\n/g, '<br>'))
    return JSON.stringify({ blocks: fallback ? [fallback] : [] })
  }
  return JSON.stringify({ blocks })
}

function restorePlaceholders(text, placeholders) {
  return String(text).replace(/\u0000([A-Z]+)(\d+)\u0000/g, (_, kind, index) => {
    return placeholders[`${kind}${index}`] || ''
  })
}

function markdownToHtml(source) {
  const placeholders = {}
  let index = 0
  let text = String(source ?? '').replace(/```[\s\S]*?```/g, (block) => {
    const key = `CODE${index}`
    placeholders[key] = `<pre><code>${escapeHtml(block.replace(/^```[^\n]*\n?/, '').replace(/```$/, ''))}</code></pre>`
    index += 1
    return `\u0000${key}\u0000`
  })
  text = text.replace(IMAGE_MD_RE, (_, alt, url1, url2) => {
    const key = `IMG${index}`
    const url = url1 || url2 || ''
    placeholders[key] = `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}">`
    index += 1
    return `\u0000${key}\u0000`
  })
  const paragraphs = text.split(/\n{2,}/).map((para) => para.trim()).filter(Boolean)
  return paragraphs.map((para) => {
    const restoredInline = (value) => restorePlaceholders(
      escapeHtml(value).replace(/\n/g, '<br>'),
      placeholders
    )
    if (/^\u0000CODE\d+\u0000$/.test(para)) return restorePlaceholders(para, placeholders)
    if (/^#{1,6}\s+/.test(para)) {
      const heading = para.match(/^(#{1,6})\s+([\s\S]+)$/)
      const level = heading[1].length
      return `<h${level}>${restoredInline(heading[2])}</h${level}>`
    }
    return `<p>${restoredInline(para)}</p>`
  }).join('\n')
}

function markdownToEditorjs(source) {
  const blocks = []
  const protectedSource = String(source ?? '').replace(/```[\s\S]*?```/g, (block) => {
    const code = block.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')
    if (code.trim()) blocks.push({ type: 'code', data: { code } })
    return '\n\n'
  })
  for (const para of protectedSource.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)) {
    const images = [...para.matchAll(new RegExp(IMAGE_MD_RE.source, 'g'))]
    const withoutImages = para.replace(new RegExp(IMAGE_MD_RE.source, 'g'), '').trim()
    if (images.length && !withoutImages) {
      for (const image of images) {
        const url = image[2] || image[3] || ''
        if (url) {
          blocks.push({
            type: 'image',
            data: { file: { url }, caption: image[1] || '' }
          })
        }
      }
      continue
    }
    if (images.length) {
      const nested = JSON.parse(htmlToEditorjs(markdownToHtml(para))).blocks || []
      blocks.push(...nested)
      continue
    }
    if (/^#{1,6}\s+/.test(para)) {
      const heading = para.match(/^(#{1,6})\s+([\s\S]+)$/)
      blocks.push({
        type: 'header',
        data: { text: escapeHtml(heading[2]), level: heading[1].length }
      })
      continue
    }
    const paragraph = paragraphBlock(escapeHtml(para).replace(/\n/g, '<br>'))
    if (paragraph) blocks.push(paragraph)
  }
  return JSON.stringify({ blocks })
}

export function convertEditorContent(content, fromType, toType) {
  const from = editorKind(fromType)
  const to = editorKind(toType)
  const source = String(content ?? '')
  if (!source.trim() || (from === 'editorjs' && !parseBlocks(source).length)) {
    return to === 'editorjs' ? EMPTY_EDITORJS : ''
  }
  if (from === to) return source

  if (to === 'text') {
    if (from === 'markdown') return source
    if (from === 'editorjs') return htmlToText(editorjsToHtml(source))
    return htmlToText(source)
  }

  if (to === 'markdown') {
    if (from === 'text') return source
    if (from === 'editorjs') return editorjsToHtml(source)
    return source
  }

  if (to === 'editorjs') {
    if (from === 'text') return htmlToEditorjs(textToHtml(source))
    if (from === 'markdown') return markdownToEditorjs(source)
    return htmlToEditorjs(source)
  }

  if (from === 'text') return textToHtml(source)
  if (from === 'markdown') return markdownToHtml(source)
  if (from === 'editorjs') return editorjsToHtml(source)
  return source
}
