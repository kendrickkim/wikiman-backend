import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { dataDir } from './db.js'
import { getThumbnailCacheDays } from './settings.js'
import { sanitizeStoredName, walkUploadFiles } from './uploadPaths.js'
import { sendUploadFile } from './files.js'

export const thumbnailsDir = path.join(dataDir, 'thumbnails')
const MAX_WIDTH = 400
const DAY_MS = 24 * 60 * 60 * 1000
const pending = new Map()

function cacheKey(storedName) {
  const name = sanitizeStoredName(storedName)
  if (!name) return ''
  return `${crypto.createHash('sha256').update(name).digest('hex')}.webp`
}

export function thumbnailPath(storedName) {
  const key = cacheKey(storedName)
  return key ? path.join(thumbnailsDir, key) : ''
}

export function removeCachedThumbnail(storedName) {
  const filePath = thumbnailPath(storedName)
  if (!filePath) return
  try {
    fs.unlinkSync(filePath)
  } catch {
    // Missing cache files need no cleanup.
  }
}

export function cleanupOrphanThumbnails() {
  if (!fs.existsSync(thumbnailsDir)) return
  const retained = new Set(walkUploadFiles().map((file) => path.basename(thumbnailPath(file.name))))
  for (const entry of fs.readdirSync(thumbnailsDir, { withFileTypes: true })) {
    if (!entry.isFile() || retained.has(entry.name)) continue
    try {
      fs.unlinkSync(path.join(thumbnailsDir, entry.name))
    } catch {
      // Best-effort cache cleanup must not fail source cleanup.
    }
  }
}

function isFresh(sourceStat, thumbnailStat, ttlDays) {
  return thumbnailStat.mtimeMs >= sourceStat.mtimeMs
    && Date.now() - thumbnailStat.mtimeMs <= ttlDays * DAY_MS
}

async function generateThumbnail(sourcePath, destination) {
  fs.mkdirSync(thumbnailsDir, { recursive: true })
  const temporary = `${destination}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    await sharp(sourcePath, { failOn: 'error' })
      .rotate()
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .webp()
      .toFile(temporary)
    fs.renameSync(temporary, destination)
  } finally {
    try {
      fs.unlinkSync(temporary)
    } catch {
      // The rename already removed it, or generation never created it.
    }
  }
}

async function ensureThumbnail(sourcePath, storedName, ttlDays) {
  const destination = thumbnailPath(storedName)
  if (!destination) throw new Error('INVALID_STORED_NAME')
  const sourceStat = fs.statSync(sourcePath)
  try {
    const thumbnailStat = fs.statSync(destination)
    if (isFresh(sourceStat, thumbnailStat, ttlDays)) return destination
  } catch {
    // Generate a missing thumbnail.
  }

  if (!pending.has(destination)) {
    pending.set(destination, generateThumbnail(sourcePath, destination).finally(() => pending.delete(destination)))
  }
  await pending.get(destination)
  return destination
}

function etagFor(stat) {
  return `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`
}

function isNotModified(req, etag, mtime) {
  const noneMatch = String(req.headers['if-none-match'] || '')
  if (noneMatch.split(',').map((value) => value.trim()).includes(etag)) return true
  if (noneMatch) return false
  const modifiedSince = Date.parse(String(req.headers['if-modified-since'] || ''))
  return Number.isFinite(modifiedSince) && Math.trunc(mtime.getTime() / 1000) <= Math.trunc(modifiedSince / 1000)
}

function sendThumbnail(req, res, filePath, ttlDays) {
  const stat = fs.statSync(filePath)
  const etag = etagFor(stat)
  res.setHeader('Cache-Control', `public, max-age=${ttlDays * 86400}`)
  res.setHeader('ETag', etag)
  res.setHeader('Last-Modified', stat.mtime.toUTCString())
  if (isNotModified(req, etag, stat.mtime)) {
    res.status(304).end()
    return
  }
  sendUploadFile(res, filePath, { mimeType: 'image/webp' })
}

export async function sendThumbnailOrOriginal(req, res, sourcePath, storedName) {
  const ttlDays = getThumbnailCacheDays()
  try {
    const filePath = await ensureThumbnail(sourcePath, storedName, ttlDays)
    sendThumbnail(req, res, filePath, ttlDays)
  } catch {
    sendUploadFile(res, sourcePath)
  }
}
