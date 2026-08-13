import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.resolve(__dirname, '../data')
const uploadsDir = path.join(dataDir, 'uploads')
const dbPath = path.join(dataDir, 'wiki.db')

fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(uploadsDir, { recursive: true })

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
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
    editor_type TEXT NOT NULL DEFAULT 'editorjs' CHECK(editor_type IN ('editorjs', 'markdown')),
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

const postColumns = db.prepare("PRAGMA table_info(posts)").all()
if (!postColumns.some((column) => column.name === 'status')) {
  db.exec("ALTER TABLE posts ADD COLUMN status TEXT NOT NULL DEFAULT 'published'")
}

const userColumns = db.prepare("PRAGMA table_info(users)").all()
if (!userColumns.some((column) => column.name === 'role')) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'reader'")
  const firstUser = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get()
  if (firstUser) {
    db.prepare("UPDATE users SET role = 'writer' WHERE id = ?").run(firstUser.id)
  }
}

export { db, dataDir, uploadsDir, dbPath }
