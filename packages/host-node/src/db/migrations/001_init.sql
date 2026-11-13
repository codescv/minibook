-- MiniBook desktop schema (`ARCHITECTURE.md` §7.1)

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  authors TEXT,
  language TEXT,
  format TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_ext TEXT NOT NULL,
  size INTEGER NOT NULL,
  derived_text_size INTEGER NOT NULL DEFAULT 0,
  has_cover INTEGER NOT NULL DEFAULT 0,
  cover_mime TEXT,
  added_at INTEGER NOT NULL,
  opened_at INTEGER,
  finished INTEGER NOT NULL DEFAULT 0,
  index_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_books_recent
  ON books (COALESCE(opened_at, added_at) DESC, added_at DESC);

CREATE TABLE IF NOT EXISTS positions (
  book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  section INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  fraction REAL NOT NULL,
  snippet TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  section INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  fraction REAL NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (book_id, section, offset)
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_book
  ON bookmarks (book_id, section ASC, offset ASC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS speech_cache (
  key TEXT PRIMARY KEY,
  ext TEXT NOT NULL DEFAULT 'mp3',
  mime TEXT NOT NULL DEFAULT 'audio/mpeg',
  bytes INTEGER NOT NULL,
  duration_ms INTEGER,
  marks_json TEXT,
  last_used INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_speech_cache_lru
  ON speech_cache (last_used ASC);
