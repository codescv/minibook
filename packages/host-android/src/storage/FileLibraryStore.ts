/**
 * File-backed library, reading state, and settings persistence for Android & iOS
 * (`ARCHITECTURE.md` §7.2 — no IndexedDB; atomic JSON writes via `MiniBookPlugin.fs`).
 *
 * Layout under `MiniBookData/`:
 *   - `library.json` (derived summary list; rebuilt automatically from `books/<id>/index.json` if missing/corrupt)
 *   - `settings.json`
 *   - `books/<id>/book.<ext>`
 *   - `books/<id>/cover.<ext>`
 *   - `books/<id>/index.json` (`PersistedBookIndexFile`)
 *   - `books/<id>/state.json` (`PersistedBookStateFile` — shared with native `SpeechJournal`)
 *   - `books/<id>/text.bin` (optional derived stream for MOBI/KF8 or transcoded TXT)
 *   - `tmp/` (import staging)
 */
import {
  DEFAULT_APP_SETTINGS,
  MiniBookError,
  sanitizeAppSettings,
  type AppSettings,
  type BookFormat,
  type BookId,
  type BookIndex,
  type BookMeta,
  type Bookmark,
  type BookmarkInput,
  type EpochMs,
  type InspectedBook,
  type LibraryBook,
  type LibraryBookDetail,
  type SavedPosition,
} from '@minibook/core';
import type { MiniBookPlugin } from '../plugin-types.js';
import { base64ToBytes, bytesToBase64 } from './base64.js';

export interface PersistedBookIndexFile {
  readonly id: BookId;
  readonly meta: BookMeta;
  readonly index: BookIndex;
  readonly fileName: string;
  readonly fileExt: string;
  readonly size: number;
  readonly derivedTextSize: number;
  readonly hasCover: boolean;
  readonly coverExt: string | null;
  readonly coverMime: string | null;
  readonly addedAt: EpochMs;
  readonly openedAt: EpochMs | null;
  readonly finished: boolean;
}

export interface PersistedBookStateFile {
  readonly position: SavedPosition | null;
  readonly bookmarks: readonly Bookmark[];
}

export interface CachedBookPaths {
  readonly bookPath: string;
  readonly size: number;
  readonly derivedPath: string;
  readonly derivedSize: number;
  readonly coverUrl: string | null;
}

function canonicalExtension(fileName: string, fallbackFormat: BookFormat): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.fb2.zip')) return 'fb2.zip';
  const dot = lower.lastIndexOf('.');
  if (dot >= 0) {
    const ext = lower.slice(dot + 1);
    if (/^[a-z0-9]{1,12}$/.test(ext)) return ext;
  }
  return fallbackFormat === 'kf8' ? 'azw3' : fallbackFormat;
}

function coverExtForMime(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower.includes('png')) return 'png';
  if (lower.includes('webp')) return 'webp';
  if (lower.includes('gif')) return 'gif';
  if (lower.includes('svg')) return 'svg';
  return 'jpg';
}

export class FileLibraryStore {
  private readonly plugin: MiniBookPlugin;
  private readonly pathMeta = new Map<BookId, CachedBookPaths>();

  constructor(plugin: MiniBookPlugin) {
    this.plugin = plugin;
  }

  getCachedPaths(bookId: BookId): CachedBookPaths | undefined {
    return this.pathMeta.get(bookId);
  }

  coverUrl(bookId: BookId): string | null {
    return this.pathMeta.get(bookId)?.coverUrl ?? null;
  }

  private async readJsonFile<T>(path: string): Promise<T | null> {
    const st = await this.plugin.fs.stat({ path });
    if (!st.exists || st.isDirectory || !st.size || st.size <= 0) {
      return null;
    }
    const res = await this.plugin.fs.read({
      path,
      offset: 0,
      length: Math.min(st.size, 1024 * 1024),
    });
    let bytes = base64ToBytes(res.base64);
    if (st.size > 1024 * 1024) {
      const full = new Uint8Array(st.size);
      full.set(bytes, 0);
      let pos = bytes.byteLength;
      while (pos < st.size) {
        const ask = Math.min(1024 * 1024, st.size - pos);
        const chunkRes = await this.plugin.fs.read({ path, offset: pos, length: ask });
        const chunk = base64ToBytes(chunkRes.base64);
        if (chunk.byteLength === 0) break;
        full.set(chunk, pos);
        pos += chunk.byteLength;
      }
      bytes = full;
    }
    const text = new TextDecoder('utf-8').decode(bytes);
    return JSON.parse(text) as T;
  }

  private async writeJsonFile(path: string, data: unknown): Promise<void> {
    await this.plugin.fs.writeAtomic({
      path,
      text: JSON.stringify(data),
    });
  }

  private async rememberBookFiles(rec: PersistedBookIndexFile): Promise<void> {
    let coverUrl: string | null = null;
    if (rec.hasCover && rec.coverExt) {
      try {
        const res = await this.plugin.fs.fileUrl({
          path: `books/${rec.id}/cover.${rec.coverExt}`,
        });
        coverUrl = res.url;
      } catch {
        coverUrl = null;
      }
    }
    this.pathMeta.set(rec.id, {
      bookPath: `books/${rec.id}/book.${rec.fileExt}`,
      size: rec.size,
      derivedPath: `books/${rec.id}/text.bin`,
      derivedSize: rec.derivedTextSize,
      coverUrl,
    });
  }

  private toLibraryBook(rec: PersistedBookIndexFile, fraction: number): LibraryBook {
    return {
      id: rec.id,
      title: rec.meta.title || rec.fileName,
      authors: rec.meta.authors,
      language: rec.meta.language,
      format: rec.meta.format,
      fileName: rec.fileName,
      size: rec.size,
      hasCover: rec.hasCover,
      coverMime: rec.coverMime,
      addedAt: rec.addedAt,
      openedAt: rec.openedAt,
      finished: rec.finished,
      fraction,
    };
  }

  async list(): Promise<LibraryBook[]> {
    try {
      const cached = await this.readJsonFile<
        ReadonlyArray<
          LibraryBook & {
            readonly fileExt?: string;
            readonly derivedTextSize?: number;
            readonly coverExt?: string | null;
          }
        >
      >('library.json');
      if (Array.isArray(cached)) {
        const normalized: LibraryBook[] = [];
        for (const item of cached) {
          if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) {
            continue;
          }
          if (!this.pathMeta.has(item.id) && item.fileExt) {
            let coverUrl: string | null = null;
            if (item.hasCover && item.coverExt) {
              const res = await this.plugin.fs
                .fileUrl({ path: `books/${item.id}/cover.${item.coverExt}` })
                .catch(() => null);
              coverUrl = res?.url ?? null;
            }
            this.pathMeta.set(item.id, {
              bookPath: `books/${item.id}/book.${item.fileExt}`,
              size: typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : 0,
              derivedPath: `books/${item.id}/text.bin`,
              derivedSize: item.derivedTextSize ?? 0,
              coverUrl,
            });
          }
          const { fileExt: _e, derivedTextSize: _d, coverExt: _c, ...clean } = item;
          normalized.push({
            ...clean,
            title: typeof clean.title === 'string' && clean.title ? clean.title : (clean.fileName || clean.id),
            authors: Array.isArray(clean.authors)
              ? (clean.authors as readonly unknown[]).filter((a): a is string => typeof a === 'string')
              : [],
            fraction:
              typeof clean.fraction === 'number' && Number.isFinite(clean.fraction)
                ? Math.max(0, Math.min(1, clean.fraction))
                : 0,
            finished: Boolean(clean.finished),
          });
        }
        return normalized;
      }
    } catch {
      // Corrupt or missing library.json -> rebuild below
    }
    return this.rebuildLibraryIndex();
  }

  /**
   * Rebuilds `library.json` from `books/<id>/index.json` + `state.json` (`ARCHITECTURE.md` §7.2).
   */
  async rebuildLibraryIndex(): Promise<LibraryBook[]> {
    const entries = await this.plugin.fs.list({ path: 'books' }).catch(() => []);
    const records: Array<{
      readonly rec: PersistedBookIndexFile;
      readonly fraction: number;
    }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const indexPath = `books/${entry.name}/index.json`;
      try {
        const rec = await this.readJsonFile<PersistedBookIndexFile>(indexPath);
        if (!rec || !rec.id) continue;
        const state = await this.readStateFile(rec.id);
        await this.rememberBookFiles(rec);
        records.push({
          rec,
          fraction: state.position?.fraction ?? 0,
        });
      } catch {
        // skip unreadable book folder
      }
    }

    records.sort((a, b) => {
      const ta = a.rec.openedAt ?? a.rec.addedAt;
      const tb = b.rec.openedAt ?? b.rec.addedAt;
      if (tb !== ta) return tb - ta;
      return b.rec.addedAt - a.rec.addedAt;
    });

    const wireList = records.map(({ rec, fraction }) => ({
      ...this.toLibraryBook(rec, fraction),
      fileExt: rec.fileExt,
      derivedTextSize: rec.derivedTextSize,
      coverExt: rec.coverExt,
    }));

    await this.writeJsonFile('library.json', wireList);
    return records.map(({ rec, fraction }) => this.toLibraryBook(rec, fraction));
  }

  async get(id: BookId): Promise<LibraryBookDetail | null> {
    const rec = await this.readJsonFile<PersistedBookIndexFile>(`books/${id}/index.json`).catch(
      () => null,
    );
    if (!rec) return null;
    await this.rememberBookFiles(rec);
    const state = await this.readStateFile(id);
    return {
      ...this.toLibraryBook(rec, state.position?.fraction ?? 0),
      index: rec.index,
    };
  }

  async commitImport(params: {
    readonly bookId: BookId;
    readonly tempPath: string;
    readonly fileName: string;
    readonly stagedDerivedPath: string | null;
    readonly derivedTextSize: number;
    readonly inspected: InspectedBook;
  }): Promise<LibraryBook> {
    const existing = await this.readJsonFile<PersistedBookIndexFile>(
      `books/${params.bookId}/index.json`,
    ).catch(() => null);

    if (existing) {
      // Duplicate book: clean up staged temp files, bump openedAt, and return existing
      await this.plugin.fs.remove({ path: params.tempPath }).catch(() => undefined);
      if (params.stagedDerivedPath) {
        await this.plugin.fs.remove({ path: params.stagedDerivedPath }).catch(() => undefined);
      }
      await this.markOpened(params.bookId, Date.now());
      const detail = await this.get(params.bookId);
      if (detail) {
        const { index: _idx, ...summary } = detail;
        return summary;
      }
    }

    const fileExt = canonicalExtension(params.fileName, params.inspected.meta.format);
    const adopted = await this.plugin.fs.stat({ path: params.tempPath });
    if (!adopted.exists) {
      throw new MiniBookError('not-found', `Staged import file missing: ${params.tempPath}`);
    }

    const adoptedRes = await this.plugin.import.adopt({
      tempPath: params.tempPath,
      bookId: params.bookId,
      ext: fileExt,
    });

    // Move or copy staged derived text.bin if present
    let finalDerivedSize = 0;
    if (params.stagedDerivedPath && params.derivedTextSize > 0) {
      const targetDerived = `books/${params.bookId}/text.bin`;
      await this.plugin.fs.remove({ path: targetDerived }).catch(() => undefined);
      let pos = 0;
      while (pos < params.derivedTextSize) {
        const ask = Math.min(1024 * 1024, params.derivedTextSize - pos);
        const chunk = await this.plugin.fs.read({
          path: params.stagedDerivedPath,
          offset: pos,
          length: ask,
        });
        if (!chunk.base64 || chunk.bytesRead <= 0) break;
        await this.plugin.fs.append({ path: targetDerived, base64: chunk.base64 });
        pos += chunk.bytesRead;
      }
      await this.plugin.fs.remove({ path: params.stagedDerivedPath }).catch(() => undefined);
      finalDerivedSize = pos;
    }

    let coverExt: string | null = null;
    let coverMime: string | null = null;
    const hasCover = Boolean(
      params.inspected.cover && params.inspected.cover.bytes.byteLength > 0,
    );
    if (hasCover && params.inspected.cover) {
      coverMime = params.inspected.cover.mime;
      coverExt = coverExtForMime(coverMime);
      await this.plugin.fs.writeAtomic({
        path: `books/${params.bookId}/cover.${coverExt}`,
        base64: bytesToBase64(params.inspected.cover.bytes),
      });
    }

    const now = Date.now();
    const rec: PersistedBookIndexFile = {
      id: params.bookId,
      meta: params.inspected.meta,
      index: params.inspected.index,
      fileName: params.fileName,
      fileExt,
      size: adoptedRes.size,
      derivedTextSize: finalDerivedSize,
      hasCover,
      coverExt,
      coverMime,
      addedAt: now,
      openedAt: null,
      finished: false,
    };

    await this.writeJsonFile(`books/${params.bookId}/index.json`, rec);
    await this.writeJsonFile(`books/${params.bookId}/state.json`, {
      position: null,
      bookmarks: [],
    } satisfies PersistedBookStateFile);

    await this.rememberBookFiles(rec);
    await this.rebuildLibraryIndex();
    return this.toLibraryBook(rec, 0);
  }

  async remove(id: BookId): Promise<void> {
    this.pathMeta.delete(id);
    await this.plugin.fs.remove({ path: `books/${id}` });
    await this.rebuildLibraryIndex();
  }

  async setFinished(id: BookId, finished: boolean): Promise<void> {
    const rec = await this.readJsonFile<PersistedBookIndexFile>(`books/${id}/index.json`);
    if (!rec) {
      throw new MiniBookError('not-found', `Book not found: ${id}`);
    }
    const updated: PersistedBookIndexFile = { ...rec, finished };
    await this.writeJsonFile(`books/${id}/index.json`, updated);
    await this.rebuildLibraryIndex();
  }

  async markOpened(id: BookId, openedAt: EpochMs = Date.now()): Promise<void> {
    const rec = await this.readJsonFile<PersistedBookIndexFile>(`books/${id}/index.json`);
    if (!rec) return;
    const updated: PersistedBookIndexFile = { ...rec, openedAt };
    await this.writeJsonFile(`books/${id}/index.json`, updated);
    await this.rebuildLibraryIndex();
  }

  private async readStateFile(bookId: BookId): Promise<PersistedBookStateFile> {
    try {
      const parsed = await this.readJsonFile<PersistedBookStateFile>(`books/${bookId}/state.json`);
      if (parsed && typeof parsed === 'object') {
        return {
          position: parsed.position ?? null,
          bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : [],
        };
      }
    } catch {
      // ignore missing/corrupt state file
    }
    return { position: null, bookmarks: [] };
  }

  async getPosition(bookId: BookId): Promise<SavedPosition | null> {
    const state = await this.readStateFile(bookId);
    return state.position;
  }

  async savePosition(bookId: BookId, pos: SavedPosition): Promise<void> {
    const state = await this.readStateFile(bookId);
    const nextState: PersistedBookStateFile = {
      position: pos,
      bookmarks: state.bookmarks,
    };
    await this.writeJsonFile(`books/${bookId}/state.json`, nextState);

    // Update openedAt + fraction in index/library
    const rec = await this.readJsonFile<PersistedBookIndexFile>(`books/${bookId}/index.json`).catch(
      () => null,
    );
    if (rec) {
      await this.writeJsonFile(`books/${bookId}/index.json`, {
        ...rec,
        openedAt: pos.updatedAt || Date.now(),
      });
      await this.rebuildLibraryIndex();
    }
  }

  async listBookmarks(bookId: BookId): Promise<Bookmark[]> {
    const state = await this.readStateFile(bookId);
    return [...state.bookmarks].sort((a, b) =>
      a.section !== b.section ? a.section - b.section : a.offset - b.offset,
    );
  }

  async addBookmark(bookId: BookId, input: BookmarkInput): Promise<Bookmark> {
    const state = await this.readStateFile(bookId);
    const existing = state.bookmarks.find(
      (b) => b.section === input.section && b.offset === input.offset,
    );
    const now = Date.now();
    const created: Bookmark = existing
      ? { ...existing, fraction: input.fraction, label: input.label }
      : {
          id: `bm_${now}_${Math.random().toString(36).slice(2, 8)}`,
          bookId,
          section: input.section,
          offset: input.offset,
          fraction: input.fraction,
          label: input.label,
          createdAt: now,
        };

    const others = state.bookmarks.filter((b) => b.id !== created.id);
    await this.writeJsonFile(`books/${bookId}/state.json`, {
      position: state.position,
      bookmarks: [...others, created],
    } satisfies PersistedBookStateFile);
    return created;
  }

  async removeBookmark(bookId: BookId, bookmarkId: string): Promise<void> {
    const state = await this.readStateFile(bookId);
    await this.writeJsonFile(`books/${bookId}/state.json`, {
      position: state.position,
      bookmarks: state.bookmarks.filter((b) => b.id !== bookmarkId),
    } satisfies PersistedBookStateFile);
  }

  async getSettings(): Promise<AppSettings> {
    try {
      const raw = await this.readJsonFile<Partial<AppSettings>>('settings.json');
      if (raw && typeof raw === 'object') {
        return mergeAppSettings(DEFAULT_APP_SETTINGS, raw);
      }
    } catch {
      // ignore missing settings
    }
    return DEFAULT_APP_SETTINGS;
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.getSettings();
    const next = mergeAppSettings(current, patch);
    await this.writeJsonFile('settings.json', next);
    return next;
  }

  async booksStorageBytes(): Promise<number> {
    return this.sumTreeBytes('books');
  }

  private async sumTreeBytes(dirPath: string): Promise<number> {
    const entries = await this.plugin.fs.list({ path: dirPath }).catch(() => []);
    let total = 0;
    for (const e of entries) {
      if (e.isDirectory) {
        total += await this.sumTreeBytes(e.path);
      } else {
        total += e.size;
      }
    }
    return total;
  }
}

function mergeAppSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return sanitizeAppSettings(patch, base);
}
