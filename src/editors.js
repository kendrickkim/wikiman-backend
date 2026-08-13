export const EDITOR_TYPES = ['editorjs', 'markdown', 'html']

export function normalizeEditorType(value, fallback = 'editorjs') {
  return EDITOR_TYPES.includes(value) ? value : fallback
}

export function emptyEditorContent(editorType) {
  return editorType === 'editorjs' ? '{"blocks":[]}' : ''
}
