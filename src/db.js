import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { extractStoredNamesFromContent, rewriteContentFileUrls } from './fileUrls.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.resolve(process.env.WIKIMAN_DATA_DIR || path.join(__dirname, '../data'))
const uploadsDir = path.join(dataDir, 'uploads')
const dbPath = path.join(dataDir, 'wiki.db')

export const CURRENT_SCHEMA_VERSION = 2

fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(uploadsDir, { recursive: true })

export let db = null

function getSchemaVersion(database) {
  try {
    const row = database.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get()
    const n = Number(row?.value)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  } catch {
    return 0
  }
}

function setSchemaVersion(database, version) {
  database.prepare(`
    INSERT INTO settings (key, value) VALUES ('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(version))
}

function recreatePostsTable(database, { withDeletedAt }) {
  database.pragma('foreign_keys = OFF')
  database.exec(`
    DROP TRIGGER IF EXISTS posts_ai;
    DROP TRIGGER IF EXISTS posts_ad;
    DROP TRIGGER IF EXISTS posts_au;
    DROP TABLE IF EXISTS posts_fts;

    CREATE TABLE posts_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      author_id INTEGER NOT NULL REFERENCES users(id),
      visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'private')),
      status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('draft', 'published')),
      editor_type TEXT NOT NULL DEFAULT 'ckeditor' CHECK(editor_type IN ('ckeditor', 'editorjs', 'markdown', 'html')),
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      ${withDeletedAt ? ', deleted_at TEXT' : ''}
    );

    INSERT INTO posts_new (
      id, title, slug, category_id, author_id, visibility, status, editor_type, content, created_at, updated_at
      ${withDeletedAt ? ', deleted_at' : ''}
    )
    SELECT
      id, title, slug, category_id, author_id, visibility,
      COALESCE(status, 'published'),
      editor_type, content, created_at, updated_at
      ${withDeletedAt ? ', deleted_at' : ''}
    FROM posts;

    DROP TABLE posts;
    ALTER TABLE posts_new RENAME TO posts;

    CREATE VIRTUAL TABLE posts_fts USING fts5(
      title,
      content,
      content='posts',
      content_rowid='id',
      tokenize = 'unicode61'
    );

    INSERT INTO posts_fts(rowid, title, content)
    SELECT id, title, content FROM posts;

    CREATE TRIGGER posts_ai AFTER INSERT ON posts BEGIN
      INSERT INTO posts_fts(rowid, title, content)
      VALUES (new.id, new.title, new.content);
    END;

    CREATE TRIGGER posts_ad AFTER DELETE ON posts BEGIN
      INSERT INTO posts_fts(posts_fts, rowid, title, content)
      VALUES ('delete', old.id, old.title, old.content);
    END;

    CREATE TRIGGER posts_au AFTER UPDATE ON posts BEGIN
      INSERT INTO posts_fts(posts_fts, rowid, title, content)
      VALUES ('delete', old.id, old.title, old.content);
      INSERT INTO posts_fts(rowid, title, content)
      VALUES (new.id, new.title, new.content);
    END;
  `)
  database.pragma('foreign_keys = ON')
}

function applyLegacyMigrations(database) {
  const postColumns = database.prepare('PRAGMA table_info(posts)').all()
  if (!postColumns.some((column) => column.name === 'status')) {
    database.exec("ALTER TABLE posts ADD COLUMN status TEXT NOT NULL DEFAULT 'published'")
  }

  const categoryColumns = database.prepare('PRAGMA table_info(categories)').all()
  if (!categoryColumns.some((column) => column.name === 'visibility')) {
    database.exec("ALTER TABLE categories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'")
  }

  const userColumns = database.prepare('PRAGMA table_info(users)').all()
  if (!userColumns.some((column) => column.name === 'role')) {
    database.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'reader'")
    const firstUser = database.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get()
    if (firstUser) {
      database.prepare("UPDATE users SET role = 'writer' WHERE id = ?").run(firstUser.id)
    }
  }

  const postsTableSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'posts'").get()?.sql || ''
  if (postsTableSql && !postsTableSql.includes("'html'")) {
    recreatePostsTable(database, { withDeletedAt: false })
  }

  const latestPostColumns = database.prepare('PRAGMA table_info(posts)').all()
  if (!latestPostColumns.some((column) => column.name === 'deleted_at')) {
    database.exec('ALTER TABLE posts ADD COLUMN deleted_at TEXT')
  }

  const editorTypeSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'posts'").get()?.sql || ''
  if (editorTypeSql && !editorTypeSql.includes("'ckeditor'")) {
    recreatePostsTable(database, { withDeletedAt: true })
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS homepage_posts (
      post_id INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_homepage_posts_sort ON homepage_posts(sort_order);
  `)
  const legacy = database.prepare("SELECT value FROM settings WHERE key = 'home_post_id'").get()
  const legacyId = Number(String(legacy?.value || '').trim())
  if (Number.isFinite(legacyId) && legacyId > 0) {
    const post = database.prepare('SELECT id FROM posts WHERE id = ?').get(legacyId)
    if (post) {
      database.prepare(`
        INSERT OR IGNORE INTO homepage_posts (post_id, sort_order) VALUES (?, 0)
      `).run(legacyId)
    }
    database.prepare("DELETE FROM settings WHERE key = 'home_post_id'").run()
  }
}

function rebuildUploadRefs(database) {
  database.exec('DELETE FROM upload_refs')
  const insert = database.prepare('INSERT OR IGNORE INTO upload_refs (post_id, stored_name) VALUES (?, ?)')
  const tx = database.transaction(() => {
    for (const row of database.prepare('SELECT post_id, stored_name FROM post_attachments').all()) {
      insert.run(row.post_id, row.stored_name)
    }
    for (const post of database.prepare('SELECT id, content FROM posts').all()) {
      for (const name of extractStoredNamesFromContent(post.content)) {
        insert.run(post.id, name)
      }
    }
  })
  tx()
}

function migrateLegacyFileUrls(database) {
  const update = database.prepare('UPDATE posts SET content = ? WHERE id = ?')
  const tx = database.transaction(() => {
    for (const post of database.prepare('SELECT id, content FROM posts').all()) {
      const next = rewriteContentFileUrls(post.content, post.id)
      if (next !== post.content) update.run(next, post.id)
    }
  })
  tx()
}

function migrateTo(database, version) {
  if (version === 2) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS upload_refs (
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        stored_name TEXT NOT NULL,
        PRIMARY KEY (post_id, stored_name)
      );
      CREATE INDEX IF NOT EXISTS idx_upload_refs_name ON upload_refs(stored_name);
      CREATE INDEX IF NOT EXISTS idx_posts_list ON posts(deleted_at, status, visibility, updated_at);
      CREATE INDEX IF NOT EXISTS idx_posts_category ON posts(category_id, deleted_at);
      CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
      CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status, deleted_at);
    `)
    migrateLegacyFileUrls(database)
    rebuildUploadRefs(database)
  }
}

function ensureSchema(database) {
  database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'reader' CHECK(role IN ('writer', 'reader')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'private')),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    author_id INTEGER NOT NULL REFERENCES users(id),
    visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'private')),
    status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('draft', 'published')),
    editor_type TEXT NOT NULL DEFAULT 'ckeditor' CHECK(editor_type IN ('ckeditor', 'editorjs', 'markdown', 'html')),
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
    title,
    content,
    content='posts',
    content_rowid='id',
    tokenize = 'unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
    INSERT INTO posts_fts(rowid, title, content)
    VALUES (new.id, new.title, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
    INSERT INTO posts_fts(rowid, title, content)
    VALUES (new.id, new.title, new.content);
  END;
`)

  database.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)

  const seedSetting = database.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  seedSetting.run('site_title', 'Wikiman')
  seedSetting.run('theme', 'light')
  seedSetting.run(
    'plantuml_server',
    String(process.env.PLANTUML_SERVER || 'https://www.plantuml.com/plantuml').replace(/\/$/, '')
  )
  seedSetting.run('default_editor', 'ckeditor')
  database.prepare("UPDATE settings SET value = 'ckeditor' WHERE key = 'default_editor' AND value = 'editorjs'").run()
  seedSetting.run('favicon', '')
  seedSetting.run('max_attachment_mb', '20')
  seedSetting.run('category_tree_expand', 'expanded')
  seedSetting.run('category_tree_side', 'left')
  seedSetting.run('font_scale', '100')

  database.exec(`
  CREATE TABLE IF NOT EXISTS post_keywords (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    keyword TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (post_id, keyword)
  );
  CREATE INDEX IF NOT EXISTS idx_post_keywords_keyword ON post_keywords(keyword);
`)

  database.exec(`
  CREATE TABLE IF NOT EXISTS post_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    stored_name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_post_attachments_post_id ON post_attachments(post_id);
`)

  let version = getSchemaVersion(database)
  if (version < 1) {
    applyLegacyMigrations(database)
    version = 1
    setSchemaVersion(database, version)
  }

  while (version < CURRENT_SCHEMA_VERSION) {
    const next = version + 1
    migrateTo(database, next)
    version = next
    setSchemaVersion(database, version)
  }
}

export function openDatabase() {
  const database = new Database(dbPath)
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  ensureSchema(database)
  return database
}

export function closeDatabase() {
  if (!db) return
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    // ignore
  }
  try {
    db.close()
  } catch {
    // ignore
  }
  db = null
}

export function reopenDatabase() {
  closeDatabase()
  db = openDatabase()
  return db
}

/** 백업용: WAL을 db 파일로 합칩니다. */
export function checkpointDatabase() {
  if (!db) return
  db.pragma('wal_checkpoint(TRUNCATE)')
}

db = openDatabase()

export { dataDir, uploadsDir, dbPath }
