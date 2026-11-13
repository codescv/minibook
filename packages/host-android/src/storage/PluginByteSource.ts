/**
 * Bounded native random-access `ByteSource` (`ARCHITECTURE.md` §3.3):
 *   1. Read coalescing: small random probes are aligned to 64 KiB windows and cached in a 2 MiB LRU.
 *   2. Bounded chunks: requests larger than 1 MiB are split into sequential <= 1 MiB `fs.read` calls
 *      (strictly honouring the native `length <= 1_048_576` contract).
 *   3. `readAll()`: streams whole-file via `fetch(fileUrl)` without `Range` or Base64 overhead when
 *      available in the WebView, falling back to sequential 1 MiB `fs.read` chunks in headless tests.
 */
import type { ByteSource } from '@minibook/core';
import type { MiniBookPlugin } from '../plugin-types.js';
import { base64ToBytes } from './base64.js';

export const PLUGIN_WINDOW_BYTES = 64 * 1024;
export const PLUGIN_MAX_CACHE_BYTES = 2 * 1024 * 1024;
export const PLUGIN_MAX_READ_BYTES = 1024 * 1024;

export interface PluginByteSourceOptions {
  readonly plugin: MiniBookPlugin;
  readonly path: string;
  readonly size: number;
  readonly windowBytes?: number;
  readonly maxCacheBytes?: number;
  readonly maxReadBytes?: number;
  readonly fetchImpl?: typeof fetch | null;
}

export class PluginByteSource implements ByteSource {
  readonly size: number;
  readonly path: string;
  private readonly plugin: MiniBookPlugin;
  private readonly windowBytes: number;
  private readonly maxCacheBytes: number;
  private readonly maxReadBytes: number;
  private readonly fetchImpl: typeof fetch | null | undefined;
  private readonly windows = new Map<number, Uint8Array>();
  private readonly inflightWindows = new Map<number, Promise<Uint8Array>>();
  private cachedBytes = 0;

  constructor(options: PluginByteSourceOptions) {
    this.plugin = options.plugin;
    this.path = options.path;
    this.size = Math.max(0, Math.trunc(options.size));
    this.windowBytes = options.windowBytes ?? PLUGIN_WINDOW_BYTES;
    this.maxCacheBytes = options.maxCacheBytes ?? PLUGIN_MAX_CACHE_BYTES;
    this.maxReadBytes = Math.min(
      PLUGIN_MAX_READ_BYTES,
      options.maxReadBytes ?? PLUGIN_MAX_READ_BYTES,
    );
    this.fetchImpl = options.fetchImpl;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (length <= 0 || this.size === 0) {
      return new Uint8Array(0);
    }
    const start = Math.max(0, Math.trunc(offset));
    if (start >= this.size) {
      return new Uint8Array(0);
    }
    const want = Math.min(Math.trunc(length), this.size - start);
    if (want <= 0) {
      return new Uint8Array(0);
    }

    // Large sequential reads (> 2 windows) bypass the 64 KiB window cache and read in <= 1 MiB chunks
    if (want > this.windowBytes * 2) {
      return this.readSequentialChunks(start, want);
    }

    const firstWin = Math.floor(start / this.windowBytes);
    const lastWin = Math.floor((start + want - 1) / this.windowBytes);

    if (firstWin === lastWin) {
      const win = await this.loadWindow(firstWin);
      const relStart = start - firstWin * this.windowBytes;
      const relEnd = Math.min(win.byteLength, relStart + want);
      return win.slice(relStart, relEnd);
    }

    const out = new Uint8Array(want);
    let written = 0;
    for (let w = firstWin; w <= lastWin; w++) {
      const win = await this.loadWindow(w);
      const winStart = w * this.windowBytes;
      const copyFrom = Math.max(0, start - winStart);
      const copyTo = Math.min(win.byteLength, start + want - winStart);
      if (copyTo > copyFrom) {
        const sub = win.subarray(copyFrom, copyTo);
        out.set(sub, written);
        written += sub.byteLength;
      }
    }
    return written === out.byteLength ? out : out.subarray(0, written);
  }

  async readAll(): Promise<Uint8Array> {
    if (this.size === 0) return new Uint8Array(0);

    const fetchFn =
      this.fetchImpl === null
        ? null
        : (this.fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null));

    if (fetchFn) {
      try {
        const { url } = await this.plugin.fs.fileUrl({ path: this.path });
        if (url && (url.startsWith('https://') || url.startsWith('http://') || url.startsWith('capacitor://'))) {
          const resp = await fetchFn(url);
          if (resp.ok) {
            return new Uint8Array(await resp.arrayBuffer());
          }
        }
      } catch {
        // Fall back to sequential <= 1 MiB native reads
      }
    }

    return this.readSequentialChunks(0, this.size);
  }

  private async readSequentialChunks(offset: number, length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    let pos = 0;
    while (pos < length) {
      const ask = Math.min(this.maxReadBytes, length - pos);
      const res = await this.plugin.fs.read({
        path: this.path,
        offset: offset + pos,
        length: ask,
      });
      const decoded = base64ToBytes(res.base64);
      if (decoded.byteLength === 0) break;
      const copyLen = Math.min(decoded.byteLength, length - pos);
      out.set(decoded.subarray(0, copyLen), pos);
      pos += copyLen;
      if (decoded.byteLength < ask) break;
    }
    return pos === out.byteLength ? out : out.subarray(0, pos);
  }

  private async loadWindow(winIndex: number): Promise<Uint8Array> {
    const hit = this.windows.get(winIndex);
    if (hit !== undefined) {
      this.windows.delete(winIndex);
      this.windows.set(winIndex, hit);
      return hit;
    }

    const existingFlight = this.inflightWindows.get(winIndex);
    if (existingFlight) {
      return existingFlight;
    }

    const start = winIndex * this.windowBytes;
    const ask = Math.min(this.windowBytes, Math.max(0, this.size - start));
    if (ask <= 0) return new Uint8Array(0);

    const flight = this.plugin.fs
      .read({
        path: this.path,
        offset: start,
        length: ask,
      })
      .then((res) => {
        const bytes = base64ToBytes(res.base64);
        this.storeWindow(winIndex, bytes);
        return bytes;
      })
      .finally(() => {
        this.inflightWindows.delete(winIndex);
      });

    this.inflightWindows.set(winIndex, flight);
    return flight;
  }

  private storeWindow(winIndex: number, bytes: Uint8Array): void {
    while (this.cachedBytes + bytes.byteLength > this.maxCacheBytes && this.windows.size > 0) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.windows.get(oldest);
      this.windows.delete(oldest);
      if (evicted) {
        this.cachedBytes -= evicted.byteLength;
      }
    }
    this.windows.set(winIndex, bytes);
    this.cachedBytes += bytes.byteLength;
  }
}
