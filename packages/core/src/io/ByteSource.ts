import { MiniBookError } from '../errors.js';
import type { BookId, ByteSource } from '../types.js';
import { LruCache } from '../util/lru.js';
import { sha1Hex } from '../util/sha1.js';
import { concatBytes } from './binary.js';

export interface WindowedByteSourceOptions {
  /** Window alignment size in bytes (default `65536` = 64 KiB). */
  readonly windowBytes?: number;
  /** Maximum cached bytes across windows (default `2097152` = 2 MiB). */
  readonly maxCacheBytes?: number;
  /** Maximum bytes requested per underlying `read` call (default `1048576` = 1 MiB). */
  readonly maxReadBytes?: number;
}

const DEFAULT_WINDOW_BYTES = 64 * 1024; // 64 KiB
const DEFAULT_MAX_CACHE_BYTES = 2 * 1024 * 1024; // 2 MiB
const DEFAULT_MAX_READ_BYTES = 1024 * 1024; // 1 MiB

/**
 * Read-coalescing, LRU-cached `ByteSource` wrapper (`ARCHITECTURE.md` §3.3):
 *   1. Small reads are aligned to 64 KiB windows and cached in a 2 MiB LRU so header/EOCD/PDB
 *      table probing reuses windows instead of issuing bridge-call storms.
 *   2. Multi-window reads coalesce contiguous missing windows into `<= 1 MiB` calls and populate
 *      the 64 KiB window cache along the way.
 *   3. Large reads (`> 1 MiB`) are split into sequential `<= 1 MiB` calls.
 */
export class WindowedByteSource implements ByteSource {
  readonly size: number;
  private readonly inner: ByteSource;
  private readonly windowBytes: number;
  private readonly maxReadBytes: number;
  private readonly cache: LruCache<number, Uint8Array>;
  private readonly inflight = new Map<number, Promise<Uint8Array>>();

  constructor(inner: ByteSource, options?: WindowedByteSourceOptions) {
    this.inner = inner;
    this.size = inner.size;
    this.windowBytes = Math.max(4096, options?.windowBytes ?? DEFAULT_WINDOW_BYTES);
    const maxCacheBytes = Math.max(this.windowBytes * 2, options?.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES);
    this.maxReadBytes = Math.max(this.windowBytes, options?.maxReadBytes ?? DEFAULT_MAX_READ_BYTES);
    this.cache = new LruCache<number, Uint8Array>(maxCacheBytes, (buf) => buf.byteLength);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || !Number.isFinite(offset) || !Number.isFinite(length)) {
      throw new MiniBookError('invalid-argument', `Invalid ByteSource range: offset=${offset}, length=${length}`);
    }
    if (length <= 0 || offset >= this.size) {
      return new Uint8Array(0);
    }
    const clampedEnd = Math.min(this.size, offset + length);
    const actualLength = clampedEnd - offset;

    // Very large reads (> maxCacheBytes / 2): bypass window cache and stream sequential <= 1 MiB chunks
    if (actualLength > this.maxReadBytes) {
      const parts: Uint8Array[] = [];
      let cursor = offset;
      while (cursor < clampedEnd) {
        const step = Math.min(this.maxReadBytes, clampedEnd - cursor);
        const chunk = await this.inner.read(cursor, step);
        parts.push(chunk);
        if (chunk.byteLength === 0) break;
        cursor += chunk.byteLength;
      }
      return concatBytes(parts).subarray(0, actualLength);
    }

    const firstWin = Math.floor(offset / this.windowBytes);
    const lastWin = Math.floor((clampedEnd - 1) / this.windowBytes);

    if (firstWin === lastWin) {
      const win = await this.fetchWindow(firstWin);
      const localStart = offset - firstWin * this.windowBytes;
      const localEnd = Math.min(win.byteLength, localStart + actualLength);
      return win.subarray(localStart, localEnd);
    }

    // Coalesce contiguous missing windows into <= maxReadBytes batch reads
    let w = firstWin;
    while (w <= lastWin) {
      if (this.cache.has(w) || this.inflight.has(w)) {
        w++;
        continue;
      }
      let runEnd = w;
      while (
        runEnd + 1 <= lastWin &&
        !this.cache.has(runEnd + 1) &&
        !this.inflight.has(runEnd + 1) &&
        (runEnd + 2 - w) * this.windowBytes <= this.maxReadBytes
      ) {
        runEnd++;
      }
      await this.fetchWindowRun(w, runEnd);
      w = runEnd + 1;
    }

    const slices: Uint8Array[] = [];
    for (let wi = firstWin; wi <= lastWin; wi++) {
      const win = await this.fetchWindow(wi);
      const winStart = wi * this.windowBytes;
      const sliceStart = Math.max(0, offset - winStart);
      const sliceEnd = Math.min(win.byteLength, clampedEnd - winStart);
      if (sliceEnd > sliceStart) {
        slices.push(win.subarray(sliceStart, sliceEnd));
      }
    }
    return concatBytes(slices);
  }

  async readAll(): Promise<Uint8Array> {
    if (this.inner.readAll) {
      return this.inner.readAll();
    }
    return this.read(0, this.size);
  }

  private fetchWindow(winIndex: number): Promise<Uint8Array> {
    const cached = this.cache.get(winIndex);
    if (cached) return Promise.resolve(cached);
    const pending = this.inflight.get(winIndex);
    if (pending) return pending;

    const start = winIndex * this.windowBytes;
    const len = Math.min(this.windowBytes, Math.max(0, this.size - start));
    const req = this.inner
      .read(start, len)
      .then((buf) => {
        this.inflight.delete(winIndex);
        this.cache.set(winIndex, buf);
        return buf;
      })
      .catch((err) => {
        this.inflight.delete(winIndex);
        throw err;
      });
    this.inflight.set(winIndex, req);
    return req;
  }

  private async fetchWindowRun(startWin: number, endWin: number): Promise<void> {
    if (startWin === endWin) {
      await this.fetchWindow(startWin);
      return;
    }
    const byteStart = startWin * this.windowBytes;
    const byteEnd = Math.min(this.size, (endWin + 1) * this.windowBytes);
    const combined = await this.inner.read(byteStart, byteEnd - byteStart);
    for (let wi = startWin; wi <= endWin; wi++) {
      const relStart = (wi - startWin) * this.windowBytes;
      const relEnd = Math.min(combined.byteLength, relStart + this.windowBytes);
      if (relStart <= combined.byteLength) {
        // Copy or slice window into cache
        this.cache.set(wi, combined.subarray(relStart, relEnd));
      }
    }
  }
}

export function memoryByteSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.byteLength,
    async read(offset: number, length: number): Promise<Uint8Array> {
      if (offset < 0) throw new MiniBookError('invalid-argument', `Negative read offset ${offset}`);
      if (length <= 0 || offset >= bytes.byteLength) return new Uint8Array(0);
      const end = Math.min(bytes.byteLength, offset + length);
      return bytes.subarray(offset, end);
    },
    async readAll(): Promise<Uint8Array> {
      return bytes;
    },
  };
}

export function sliceByteSource(inner: ByteSource, sliceOffset: number, sliceLength: number): ByteSource {
  const clampedStart = Math.max(0, Math.min(inner.size, sliceOffset));
  const clampedSize = Math.max(0, Math.min(inner.size - clampedStart, sliceLength));
  return {
    size: clampedSize,
    async read(offset: number, length: number): Promise<Uint8Array> {
      if (offset < 0) throw new MiniBookError('invalid-argument', `Negative read offset ${offset}`);
      if (length <= 0 || offset >= clampedSize) return new Uint8Array(0);
      const len = Math.min(length, clampedSize - offset);
      return inner.read(clampedStart + offset, len);
    },
    async readAll(): Promise<Uint8Array> {
      return inner.read(clampedStart, clampedSize);
    },
  };
}

/**
 * Stable book deduplication ID (`ARCHITECTURE.md` §7.1):
 * `"b_" + sha1Hex(u64be(size) || first 256 KiB || last 256 KiB)`.
 */
export async function computeBookId(src: ByteSource): Promise<BookId> {
  const SAMPLE = 256 * 1024;
  const sizeBuf = new Uint8Array(8);
  const view = new DataView(sizeBuf.buffer);
  view.setUint32(0, Math.floor(src.size / 0x100000000), false);
  view.setUint32(4, src.size >>> 0, false);

  if (src.size <= SAMPLE * 2) {
    const full = await src.read(0, src.size);
    return `b_${sha1Hex(concatBytes([sizeBuf, full]))}`;
  }
  const head = await src.read(0, SAMPLE);
  const tail = await src.read(src.size - SAMPLE, SAMPLE);
  return `b_${sha1Hex(concatBytes([sizeBuf, head, tail]))}`;
}
