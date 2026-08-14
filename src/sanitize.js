const ALLOWED_TAGS = new Set([
  'a', 'p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'strike',
  'del', 'ins', 'sub', 'sup', 'mark', 'small', 'blockquote', 'pre', 'code',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'hr', 'img',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'figure', 'figcaption', 'section', 'article', 'header', 'footer', 'nav', 'main',
  'abbr', 'cite', 'q', 'kbd', 'samp', 'var', 'time', 'address'
])

const VOID_TAGS = new Set(['br', 'hr', 'img', 'col'])

const GLOBAL_ATTRS = new Set(['class', 'id', 'title'])

const TAG_ATTRS = {
  a: new Set(['href', 'target', 'rel', 'name']),
  img: new Set(['src', 'alt', 'width', 'height', 'loading']),
  td: new Set(['colspan', 'rowspan', 'align']),
  th: new Set(['colspan', 'rowspan', 'align', 'scope']),
  col: new Set(['span', 'width']),
  ol: new Set(['start', 'type']),
  li: new Set(['value']),
  time: new Set(['datetime']),
  blockquote: new Set(['cite']),
  q: new Set(['cite'])
}

function safeUrl(value, { allowDataImage = false } = {}) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const lower = raw.toLowerCase()
  if (lower.startsWith('javascript:') || lower.startsWith('vbscript:') || lower.startsWith('blob:')) {
    return ''
  }
  if (lower.startsWith('data:')) {
    if (allowDataImage && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(raw)) return raw
    return ''
  }
  if (/^(https?:|mailto:|\/|#|\.\/)/i.test(raw)) return raw
  return ''
}

function parseAttrs(raw, tag) {
  const allowed = new Set([...(TAG_ATTRS[tag] || []), ...GLOBAL_ATTRS])
  const out = []
  const re = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let match
  while ((match = re.exec(raw))) {
    const name = match[1].toLowerCase()
    if (name.startsWith('on') || name === 'style' || name.startsWith('xmlns')) continue
    if (!allowed.has(name)) continue
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    let next = value
    if (name === 'href' || name === 'src' || name === 'cite') {
      next = safeUrl(value, { allowDataImage: tag === 'img' && name === 'src' })
      if (!next) continue
    }
    if (name === 'target' && next !== '_blank' && next !== '_self') continue
    if (name === 'id' && !/^[a-zA-Z][\w:-]*$/.test(next)) continue
    if (name === 'class' && /[^a-zA-Z0-9_\-\s]/.test(next)) continue
    out.push(`${name}="${String(next).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
  }
  if (tag === 'a' && out.some((item) => item.startsWith('target=')) && !out.some((item) => item.startsWith('rel='))) {
    out.push('rel="noopener noreferrer"')
  }
  return out
}

export function sanitizeHtml(input) {
  const html = String(input || '')
  if (!html) return ''
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?([a-zA-Z][a-zA-Z0-9:-]*)\b([^>]*)>/g, (full, rawName, rawAttrs) => {
    const closing = full.startsWith('</')
    const name = String(rawName || '').toLowerCase()
    if (name === 'script' || name === 'style' || name === 'iframe' || name === 'object'
      || name === 'embed' || name === 'form' || name === 'input' || name === 'textarea'
      || name === 'button' || name === 'link' || name === 'meta' || name === 'base'
      || name === 'svg' || name === 'math' || name === 'video' || name === 'audio') {
      return ''
    }
    if (!ALLOWED_TAGS.has(name)) return ''
    if (closing) return `</${name}>`
    const attrs = parseAttrs(rawAttrs || '', name)
    const attrText = attrs.length ? ` ${attrs.join(' ')}` : ''
    if (VOID_TAGS.has(name)) return `<${name}${attrText}>`
    return `<${name}${attrText}>`
  }).replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
}

function sanitizeEditorJsValue(value) {
  if (typeof value === 'string') return sanitizeHtml(value)
  if (Array.isArray(value)) return value.map(sanitizeEditorJsValue)
  if (value && typeof value === 'object') {
    const next = {}
    for (const [key, item] of Object.entries(value)) {
      if (key === 'url' || key === 'src' || key === 'href') {
        next[key] = safeUrl(item, { allowDataImage: true })
      } else {
        next[key] = sanitizeEditorJsValue(item)
      }
    }
    return next
  }
  return value
}

export function sanitizePostContent(editorType, content) {
  const type = String(editorType || '')
  const raw = content == null ? '' : String(content)
  if (type === 'html' || type === 'ckeditor') return sanitizeHtml(raw)
  if (type === 'editorjs') {
    try {
      const parsed = JSON.parse(raw || '{"blocks":[]}')
      return JSON.stringify(sanitizeEditorJsValue(parsed))
    } catch {
      return raw
    }
  }
  return raw
}
