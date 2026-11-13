/**
 * Atomic file storage under `<dataDir>/books/<id>/` and `<dataDir>/tmp/<ticketId>/`
 * (`ARCHITECTURE.md` §3.3, §7.1, §7.3).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { MiniBookError, type BookId, type ByteSource } from '@minibook/core';

const BOOK_ID_SAMPLE_BYTES = 256 * 1024;
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024; // 512 MiB safety cap
const SAFE_DERIVED_NAMES = new Set(['text.bin']);
const SAFE_ID_RE = /^[a-zA-Z0-9_-]{2,80}$/;

export function canonicalBookExtension(fileName: string, fallbackFormat?: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.fb2.zip')) return 'fb2.zip';
  const rawExt = extname(lower).replace(/^\./, '');
  if (/^[a-z0-9]{1,12}$/.test(rawExt)) {
    return rawExt;
  }
  if (fallbackFormat === 'kf8') return 'azw3';
  return fallbackFormat ?? 'epub';
}

export function coverExtensionForMime(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower.includes('png')) return 'png';
  if (lower.includes('webp')) return 'webp';
  if (lower.includes('gif')) return 'gif';
  if (lower.includes('svg')) return 'svg';
  return 'jpg';
}

/**
 * Computes `"b_" + sha1Hex(size + first256KiB + last256KiB)` (`ARCHITECTURE.md` §7.1).
 * Matches `@minibook/core`'s `computeBookId` deterministically from a local file descriptor.
 */
export function computeLocalFileBookId(filePath: string): BookId {
  const st = statSync(filePath);
  const size = st.size;
  const hash = createHash('sha1');

  const sizeHeader = Buffer.allocUnsafe(8);
  sizeHeader.writeBigUInt64BE(BigInt(size), 0);
  hash.update(sizeHeader);

  if (size > 0) {
    const fd = openSync(filePath, 'r');
    try {
      const firstLen = Math.min(size, BOOK_ID_SAMPLE_BYTES);
      const firstBuf = Buffer.allocUnsafe(firstLen);
      const n1 = readSync(fd, firstBuf, 0, firstLen, 0);
      hash.update(firstBuf.subarray(0, n1));

      const lastStart = Math.max(0, size - BOOK_ID_SAMPLE_BYTES);
      const lastLen = size - lastStart;
      const lastBuf = Buffer.allocUnsafe(lastLen);
      const n2 = readSync(fd, lastBuf, 0, lastLen, lastStart);
      hash.update(lastBuf.subarray(0, n2));
    } finally {
      closeSync(fd);
    }
  }

  return `b_${hash.digest('hex')}`;
}

export function createNodeFileByteSource(filePath: string): ByteSource {
  const st = statSync(filePath);
  const totalSize = st.size;
  return {
    size: totalSize,
    async read(offset: number, length: number): Promise<Uint8Array> {
      if (length <= 0 || offset >= totalSize) {
        return new Uint8Array(0);
      }
      const safeStart = Math.max(0, Math.trunc(offset));
      const toRead = Math.min(Math.trunc(length), totalSize - safeStart);
      if (toRead <= 0) return new Uint8Array(0);
      const buf = Buffer.allocUnsafe(toRead);
      const fd = openSync(filePath, 'r');
      try {
        let total = 0;
        while (total < toRead) {
          const n = readSync(fd, buf, total, toRead - total, safeStart + total);
          if (n <= 0) break;
          total += n;
        }
        return new Uint8Array(buf.buffer, buf.byteOffset, total);
      } finally {
        closeSync(fd);
      }
    },
    async readAll(): Promise<Uint8Array> {
      const buf = readFileSync(filePath);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
  };
}

export interface StagedUpload {
  readonly ticketId: string;
  readonly fileName: string;
  readonly stagedFilePath: string;
  readonly size: number;
  readonly bookId: BookId;
}

export class BookFileStorage {
  readonly booksRoot: string;
  readonly tmpRoot: string;
  private readonly tickets = new Map<string, StagedUpload>();

  constructor(dataDir: string) {
    this.booksRoot = resolve(dataDir, 'books');
    this.tmpRoot = resolve(dataDir, 'tmp');
    mkdirSync(this.booksRoot, { recursive: true });
    mkdirSync(this.tmpRoot, { recursive: true });
  }

  private assertSafeId(id: string): void {
    if (!SAFE_ID_RE.test(id)) {
      throw new MiniBookError('invalid-argument', `Invalid identifier: ${id}`);
    }
  }

  private bookDir(bookId: BookId): string {
    this.assertSafeId(bookId);
    const dir = resolve(this.booksRoot, bookId);
    if (!dir.startsWith(`${this.booksRoot}/`)) {
      throw new MiniBookError('invalid-argument', `Path outside books root: ${bookId}`);
    }
    return dir;
  }

  private ticketDir(ticketId: string): string {
    this.assertSafeId(ticketId);
    const dir = resolve(this.tmpRoot, ticketId);
    if (!dir.startsWith(`${this.tmpRoot}/`)) {
      throw new MiniBookError('invalid-argument', `Path outside tmp root: ${ticketId}`);
    }
    return dir;
  }

  async stageStream(
    fileName: string,
    stream: ReadableStream<Uint8Array> | null,
  ): Promise<StagedUpload> {
    const ticketId = `t_${randomUUID().replace(/-/g, '')}`;
    const dir = this.ticketDir(ticketId);
    mkdirSync(dir, { recursive: true });
    const stagedFilePath = join(dir, 'source.bin');

    let total = 0;
    const fd = openSync(stagedFilePath, 'w', 0o644);
    try {
      if (stream) {
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
              total += value.byteLength;
              if (total > MAX_UPLOAD_BYTES) {
                throw new MiniBookError('too-large', 'Book file exceeds 512 MiB limit');
              }
              writeSync(fd, value);
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    closeSync(fd);

    const bookId = computeLocalFileBookId(stagedFilePath);
    const staged: StagedUpload = {
      ticketId,
      fileName: basename(fileName || 'book.epub'),
      stagedFilePath,
      size: total,
      bookId,
    };
    this.tickets.set(ticketId, staged);
    return staged;
  }

  stageLocalFileCopy(sourcePath: string, displayName?: string): StagedUpload {
    if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
      throw new MiniBookError('not-found', `Book file not found: ${sourcePath}`);
    }
    const st = statSync(sourcePath);
    if (st.size > MAX_UPLOAD_BYTES) {
      throw new MiniBookError('too-large', 'Book file exceeds 512 MiB limit');
    }
    const ticketId = `t_${randomUUID().replace(/-/g, '')}`;
    const dir = this.ticketDir(ticketId);
    mkdirSync(dir, { recursive: true });
    const stagedFilePath = join(dir, 'source.bin');
    copyFileSync(sourcePath, stagedFilePath);
    const bookId = computeLocalFileBookId(stagedFilePath);
    const staged: StagedUpload = {
      ticketId,
      fileName: basename(displayName ?? sourcePath),
      stagedFilePath,
      size: st.size,
      bookId,
    };
    this.tickets.set(ticketId, staged);
    return staged;
  }

  getTicket(ticketId: string): StagedUpload {
    const ticket = this.tickets.get(ticketId);
    if (!ticket || !existsSync(ticket.stagedFilePath)) {
      throw new MiniBookError('not-found', `Import ticket not found: ${ticketId}`);
    }
    return ticket;
  }

  appendDerived(ticketId: string, name: string, chunk: Uint8Array): number {
    if (!SAFE_DERIVED_NAMES.has(name)) {
      throw new MiniBookError('invalid-argument', `Unsupported derived file name: ${name}`);
    }
    const ticket = this.getTicket(ticketId);
    const derivedPath = join(this.ticketDir(ticket.ticketId), `derived_${name}`);
    const existingSize = existsSync(derivedPath) ? statSync(derivedPath).size : 0;
    if (existingSize + chunk.byteLength > 64 * 1024 * 1024) {
      throw new MiniBookError('too-large', 'Derived stream exceeds 64 MiB cap');
    }
    appendFileSync(derivedPath, chunk);
    return existingSize + chunk.byteLength;
  }

  commitTicket(params: {
    readonly ticketId: string;
    readonly bookId: BookId;
    readonly fileExt: string;
    readonly cover: { readonly bytes: Uint8Array; readonly mime: string } | null;
  }): { readonly derivedTextSize: number } {
    const ticket = this.getTicket(params.ticketId);
    const tDir = this.ticketDir(ticket.ticketId);
    const bDir = this.bookDir(params.bookId);

    const destBookPath = join(bDir, `book.${params.fileExt}`);
    const stagedDerived = join(tDir, 'derived_text.bin');
    let derivedTextSize = 0;

    if (!existsSync(destBookPath)) {
      mkdirSync(bDir, { recursive: true });
      renameSync(ticket.stagedFilePath, destBookPath);

      if (existsSync(stagedDerived)) {
        derivedTextSize = statSync(stagedDerived).size;
        renameSync(stagedDerived, join(bDir, 'text.bin'));
      }

      if (params.cover && params.cover.bytes.byteLength > 0) {
        const coverExt = coverExtensionForMime(params.cover.mime);
        const coverPath = join(bDir, `cover.${coverExt}`);
        const tmpCover = `${coverPath}.tmp`;
        const fd = openSync(tmpCover, 'w', 0o644);
        try {
          writeSync(fd, params.cover.bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmpCover, coverPath);
      }
    } else if (existsSync(join(bDir, 'text.bin'))) {
      derivedTextSize = statSync(join(bDir, 'text.bin')).size;
    }

    this.abortTicket(params.ticketId);
    return { derivedTextSize };
  }

  abortTicket(ticketId: string): void {
    this.tickets.delete(ticketId);
    try {
      const dir = this.ticketDir(ticketId);
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore invalid or already removed ticket dir
    }
  }

  resolveBookFilePath(bookId: BookId, fileExt: string, part: 'book' | 'text' = 'book'): string | null {
    const dir = this.bookDir(bookId);
    const target = part === 'text' ? join(dir, 'text.bin') : join(dir, `book.${fileExt}`);
    return existsSync(target) ? target : null;
  }

  resolveCoverPath(bookId: BookId, coverMime: string | null | undefined): string | null {
    const dir = this.bookDir(bookId);
    if (!existsSync(dir)) return null;
    if (coverMime) {
      const direct = join(dir, `cover.${coverExtensionForMime(coverMime)}`);
      if (existsSync(direct)) return direct;
    }
    for (const ext of ['jpg', 'png', 'webp', 'gif', 'svg']) {
      const p = join(dir, `cover.${ext}`);
      if (existsSync(p)) return p;
    }
    return null;
  }

  removeBookFiles(bookId: BookId): void {
    const dir = this.bookDir(bookId);
    rmSync(dir, { recursive: true, force: true });
  }

  totalBooksBytes(): number {
    return sumDirectoryBytes(this.booksRoot);
  }
}

function sumDirectoryBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        total += sumDirectoryBytes(full);
      } else if (st.isFile()) {
        total += st.size;
      }
    } catch {
      // ignore concurrent unlink
    }
  }
  return total;
}
