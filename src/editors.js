export const EDITOR_TYPES = ['ckeditor', 'summernote', 'editorjs', 'markdown', 'html']

export function normalizeEditorType(value, fallback = 'ckeditor') {
  return EDITOR_TYPES.includes(value) ? value : fallback
}

export function emptyEditorContent(editorType) {
  return editorType === 'editorjs' ? '{"blocks":[]}' : ''
}
