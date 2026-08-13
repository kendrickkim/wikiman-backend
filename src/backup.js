import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import Database from 'better-sqlite3'
import { checkpointDatabase, dataDir, db, dbPath, uploadsDir } from './db.js'

export const BACKUP_EXTENSION = '.wkmbak'
export const BACKUP_MAGIC = Buffer.from('WIKIMNBK') // 정확히 8바이트
export const BACKUP_FORMAT_VERSION = 1
export const BACKUP_SCHEMA_VERSION = 1

/** 복구 전 반드시 있어야 하는 테이블·컬럼 */
export const REQUIRED_SCHEMA = {
  users: ['id', 'username', 'password_hash', 'role'],
  categories: ['id', 'name'],
  posts: ['id', 'title', 'slug', 'author_id', 'visibility', 'status', 'editor_type', 'content'],
  settings: ['key', 'value'],
  post_keywords: ['post_id', 'keyword'],
  post_attachments: ['id', 'post_id', 'stored_name', 'original_name', 'mime_type', 'size']
}

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status })
}

function readUInt32LE(buf, offset) {
  return buf.readUInt32LE(offset)
}

function writeUInt32LE(value) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(value >>> 0, 0)
  return buf
}

function writeUInt64LE(value) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(BigInt(value), 0)
  return buf
}

function readUInt64LE(buf, offset) {
  return Number(buf.readBigUInt64LE(offset))
}

export function collectSchemaSnapshot(database = db) {
  const tables = {}
  for (const name of Object.keys(REQUIRED_SCHEMA)) {
    const rows = database.prepare(`PRAGMA table_info(${name})`).all()
    tables[name] = rows.map((row) => row.name)
  }
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    tables
  }
}

export function validateSchemaSnapshot(schema) {
  if (!schema || typeof schema !== 'object') {
    fail('백업 메타데이터에 스키마 정보가 없습니다.')
  }
  const schemaVersion = Number(schema.schemaVersion)
  if (!Number.isFinite(schemaVersion) || schemaVersion < 1) {
    fail('지원하지 않는 스키마 버전입니다.')
  }
  if (schemaVersion > BACKUP_SCHEMA_VERSION) {
    fail(`이 백업은 스키마 버전 ${schemaVersion}입니다. 현재 앱은 ${BACKUP_SCHEMA_VERSION}까지 지원합니다.`)
  }
  const tables = schema.tables || {}
  for (const [table, columns] of Object.entries(REQUIRED_SCHEMA)) {
    const actual = tables[table]
    if (!Array.isArray(actual) || !actual.length) {
      fail(`백업 DB에 필수 테이블이 없습니다: ${table}`)
    }
    for (const column of columns) {
      if (!actual.includes(column)) {
        fail(`백업 DB의 ${table} 테이블에 필수 컬럼이 없습니다: ${column}`)
      }
    }
  }
}

export function validateDatabaseFile(dbFilePath) {
  let probe = null
  try {
    probe = new Database(dbFilePath, { readonly: true, fileMustExist: true })
    const names = new Set(
      probe.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all().map((row) => row.name)
    )
    for (const table of Object.keys(REQUIRED_SCHEMA)) {
      if (!names.has(table)) {
        fail(`복구 대상 DB에 필수 테이블이 없습니다: ${table}`)
      }
      const columns = probe.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)
      for (const column of REQUIRED_SCHEMA[table]) {
        if (!columns.includes(column)) {
          fail(`복구 대상 DB의 ${table} 테이블에 필수 컬럼이 없습니다: ${column}`)
        }
      }
    }
    // 간단한 무결성 검사
    const integrity = probe.pragma('integrity_check', { simple: true })
    if (integrity !== 'ok') {
      fail('복구 대상 DB 무결성 검사에 실패했습니다.')
    }
  } catch (err) {
    if (err.status) throw err
    fail(`백업 DB를 열 수 없습니다: ${err.message}`)
  } finally {
    try {
      probe?.close()
    } catch {
      // ignore
    }
  }
}

function listUploadFiles() {
  if (!fs.existsSync(uploadsDir)) return []
  return fs.readdirSync(uploadsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
}

async function buildFileList() {
  const files = []
  const dbStat = await fsp.stat(dbPath)
  files.push({ path: 'wiki.db', abs: dbPath, size: dbStat.size })

  for (const name of listUploadFiles()) {
    const abs = path.join(uploadsDir, name)
    const stat = await fsp.stat(abs)
    files.push({ path: `uploads/${name}`, abs, size: stat.size })
  }
  return files
}

/** 백업 파일을 outPath에 생성합니다. */
export async function createBackupFile(outPath) {
  checkpointDatabase()
  const files = await buildFileList()
  const schema = collectSchemaSnapshot()
  const meta = {
    app: 'wikiman',
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    files: files.map((file) => ({ path: file.path, size: file.size })),
    schema
  }

  const metaJson = Buffer.from(JSON.stringify(meta), 'utf8')
  if (metaJson.length > 16 * 1024 * 1024) {
    fail('백업 메타데이터가 너무 큽니다.', 500)
  }

  const hash = crypto.createHash('sha256')
  const gzip = zlib.createGzip({ level: 6 })
  const fd = fs.openSync(outPath, 'w')
  try {
    fs.writeSync(fd, BACKUP_MAGIC)
    fs.writeSync(fd, writeUInt32LE(BACKUP_FORMAT_VERSION))
    fs.writeSync(fd, writeUInt32LE(metaJson.length))
    fs.writeSync(fd, metaJson)
  } finally {
    fs.closeSync(fd)
  }

  const out = fs.createWriteStream(outPath, { flags: 'a' })
  const hasher = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk)
      cb(null, chunk)
    }
  })

  const payloadSource = Readable.from((async function* () {
    for (const file of files) {
      const nameBuf = Buffer.from(file.path, 'utf8')
      if (nameBuf.length > 65535) fail(`경로가 너무 깁니다: ${file.path}`, 500)
      yield writeUInt32LE(nameBuf.length)
      yield nameBuf
      yield writeUInt64LE(file.size)
      const handle = await fsp.open(file.abs, 'r')
      try {
        let remaining = file.size
        const chunkSize = 1024 * 1024
        while (remaining > 0) {
          const toRead = Math.min(chunkSize, remaining)
          const buf = Buffer.alloc(toRead)
          const { bytesRead } = await handle.read(buf, 0, toRead, null)
          if (!bytesRead) break
          remaining -= bytesRead
          yield buf.subarray(0, bytesRead)
        }
        if (remaining !== 0) {
          fail(`파일 크기가 일치하지 않습니다: ${file.path}`, 500)
        }
      } finally {
        await handle.close()
      }
    }
  })())

  await pipeline(payloadSource, gzip, hasher, out)

  const digest = hash.digest('hex')
  const footer = Buffer.concat([
    Buffer.from('WKCK'),
    Buffer.from(digest, 'utf8')
  ])
  await fsp.appendFile(outPath, footer)

  return {
    ...meta,
    payloadSha256: digest,
    path: outPath
  }
}

function parseHeader(buffer) {
  if (buffer.length < 16) fail('백업 파일이 너무 짧습니다.')
  const magic = buffer.subarray(0, 8)
  if (!magic.equals(BACKUP_MAGIC)) {
    fail('Wikiman 백업 파일(.wkmbak)이 아닙니다.')
  }
  const formatVersion = readUInt32LE(buffer, 8)
  if (formatVersion < 1) fail('지원하지 않는 백업 형식 버전입니다.')
  if (formatVersion > BACKUP_FORMAT_VERSION) {
    fail(`이 백업은 형식 버전 ${formatVersion}입니다. 현재 앱은 ${BACKUP_FORMAT_VERSION}까지 지원합니다.`)
  }
  const metaLen = readUInt32LE(buffer, 12)
  if (metaLen < 2 || metaLen > 16 * 1024 * 1024) fail('백업 헤더가 올바르지 않습니다.')
  if (buffer.length < 16 + metaLen) fail('백업 헤더가 손상되었습니다.')
  let meta
  try {
    meta = JSON.parse(buffer.subarray(16, 16 + metaLen).toString('utf8'))
  } catch {
    fail('백업 헤더 JSON을 읽을 수 없습니다.')
  }
  if (meta.app !== 'wikiman') fail('Wikiman 백업 파일이 아닙니다.')
  if (Number(meta.formatVersion) !== formatVersion) {
    fail('백업 헤더의 형식 버전이 일치하지 않습니다.')
  }
  validateSchemaSnapshot(meta.schema)
  return {
    formatVersion,
    meta,
    payloadOffset: 16 + metaLen
  }
}

async function readBackupFile(filePath) {
  const buffer = await fsp.readFile(filePath)
  const header = parseHeader(buffer)
  let payloadEnd = buffer.length
  let payloadSha256 = null
  if (buffer.length >= header.payloadOffset + 4 + 64) {
    const footerStart = buffer.length - 4 - 64
    if (buffer.subarray(footerStart, footerStart + 4).toString('utf8') === 'WKCK') {
      payloadSha256 = buffer.subarray(footerStart + 4).toString('utf8')
      payloadEnd = footerStart
    }
  }
  const payload = buffer.subarray(header.payloadOffset, payloadEnd)
  if (payloadSha256) {
    const actual = crypto.createHash('sha256').update(payload).digest('hex')
    if (actual !== payloadSha256) {
      fail('백업 파일 체크섬이 일치하지 않습니다. 파일이 손상되었을 수 있습니다.')
    }
  }
  return { ...header, payload, payloadSha256 }
}

function inflatePayload(payload) {
  try {
    return zlib.gunzipSync(payload)
  } catch {
    fail('백업 본문을 압축 해제할 수 없습니다. 파일이 손상되었을 수 있습니다.')
  }
}

function extractEntries(raw, expectedFiles) {
  const entries = new Map()
  let offset = 0
  while (offset < raw.length) {
    if (offset + 4 > raw.length) fail('백업 본문이 손상되었습니다.')
    const nameLen = readUInt32LE(raw, offset)
    offset += 4
    if (nameLen < 1 || offset + nameLen + 8 > raw.length) fail('백업 본문의 파일 항목이 손상되었습니다.')
    const relPath = raw.subarray(offset, offset + nameLen).toString('utf8')
    offset += nameLen
    const size = readUInt64LE(raw, offset)
    offset += 8
    if (size < 0 || offset + size > raw.length) fail(`백업 파일 항목 크기가 올바르지 않습니다: ${relPath}`)
    if (relPath.includes('..') || path.isAbsolute(relPath) || relPath.includes('\\')) {
      fail(`허용되지 않는 백업 경로입니다: ${relPath}`)
    }
    if (!relPath.startsWith('uploads/') && relPath !== 'wiki.db') {
      fail(`허용되지 않는 백업 경로입니다: ${relPath}`)
    }
    entries.set(relPath, raw.subarray(offset, offset + size))
    offset += size
  }

  if (!Array.isArray(expectedFiles) || !expectedFiles.length) {
    fail('백업 메타데이터에 파일 목록이 없습니다.')
  }
  for (const file of expectedFiles) {
    const data = entries.get(file.path)
    if (!data) fail(`백업에 파일이 없습니다: ${file.path}`)
    if (data.length !== Number(file.size)) {
      fail(`백업 파일 크기가 메타데이터와 다릅니다: ${file.path}`)
    }
  }
  if (!entries.has('wiki.db')) fail('백업에 wiki.db가 없습니다.')
  return entries
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true })
}

function emptyUploadsDir() {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true })
    return
  }
  for (const entry of fs.readdirSync(uploadsDir, { withFileTypes: true })) {
    rmrf(path.join(uploadsDir, entry.name))
  }
}

/** 검사만 수행. 복구하지 않습니다. */
export async function inspectBackupFile(filePath) {
  const { formatVersion, meta, payloadSha256, payload } = await readBackupFile(filePath)
  const inflated = inflatePayload(payload)
  const entries = extractEntries(inflated, meta.files)

  const tmpDir = path.join(dataDir, `.backup-inspect-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  try {
    const tmpDb = path.join(tmpDir, 'wiki.db')
    await fsp.writeFile(tmpDb, entries.get('wiki.db'))
    validateDatabaseFile(tmpDb)
  } finally {
    rmrf(tmpDir)
  }

  return {
    ok: true,
    formatVersion,
    schemaVersion: meta.schemaVersion,
    createdAt: meta.createdAt,
    fileCount: meta.fileCount,
    totalBytes: meta.totalBytes,
    uploadCount: Math.max(0, (meta.fileCount || 1) - 1),
    payloadSha256: payloadSha256 || null
  }
}

/**
 * 백업으로 현재 데이터를 덮어씁니다.
 * 호출 전에 DB 연결을 닫아야 합니다. 성공 후 호출측에서 reopenDatabase() 합니다.
 */
export async function restoreBackupFile(filePath) {
  const { meta, payload } = await readBackupFile(filePath)
  const inflated = inflatePayload(payload)
  const entries = extractEntries(inflated, meta.files)

  const staging = path.join(dataDir, `.backup-restore-${Date.now()}`)
  const stagingUploads = path.join(staging, 'uploads')
  fs.mkdirSync(stagingUploads, { recursive: true })

  try {
    const stagedDb = path.join(staging, 'wiki.db')
    await fsp.writeFile(stagedDb, entries.get('wiki.db'))
    validateDatabaseFile(stagedDb)

    for (const [relPath, data] of entries) {
      if (relPath === 'wiki.db') continue
      const name = path.basename(relPath)
      if (!name || name !== path.basename(relPath)) continue
      await fsp.writeFile(path.join(stagingUploads, name), data)
    }

    for (const side of ['wiki.db-wal', 'wiki.db-shm']) {
      const sidePath = path.join(dataDir, side)
      try {
        if (fs.existsSync(sidePath)) fs.unlinkSync(sidePath)
      } catch {
        // ignore
      }
    }

    const safetyDb = path.join(dataDir, 'wiki.db.prerestore')
    try {
      if (fs.existsSync(dbPath)) {
        await fsp.copyFile(dbPath, safetyDb)
      }
    } catch {
      // 안전 복사 실패해도 복구는 시도
    }

    try {
      await fsp.copyFile(stagedDb, dbPath)
    } catch (err) {
      fail(`데이터베이스 파일을 교체할 수 없습니다. 서버가 DB를 사용 중일 수 있습니다: ${err.message}`, 500)
    }

    emptyUploadsDir()
    for (const name of fs.readdirSync(stagingUploads)) {
      await fsp.copyFile(path.join(stagingUploads, name), path.join(uploadsDir, name))
    }

    try {
      if (fs.existsSync(safetyDb)) fs.unlinkSync(safetyDb)
    } catch {
      // ignore
    }
  } finally {
    rmrf(staging)
  }

  return {
    ok: true,
    formatVersion: meta.formatVersion,
    schemaVersion: meta.schemaVersion,
    createdAt: meta.createdAt,
    fileCount: meta.fileCount,
    totalBytes: meta.totalBytes,
    uploadCount: Math.max(0, (meta.fileCount || 1) - 1)
  }
}
