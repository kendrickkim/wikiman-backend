import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import Database from 'better-sqlite3'
import { CURRENT_SCHEMA_VERSION, checkpointDatabase, dataDir, db, dbPath, uploadsDir } from './db.js'

export const BACKUP_EXTENSION = '.wkmbak'
export const BACKUP_MAGIC = Buffer.from('WIKIMNBK') // 정확히 8바이트
export const BACKUP_FORMAT_VERSION = 1
export const BACKUP_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION
const MAX_INFLATED_BYTES = 8 * 1024 * 1024 * 1024
const COPY_CHUNK = 1024 * 1024

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
    const integrity = probe.pragma('integrity_check', { simple: true })
    if (integrity !== 'ok') {
      fail('복구 대상 DB 무결성 검사에 실패했습니다.')
    }
    const fk = probe.pragma('foreign_key_check')
    if (Array.isArray(fk) && fk.length) {
      fail('복구 대상 DB 외래 키 검사에 실패했습니다.')
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
        while (remaining > 0) {
          const toRead = Math.min(COPY_CHUNK, remaining)
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

function parseHeaderBuffer(buffer) {
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

async function readBackupHeader(filePath) {
  const stat = await fsp.stat(filePath)
  if (stat.size < 16) fail('백업 파일이 너무 짧습니다.')
  const handle = await fsp.open(filePath, 'r')
  try {
    const prefix = Buffer.alloc(16)
    await handle.read(prefix, 0, 16, 0)
    const metaLen = readUInt32LE(prefix, 12)
    if (metaLen < 2 || metaLen > 16 * 1024 * 1024) fail('백업 헤더가 올바르지 않습니다.')
    if (stat.size < 16 + metaLen) fail('백업 헤더가 손상되었습니다.')
    const headerBuf = Buffer.alloc(16 + metaLen)
    await handle.read(headerBuf, 0, headerBuf.length, 0)
    const header = parseHeaderBuffer(headerBuf)

    let payloadEnd = stat.size
    let payloadSha256 = null
    if (stat.size >= header.payloadOffset + 4 + 64) {
      const footer = Buffer.alloc(68)
      await handle.read(footer, 0, 68, stat.size - 68)
      if (footer.subarray(0, 4).toString('utf8') === 'WKCK') {
        payloadSha256 = footer.subarray(4).toString('utf8')
        payloadEnd = stat.size - 68
      }
    }
    return { ...header, payloadEnd, payloadSha256, size: stat.size }
  } finally {
    await handle.close()
  }
}

function inflatedLimit(meta) {
  const total = Number(meta.totalBytes) || 0
  return Math.min(MAX_INFLATED_BYTES, Math.max(64 * 1024 * 1024, total + 64 * 1024 * 1024))
}

async function inflatePayloadToFile(srcPath, header, destPath) {
  const hash = crypto.createHash('sha256')
  let inflated = 0
  const maxBytes = inflatedLimit(header.meta)
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      inflated += chunk.length
      if (inflated > maxBytes) {
        cb(Object.assign(new Error('백업 압축 해제 크기가 한도를 초과했습니다.'), { status: 400 }))
        return
      }
      cb(null, chunk)
    }
  })
  const hasher = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk)
      cb(null, chunk)
    }
  })
  const input = fs.createReadStream(srcPath, {
    start: header.payloadOffset,
    end: header.payloadEnd - 1
  })
  try {
    await pipeline(input, hasher, zlib.createGunzip(), limiter, fs.createWriteStream(destPath))
  } catch (err) {
    if (err.status) throw err
    fail('백업 본문을 압축 해제할 수 없습니다. 파일이 손상되었을 수 있습니다.')
  }
  const digest = hash.digest('hex')
  if (header.payloadSha256 && digest !== header.payloadSha256) {
    fail('백업 파일 체크섬이 일치하지 않습니다. 파일이 손상되었을 수 있습니다.')
  }
  return digest
}

function assertRelPath(relPath) {
  if (relPath.includes('..') || path.isAbsolute(relPath) || relPath.includes('\\')) {
    fail(`허용되지 않는 백업 경로입니다: ${relPath}`)
  }
  if (!relPath.startsWith('uploads/') && relPath !== 'wiki.db') {
    fail(`허용되지 않는 백업 경로입니다: ${relPath}`)
  }
}

async function extractEntriesToDir(inflatedPath, expectedFiles, destDir) {
  const stagingUploads = path.join(destDir, 'uploads')
  await fsp.mkdir(stagingUploads, { recursive: true })
  const written = new Map()
  const handle = await fsp.open(inflatedPath, 'r')
  const stat = await fsp.stat(inflatedPath)
  let offset = 0
  try {
    while (offset < stat.size) {
      if (offset + 4 > stat.size) fail('백업 본문이 손상되었습니다.')
      const lenBuf = Buffer.alloc(4)
      await handle.read(lenBuf, 0, 4, offset)
      offset += 4
      const nameLen = readUInt32LE(lenBuf, 0)
      if (nameLen < 1 || offset + nameLen + 8 > stat.size) fail('백업 본문의 파일 항목이 손상되었습니다.')
      const nameBuf = Buffer.alloc(nameLen)
      await handle.read(nameBuf, 0, nameLen, offset)
      offset += nameLen
      const sizeBuf = Buffer.alloc(8)
      await handle.read(sizeBuf, 0, 8, offset)
      offset += 8
      const size = readUInt64LE(sizeBuf, 0)
      const relPath = nameBuf.toString('utf8')
      assertRelPath(relPath)
      if (size < 0 || offset + size > stat.size) fail(`백업 파일 항목 크기가 올바르지 않습니다: ${relPath}`)

      const outPath = relPath === 'wiki.db'
        ? path.join(destDir, 'wiki.db')
        : path.join(stagingUploads, path.basename(relPath))
      const out = await fsp.open(outPath, 'w')
      try {
        let remaining = size
        while (remaining > 0) {
          const toRead = Math.min(COPY_CHUNK, remaining)
          const buf = Buffer.alloc(toRead)
          const { bytesRead } = await handle.read(buf, 0, toRead, offset)
          if (!bytesRead) fail(`백업 파일 항목이 중간에 끝났습니다: ${relPath}`)
          await out.write(buf.subarray(0, bytesRead))
          offset += bytesRead
          remaining -= bytesRead
        }
      } finally {
        await out.close()
      }
      written.set(relPath, { path: outPath, size })
    }
  } finally {
    await handle.close()
  }

  if (!Array.isArray(expectedFiles) || !expectedFiles.length) {
    fail('백업 메타데이터에 파일 목록이 없습니다.')
  }
  for (const file of expectedFiles) {
    const entry = written.get(file.path)
    if (!entry) fail(`백업에 파일이 없습니다: ${file.path}`)
    if (entry.size !== Number(file.size)) {
      fail(`백업 파일 크기가 메타데이터와 다릅니다: ${file.path}`)
    }
  }
  if (!written.has('wiki.db')) fail('백업에 wiki.db가 없습니다.')
  return written
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true })
}

async function copyDirFiles(src, dest) {
  await fsp.mkdir(dest, { recursive: true })
  if (!fs.existsSync(src)) return
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    await fsp.copyFile(path.join(src, entry.name), path.join(dest, entry.name))
  }
}

async function emptyDir(target) {
  await fsp.mkdir(target, { recursive: true })
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    rmrf(path.join(target, entry.name))
  }
}

async function unpackBackup(filePath, destDir) {
  const header = await readBackupHeader(filePath)
  const inflatedPath = path.join(destDir, 'payload.bin')
  await fsp.mkdir(destDir, { recursive: true })
  const payloadSha256 = await inflatePayloadToFile(filePath, header, inflatedPath)
  await extractEntriesToDir(inflatedPath, header.meta.files, destDir)
  try {
    fs.unlinkSync(inflatedPath)
  } catch {
    // ignore
  }
  return { header, payloadSha256 }
}

/** 검사만 수행. 복구하지 않습니다. */
export async function inspectBackupFile(filePath) {
  const tmpDir = path.join(dataDir, `.backup-inspect-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  try {
    const { header, payloadSha256 } = await unpackBackup(filePath, tmpDir)
    validateDatabaseFile(path.join(tmpDir, 'wiki.db'))
    return {
      ok: true,
      formatVersion: header.formatVersion,
      schemaVersion: header.meta.schemaVersion,
      createdAt: header.meta.createdAt,
      fileCount: header.meta.fileCount,
      totalBytes: header.meta.totalBytes,
      uploadCount: Math.max(0, (header.meta.fileCount || 1) - 1),
      payloadSha256: payloadSha256 || header.payloadSha256 || null
    }
  } finally {
    rmrf(tmpDir)
  }
}

function unlinkIfExists(target) {
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target)
  } catch {
    // ignore
  }
}

/**
 * 백업으로 현재 데이터를 덮어씁니다.
 * 호출 전에 DB 연결을 닫아야 합니다. 성공 후 호출측에서 reopenDatabase() 합니다.
 */
export async function restoreBackupFile(filePath) {
  const staging = path.join(dataDir, `.backup-restore-${Date.now()}`)
  const safetyDb = path.join(dataDir, 'wiki.db.prerestore')
  const safetyUploads = path.join(dataDir, 'uploads.prerestore')
  let swapped = false
  try {
    const { header } = await unpackBackup(filePath, staging)
    const stagedDb = path.join(staging, 'wiki.db')
    const stagingUploads = path.join(staging, 'uploads')
    validateDatabaseFile(stagedDb)

    for (const side of ['wiki.db-wal', 'wiki.db-shm']) {
      unlinkIfExists(path.join(dataDir, side))
    }

    try {
      if (fs.existsSync(dbPath)) {
        await fsp.copyFile(dbPath, safetyDb)
      }
    } catch (err) {
      fail(`복구 전 데이터베이스를 복사하지 못했습니다: ${err.message}`, 500)
    }

    try {
      rmrf(safetyUploads)
      if (fs.existsSync(uploadsDir)) {
        await copyDirFiles(uploadsDir, safetyUploads)
      }
    } catch (err) {
      fail(`복구 전 첨부 파일을 복사하지 못했습니다: ${err.message}`, 500)
    }

    try {
      await fsp.copyFile(stagedDb, dbPath)
    } catch (err) {
      fail(`데이터베이스 파일을 교체할 수 없습니다. 서버가 DB를 사용 중일 수 있습니다: ${err.message}`, 500)
    }
    swapped = true

    try {
      await emptyDir(uploadsDir)
      await copyDirFiles(stagingUploads, uploadsDir)
    } catch (err) {
      if (fs.existsSync(safetyDb)) {
        await fsp.copyFile(safetyDb, dbPath)
      }
      await emptyDir(uploadsDir)
      await copyDirFiles(safetyUploads, uploadsDir)
      fail(`첨부 파일을 교체할 수 없습니다: ${err.message}`, 500)
    }

    unlinkIfExists(safetyDb)
    rmrf(safetyUploads)

    return {
      ok: true,
      formatVersion: header.meta.formatVersion,
      schemaVersion: header.meta.schemaVersion,
      createdAt: header.meta.createdAt,
      fileCount: header.meta.fileCount,
      totalBytes: header.meta.totalBytes,
      uploadCount: Math.max(0, (header.meta.fileCount || 1) - 1)
    }
  } catch (err) {
    if (swapped && fs.existsSync(safetyDb)) {
      try {
        await fsp.copyFile(safetyDb, dbPath)
        await emptyDir(uploadsDir)
        await copyDirFiles(safetyUploads, uploadsDir)
      } catch {
        // keep original error
      }
    }
    throw err
  } finally {
    rmrf(staging)
  }
}
