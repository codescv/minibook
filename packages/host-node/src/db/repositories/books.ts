import type {
  BookFormat,
  BookId,
  BookIndex,
  EpochMs,
  LibraryBook,
} from '@minibook/core';
import type { LibraryBookDetailWire } from '../../shared/routes.js';
import type { Database } from '../sqlite.js';

export interface StoredBookRecord extends LibraryBookDetailWire {
  readonly fileExt: string;
}

export interface InsertBookParams {
  readonly id: BookId;
  readonly title: string;
  readonly authors: readonly string[];
  readonly language: string | null;
  readonly format: BookFormat;
  readonly fileName: string;
  readonly fileExt: string;
  readonly size: number;
  readonly derivedTextSize: number;
  readonly hasCover: boolean;
  readonly coverMime: string | null;
  readonly addedAt: EpochMs;
  readonly index: BookIndex;
}

interface RawBookRow {
  readonly id: string;
  readonly title: string;
  readonly authors: string | null;
  readonly language: string | null;
  readonly format: string;
  readonly file_name: string;
  readonly file_ext: string;
  readonly size: number;
  readonly derived_text_size: number;
  readonly has_cover: number;
  readonly cover_mime: string | null;
  readonly added_at: number;
  readonly opened_at: number | null;
  readonly finished: number;
  readonly fraction: number | null;
  readonly index_json?: string;
}

function parseAuthors(raw: string | null): readonly string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    // fall through
  }
  return [raw];
}

function toLibraryBook(row: RawBookRow): LibraryBook {
  return {
    id: row.id,
    title: row.title,
    authors: parseAuthors(row.authors),
    language: row.language,
    format: row.format as BookFormat,
    fileName: row.file_name,
    size: Number(row.size),
    hasCover: row.has_cover !== 0,
    coverMime: row.cover_mime,
    addedAt: Number(row.added_at),
    openedAt: row.opened_at === null ? null : Number(row.opened_at),
    finished: row.finished !== 0,
    fraction: row.fraction === null ? 0 : Number(row.fraction),
  };
}

export class BooksRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  list(): LibraryBook[] {
    const rows = this.db
      .prepare(
        `SELECT b.id, b.title, b.authors, b.language, b.format, b.file_name, b.file_ext,
                b.size, b.derived_text_size, b.has_cover, b.cover_mime, b.added_at, b.opened_at,
                b.finished, p.fraction AS fraction
           FROM books b
           LEFT JOIN positions p ON p.book_id = b.id
          ORDER BY COALESCE(b.opened_at, b.added_at) DESC, b.added_at DESC`,
      )
      .all() as unknown as RawBookRow[];
    return rows.map(toLibraryBook);
  }

  get(id: BookId): StoredBookRecord | null {
    const row = this.db
      .prepare(
        `SELECT b.id, b.title, b.authors, b.language, b.format, b.file_name, b.file_ext,
                b.size, b.derived_text_size, b.has_cover, b.cover_mime, b.added_at, b.opened_at,
                b.finished, b.index_json, p.fraction AS fraction
           FROM books b
           LEFT JOIN positions p ON p.book_id = b.id
          WHERE b.id = ?`,
      )
      .get(id) as unknown as RawBookRow | undefined;
    if (!row || row.index_json === undefined) return null;
    const base = toLibraryBook(row);
    const index = JSON.parse(row.index_json) as BookIndex;
    return {
      ...base,
      index,
      fileExt: row.file_ext,
      derivedTextSize: Number(row.derived_text_size),
    };
  }

  insertIfAbsent(params: InsertBookParams): { readonly book: LibraryBook; readonly inserted: boolean } {
    const existing = this.get(params.id);
    if (existing) {
      this.markOpened(params.id, Date.now());
      const refreshed = this.get(params.id)!;
      const { index: _index, fileExt: _ext, derivedTextSize: _dts, ...summary } = refreshed;
      return { book: summary, inserted: false };
    }

    this.db
      .prepare(
        `INSERT INTO books (
          id, title, authors, language, format, file_name, file_ext, size,
          derived_text_size, has_cover, cover_mime, added_at, opened_at, finished, index_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        params.id,
        params.title,
        JSON.stringify(params.authors),
        params.language,
        params.format,
        params.fileName,
        params.fileExt,
        params.size,
        params.derivedTextSize,
        params.hasCover ? 1 : 0,
        params.coverMime,
        params.addedAt,
        null,
        JSON.stringify(params.index),
      );

    const created = this.get(params.id)!;
    const { index: _index, fileExt: _ext, derivedTextSize: _dts, ...summary } = created;
    return { book: summary, inserted: true };
  }

  remove(id: BookId): boolean {
    const res = this.db.prepare('DELETE FROM books WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  setFinished(id: BookId, finished: boolean): boolean {
    const res = this.db
      .prepare('UPDATE books SET finished = ? WHERE id = ?')
      .run(finished ? 1 : 0, id);
    return Number(res.changes) > 0;
  }

  markOpened(id: BookId, openedAt: EpochMs = Date.now()): boolean {
    const res = this.db
      .prepare('UPDATE books SET opened_at = ? WHERE id = ?')
      .run(openedAt, id);
    return Number(res.changes) > 0;
  }
}
