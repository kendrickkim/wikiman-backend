import fs from 'node:fs'
import path from 'node:path'
import { uploadsDir } from './db.js'

const MONTH_DIR_RE = /^\d{4}-\d{2}$/

export function monthFolderName(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

export function sanitizeStoredName(storedName) {
  const name = path.basename(String(storedName || ''))
  if (!name || name.includes('..')) return ''
  return name
}

/** Flat first, then YYYY-MM subfolders. Returns absolute path or ''. */
export function resolveUploadPath(storedName) {
  const name = sanitizeStoredName(storedName)
  if (!name) return ''

  const flat = path.join(uploadsDir, name)
  if (!flat.startsWith(uploadsDir)) return ''
  if (fs.existsSync(flat) && fs.statSync(flat).isFile()) return flat

  if (!fs.existsSync(uploadsDir)) return ''
  for (const entry of fs.readdirSync(uploadsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !MONTH_DIR_RE.test(entry.name)) continue
    const candidate = path.join(uploadsDir, entry.name, name)
    if (!candidate.startsWith(uploadsDir)) continue
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return ''
}

export function ensureMonthUploadDir(date = new Date()) {
  const dir = path.join(uploadsDir, monthFolderName(date))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Walk flat files and YYYY-MM/* files under uploads.
 * `name` is always the basename used in DB/URLs.
 */
export function walkUploadFiles() {
  if (!fs.existsSync(uploadsDir)) return []
  const files = []

  for (const entry of fs.readdirSync(uploadsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const abs = path.join(uploadsDir, entry.name)
    if (entry.isFile()) {
      try {
        files.push({ name: entry.name, abs, size: fs.statSync(abs).size })
      } catch {
        // ignore
      }
      continue
    }
    if (!entry.isDirectory() || !MONTH_DIR_RE.test(entry.name)) continue
    for (const child of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!child.isFile() || child.name.startsWith('.')) continue
      const childAbs = path.join(abs, child.name)
      try {
        files.push({ name: child.name, abs: childAbs, size: fs.statSync(childAbs).size })
      } catch {
        // ignore
      }
    }
  }

  files.sort((a, b) => a.name.localeCompare(b.name, 'ko'))
  return files
}
