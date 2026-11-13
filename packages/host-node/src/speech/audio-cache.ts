/**
 * Disk + SQLite LRU speech audio cache (`~/.minibook/speech-cache/<key>.<ext>`,
 * 500 MB cap per `ARCHITECTURE.md` §7.1).
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { WordMark } from '@minibook/core';
import type { Database } from '../db/sqlite.js';

const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;
const SAFE_CACHE_KEY_RE = /^[a-f0-9]{16,64}$/i;

export interface CachedSpeechEntry {
  readonly key: string;
  readonly filePath: string;
  readonly mime: string;
  readonly bytes: number;
  readonly durationMs?: number;
  readonly marks?: readonly WordMark[];
}

interface RawSpeechCacheRow {
  readonly key: string;
  readonly ext: string;
  readonly mime: string;
  readonly bytes: number;
  readonly duration_ms: number | null;
  readonly marks_json: string | null;
  readonly last_used: number;
}

export class SpeechAudioCache {
  private readonly db: Database;
  private readonly cacheDir: string;
  private readonly maxBytes: number;

  constructor(db: Database, dataDir: string, maxBytes: number = DEFAULT_MAX_BYTES) {
    this.db = db;
    this.cacheDir = join(dataDir, 'speech-cache');
    this.maxBytes = maxBytes;
    mkdirSync(this.cacheDir, { recursive: true });
  }

  get(key: string): CachedSpeechEntry | null {
    if (!SAFE_CACHE_KEY_RE.test(key)) return null;
    const row = this.db
      .prepare(
        'SELECT key, ext, mime, bytes, duration_ms, marks_json, last_used FROM speech_cache WHERE key = ?',
      )
      .get(key) as unknown as RawSpeechCacheRow | undefined;
    if (!row) return null;

    const filePath = join(this.cacheDir, `${row.key}.${row.ext}`);
    if (!existsSync(filePath)) {
      this.db.prepare('DELETE FROM speech_cache WHERE key = ?').run(key);
      return null;
    }

    this.db.prepare('UPDATE speech_cache SET last_used = ? WHERE key = ?').run(Date.now(), key);

    let marks: readonly WordMark[] | undefined;
    if (row.marks_json) {
      try {
        marks = JSON.parse(row.marks_json) as readonly WordMark[];
      } catch {
        marks = undefined;
      }
    }

    return {
      key: row.key,
      filePath,
      mime: row.mime,
      bytes: Number(row.bytes),
      ...(row.duration_ms !== null ? { durationMs: Number(row.duration_ms) } : {}),
      ...(marks !== undefined ? { marks } : {}),
    };
  }

  put(params: {
    readonly key: string;
    readonly audio: Uint8Array;
    readonly mime: string;
    readonly durationMs?: number;
    readonly marks?: readonly WordMark[];
  }): CachedSpeechEntry {
    if (!SAFE_CACHE_KEY_RE.test(params.key)) {
      throw new Error(`Invalid speech cache key: ${params.key}`);
    }
    mkdirSync(this.cacheDir, { recursive: true });
    const ext = params.mime === 'audio/wav' ? 'wav' : 'mp3';
    const filePath = join(this.cacheDir, `${params.key}.${ext}`);
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;

    const fd = openSync(tmpPath, 'w', 0o644);
    try {
      writeSync(fd, params.audio);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, filePath);

    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO speech_cache (key, ext, mime, bytes, duration_ms, marks_json, last_used)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           ext = excluded.ext,
           mime = excluded.mime,
           bytes = excluded.bytes,
           duration_ms = excluded.duration_ms,
           marks_json = excluded.marks_json,
           last_used = excluded.last_used`,
      )
      .run(
        params.key,
        ext,
        params.mime,
        params.audio.byteLength,
        params.durationMs ?? null,
        params.marks ? JSON.stringify(params.marks) : null,
        now,
      );

    this.evictIfNeeded();

    return {
      key: params.key,
      filePath,
      mime: params.mime,
      bytes: params.audio.byteLength,
      ...(params.durationMs !== undefined ? { durationMs: params.durationMs } : {}),
      ...(params.marks !== undefined ? { marks: params.marks } : {}),
    };
  }

  totalBytes(): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM speech_cache')
      .get() as { readonly total: number } | undefined;
    return Number(row?.total ?? 0);
  }

  clear(): void {
    this.db.prepare('DELETE FROM speech_cache').run();
    rmSync(this.cacheDir, { recursive: true, force: true });
    mkdirSync(this.cacheDir, { recursive: true });
  }

  private evictIfNeeded(): void {
    let total = this.totalBytes();
    if (total <= this.maxBytes) return;

    const oldest = this.db
      .prepare('SELECT key, ext, bytes FROM speech_cache ORDER BY last_used ASC')
      .all() as Array<{ readonly key: string; readonly ext: string; readonly bytes: number }>;

    for (const item of oldest) {
      if (total <= this.maxBytes) break;
      const filePath = join(this.cacheDir, `${item.key}.${item.ext}`);
      try {
        if (existsSync(filePath) && statSync(filePath).isFile()) {
          rmSync(filePath, { force: true });
        }
      } catch {
        // ignore delete race
      }
      this.db.prepare('DELETE FROM speech_cache WHERE key = ?').run(item.key);
      total -= Number(item.bytes);
    }
  }
}
