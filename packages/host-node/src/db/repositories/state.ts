import { MiniBookError, type BookId, type Bookmark, type BookmarkInput, type SavedPosition } from '@minibook/core';
import type { Database } from '../sqlite.js';

interface RawPositionRow {
  readonly book_id: string;
  readonly section: number;
  readonly offset: number;
  readonly fraction: number;
  readonly snippet: string | null;
  readonly updated_at: number;
}

interface RawBookmarkRow {
  readonly id: number;
  readonly book_id: string;
  readonly section: number;
  readonly offset: number;
  readonly fraction: number;
  readonly label: string | null;
  readonly created_at: number;
}

function toBookmark(row: RawBookmarkRow): Bookmark {
  return {
    id: String(row.id),
    bookId: row.book_id,
    section: Number(row.section),
    offset: Number(row.offset),
    fraction: Number(row.fraction),
    label: row.label ?? '',
    createdAt: Number(row.created_at),
  };
}

export class StateRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  getPosition(bookId: BookId): SavedPosition | null {
    const row = this.db
      .prepare(
        'SELECT book_id, section, offset, fraction, snippet, updated_at FROM positions WHERE book_id = ?',
      )
      .get(bookId) as unknown as RawPositionRow | undefined;
    if (!row) return null;
    return {
      section: Number(row.section),
      offset: Number(row.offset),
      fraction: Number(row.fraction),
      snippet: row.snippet ?? '',
      updatedAt: Number(row.updated_at),
    };
  }

  savePosition(bookId: BookId, pos: SavedPosition): void {
    const exists = this.db.prepare('SELECT 1 FROM books WHERE id = ?').get(bookId);
    if (!exists) {
      throw new MiniBookError('not-found', `Book not found: ${bookId}`);
    }
    this.db
      .prepare(
        `INSERT INTO positions (book_id, section, offset, fraction, snippet, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(book_id) DO UPDATE SET
           section = excluded.section,
           offset = excluded.offset,
           fraction = excluded.fraction,
           snippet = excluded.snippet,
           updated_at = excluded.updated_at`,
      )
      .run(
        bookId,
        Math.max(0, Math.trunc(pos.section)),
        Math.max(0, Math.trunc(pos.offset)),
        Math.max(0, Math.min(1, pos.fraction)),
        pos.snippet ?? '',
        pos.updatedAt || Date.now(),
      );
    this.db
      .prepare('UPDATE books SET opened_at = ? WHERE id = ?')
      .run(pos.updatedAt || Date.now(), bookId);
  }

  listBookmarks(bookId: BookId): Bookmark[] {
    const rows = this.db
      .prepare(
        `SELECT id, book_id, section, offset, fraction, label, created_at
           FROM bookmarks
          WHERE book_id = ?
          ORDER BY section ASC, offset ASC, created_at ASC`,
      )
      .all(bookId) as unknown as RawBookmarkRow[];
    return rows.map(toBookmark);
  }

  addBookmark(bookId: BookId, input: BookmarkInput): Bookmark {
    const exists = this.db.prepare('SELECT 1 FROM books WHERE id = ?').get(bookId);
    if (!exists) {
      throw new MiniBookError('not-found', `Book not found: ${bookId}`);
    }
    const section = Math.max(0, Math.trunc(input.section));
    const offset = Math.max(0, Math.trunc(input.offset));
    const fraction = Math.max(0, Math.min(1, input.fraction));
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO bookmarks (book_id, section, offset, fraction, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(book_id, section, offset) DO UPDATE SET
           fraction = excluded.fraction,
           label = excluded.label`,
      )
      .run(bookId, section, offset, fraction, input.label ?? '', now);

    const row = this.db
      .prepare(
        `SELECT id, book_id, section, offset, fraction, label, created_at
           FROM bookmarks
          WHERE book_id = ? AND section = ? AND offset = ?`,
      )
      .get(bookId, section, offset) as unknown as RawBookmarkRow | undefined;
    if (!row) {
      throw new MiniBookError('corrupt-book', 'Failed to read inserted bookmark');
    }
    return toBookmark(row);
  }

  removeBookmark(bookId: BookId, bookmarkId: string): void {
    const numericId = Number.parseInt(bookmarkId, 10);
    if (!Number.isFinite(numericId)) return;
    this.db
      .prepare('DELETE FROM bookmarks WHERE book_id = ? AND id = ?')
      .run(bookId, numericId);
  }
}
