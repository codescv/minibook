/**
 * Browser `ByteSource` implementations (`ARCHITECTURE.md` §3.3):
 *   - `HttpRangeByteSource`: bounded HTTP `206 Partial Content` slices over `/api/books/:id/file`
 *     wrapped in 64 KiB window coalescing + 2 MiB LRU + <= 1 MiB chunking.
 *   - `BrowserFileByteSource`: wraps a DOM `File` / `Blob` during local picker or drag-and-drop import.
 */
import { MiniBookError, type BookIndex, type ByteSource } from '@minibook/core';

const DEFAULT_WINDOW_BYTES = 64 * 1024;
const DEFAULT_MAX_CACHE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CHUNK_BYTES = 1024 * 1024;

export function inferDerivedTextSizeFromIndex(index: BookIndex): number {
  switch (index.kind) {
    case 'kf8': {
      let max = 0;
      for (const f of index.flows) {
        if (f.end > max) max = f.end;
      }
      for (const s of index.sections) {
        const end = s.skelStart + s.totalLen;
        if (end > max) max = end;
      }
      return max;
    }
    case 'mobi6': {
      let max = 0;
      for (const s of index.sections) {
        if (s.byteEnd > max) max = s.byteEnd;
      }
      return max;
    }
    case 'txt':
    case 'md': {
      if (!index.usesDerivedText) return 0;
      let max = 0;
      for (const ch of index.chapters) {
        if (ch.byteEnd > max) max = ch.byteEnd;
      }
      return max;
    }
    default:
      return 0;
  }
}

export class CoalescedByteSource implements ByteSource {
  private readonly inner: ByteSource;
  private readonly windowBytes: number;
  private readonly maxCacheBytes: number;
  private readonly maxChunkBytes: number;
  private readonly cache = new Map<number, Uint8Array>();
  private cachedBytes = 0;

  constructor(
    inner: ByteSource,
    options?: {
      readonly windowBytes?: number;
      readonly maxCacheBytes?: number;
      readonly maxChunkBytes?: number;
    },
  ) {
    this.inner = inner;
    this.windowBytes = options?.windowBytes ?? DEFAULT_WINDOW_BYTES;
    this.maxCacheBytes = options?.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
    this.maxChunkBytes = options?.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
  }

  get size(): number {
    return this.inner.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (length <= 0) return new Uint8Array(0);
    const safeOffset = Math.max(0, Math.trunc(offset));
    const knownSize = this.inner.size;
    if (knownSize > 0 && safeOffset >= knownSize) {
      return new Uint8Array(0);
    }
    const clampedLength =
      knownSize > 0 ? Math.min(Math.trunc(length), knownSize - safeOffset) : Math.trunc(length);
    if (clampedLength <= 0) return new Uint8Array(0);

    // Large sequential reads (> 2 windows) bypass the small-window LRU and split at <= 1 MiB
    if (clampedLength > this.windowBytes * 2) {
      return this.readLargeChunked(safeOffset, clampedLength);
    }

    const firstWin = Math.floor(safeOffset / this.windowBytes);
    const lastWin = Math.floor((safeOffset + clampedLength - 1) / this.windowBytes);

    if (firstWin === lastWin) {
      const win = await this.getWindow(firstWin);
      const localStart = safeOffset - firstWin * this.windowBytes;
      const localEnd = Math.min(win.byteLength, localStart + clampedLength);
      return win.slice(localStart, localEnd);
    }

    const out = new Uint8Array(clampedLength);
    let written = 0;
    for (let w = firstWin; w <= lastWin; w++) {
      const win = await this.getWindow(w);
      const winByteStart = w * this.windowBytes;
      const copyStart = Math.max(0, safeOffset - winByteStart);
      const copyEnd = Math.min(win.byteLength, safeOffset + clampedLength - winByteStart);
      if (copyEnd > copyStart) {
        const slice = win.subarray(copyStart, copyEnd);
        out.set(slice, written);
        written += slice.byteLength;
      }
    }
    return written === out.byteLength ? out : out.subarray(0, written);
  }

  async readAll(): Promise<Uint8Array> {
    if (this.inner.readAll) {
      return this.inner.readAll();
    }
    return this.readLargeChunked(0, this.inner.size);
  }

  private async readLargeChunked(offset: number, length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    let pos = 0;
    while (pos < length) {
      const ask = Math.min(this.maxChunkBytes, length - pos);
      const chunk = await this.inner.read(offset + pos, ask);
      if (chunk.byteLength === 0) break;
      out.set(chunk, pos);
      pos += chunk.byteLength;
      if (chunk.byteLength < ask) break;
    }
    return pos === out.byteLength ? out : out.subarray(0, pos);
  }

  private async getWindow(winIndex: number): Promise<Uint8Array> {
    const existing = this.cache.get(winIndex);
    if (existing !== undefined) {
      // Refresh LRU position
      this.cache.delete(winIndex);
      this.cache.set(winIndex, existing);
      return existing;
    }

    const start = winIndex * this.windowBytes;
    const knownSize = this.inner.size;
    const ask =
      knownSize > 0 ? Math.min(this.windowBytes, Math.max(0, knownSize - start)) : this.windowBytes;
    if (ask <= 0) return new Uint8Array(0);

    const fetched = await this.inner.read(start, ask);
    this.insertWindow(winIndex, fetched);
    return fetched;
  }

  private insertWindow(winIndex: number, bytes: Uint8Array): void {
    while (this.cachedBytes + bytes.byteLength > this.maxCacheBytes && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      const evicted = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      if (evicted) {
        this.cachedBytes -= evicted.byteLength;
      }
    }
    this.cache.set(winIndex, bytes);
    this.cachedBytes += bytes.byteLength;
  }
}

export interface HttpRangeByteSourceOptions {
  readonly url: string;
  readonly size: number;
  readonly fetchImpl?: typeof fetch;
}

export function createHttpRangeByteSource(options: HttpRangeByteSourceOptions): ByteSource {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  let knownSize = Math.max(0, options.size);

  const raw: ByteSource = {
    get size(): number {
      return knownSize;
    },
    async read(offset: number, length: number): Promise<Uint8Array> {
      if (length <= 0) return new Uint8Array(0);
      if (knownSize > 0 && offset >= knownSize) return new Uint8Array(0);
      const start = Math.max(0, Math.trunc(offset));
      const end =
        knownSize > 0
          ? Math.min(knownSize - 1, start + Math.trunc(length) - 1)
          : start + Math.trunc(length) - 1;

      const resp = await fetchFn(options.url, {
        method: 'GET',
        headers: {
          Range: `bytes=${start}-${end}`,
        },
      });

      if (resp.status === 416) {
        return new Uint8Array(0);
      }
      if (resp.status === 404) {
        throw new MiniBookError('not-found', `Book file not found: ${options.url}`);
      }
      if (!resp.ok && resp.status !== 206) {
        throw new MiniBookError('network', `Range fetch failed with HTTP ${resp.status}`);
      }

      const contentRange = resp.headers.get('content-range');
      if (contentRange) {
        const m = /\/(\d+)$/.exec(contentRange.trim());
        if (m) {
          const total = Number.parseInt(m[1]!, 10);
          if (Number.isFinite(total) && total >= 0) {
            knownSize = total;
          }
        }
      }

      const buf = new Uint8Array(await resp.arrayBuffer());
      if (resp.status === 200 && (start > 0 || buf.byteLength > end - start + 1)) {
        return buf.subarray(start, Math.min(buf.byteLength, end + 1));
      }
      return buf;
    },
    async readAll(): Promise<Uint8Array> {
      const resp = await fetchFn(options.url, { method: 'GET' });
      if (resp.status === 404) {
        throw new MiniBookError('not-found', `Book file not found: ${options.url}`);
      }
      if (!resp.ok) {
        throw new MiniBookError('network', `Whole-file fetch failed with HTTP ${resp.status}`);
      }
      const out = new Uint8Array(await resp.arrayBuffer());
      knownSize = out.byteLength;
      return out;
    },
  };

  return new CoalescedByteSource(raw);
}

export function createBrowserFileByteSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    async read(offset: number, length: number): Promise<Uint8Array> {
      if (length <= 0 || offset >= blob.size) return new Uint8Array(0);
      const start = Math.max(0, Math.trunc(offset));
      const end = Math.min(blob.size, start + Math.trunc(length));
      const ab = await blob.slice(start, end).arrayBuffer();
      return new Uint8Array(ab);
    },
    async readAll(): Promise<Uint8Array> {
      return new Uint8Array(await blob.arrayBuffer());
    },
  };
}
