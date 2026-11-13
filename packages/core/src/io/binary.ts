import { MiniBookError } from '../errors.js';

/**
 * Safe bounds-checked binary cursor over a `Uint8Array`, plus MOBI/KF8 variable-width
 * integer decoders and byte concatenation helpers.
 */
export class BinaryReader {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  offset = 0;

  constructor(bytes: Uint8Array, initialOffset = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = initialOffset;
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  get remaining(): number {
    return Math.max(0, this.bytes.byteLength - this.offset);
  }

  private ensure(count: number, at = this.offset): void {
    if (at < 0 || at + count > this.bytes.byteLength) {
      throw new MiniBookError('corrupt-book', `Unexpected EOF at byte ${at} (+${count} > ${this.bytes.byteLength})`);
    }
  }

  seek(pos: number): void {
    if (pos < 0 || pos > this.bytes.byteLength) {
      throw new MiniBookError('corrupt-book', `Invalid seek offset ${pos}`);
    }
    this.offset = pos;
  }

  skip(delta: number): void {
    this.seek(this.offset + delta);
  }

  u8At(at: number): number {
    this.ensure(1, at);
    return this.view.getUint8(at);
  }

  u16beAt(at: number): number {
    this.ensure(2, at);
    return this.view.getUint16(at, false);
  }

  u16leAt(at: number): number {
    this.ensure(2, at);
    return this.view.getUint16(at, true);
  }

  u32beAt(at: number): number {
    this.ensure(4, at);
    return this.view.getUint32(at, false);
  }

  u32leAt(at: number): number {
    this.ensure(4, at);
    return this.view.getUint32(at, true);
  }

  u64leAt(at: number): number {
    this.ensure(8, at);
    const lo = this.view.getUint32(at, true);
    const hi = this.view.getUint32(at + 4, true);
    return hi * 0x100000000 + lo;
  }

  u64beAt(at: number): number {
    this.ensure(8, at);
    const hi = this.view.getUint32(at, false);
    const lo = this.view.getUint32(at + 4, false);
    return hi * 0x100000000 + lo;
  }

  u8(): number {
    const v = this.u8At(this.offset);
    this.offset += 1;
    return v;
  }

  u16be(): number {
    const v = this.u16beAt(this.offset);
    this.offset += 2;
    return v;
  }

  u16le(): number {
    const v = this.u16leAt(this.offset);
    this.offset += 2;
    return v;
  }

  u32be(): number {
    const v = this.u32beAt(this.offset);
    this.offset += 4;
    return v;
  }

  u32le(): number {
    const v = this.u32leAt(this.offset);
    this.offset += 4;
    return v;
  }

  slice(length: number): Uint8Array {
    this.ensure(length);
    const sub = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return sub;
  }

  sliceAt(at: number, length: number): Uint8Array {
    this.ensure(length, at);
    return this.bytes.subarray(at, at + length);
  }

  asciiAt(at: number, length: number): string {
    this.ensure(length, at);
    let s = '';
    for (let i = 0; i < length; i++) {
      s += String.fromCharCode(this.bytes[at + i]!);
    }
    return s;
  }

  ascii(length: number): string {
    const s = this.asciiAt(this.offset, length);
    this.offset += length;
    return s;
  }

  cstrAt(at: number, maxLen: number): string {
    const end = Math.min(this.bytes.byteLength, at + maxLen);
    let stop = at;
    while (stop < end && this.bytes[stop] !== 0) stop++;
    return new TextDecoder('utf-8', { fatal: false }).decode(this.bytes.subarray(at, stop));
  }
}

/**
 * Forward-encoded MOBI variable-width integer (high bit `0x80` marks the LAST byte!).
 * Used in MOBI/KF8 `INDX` entries and `CNCX` length prefixes.
 */
export function readMobiVarIntForward(
  bytes: Uint8Array,
  startOffset: number,
): { readonly value: number; readonly nextOffset: number } {
  let value = 0;
  let pos = startOffset;
  const maxEnd = Math.min(bytes.byteLength, startOffset + 5);
  while (pos < maxEnd) {
    const b = bytes[pos++]!;
    value = (value * 128) + (b & 0x7f);
    if ((b & 0x80) !== 0) {
      return { value, nextOffset: pos };
    }
  }
  throw new MiniBookError('corrupt-book', `Unterminated forward variable-width int at ${startOffset}`);
}

/**
 * Backward-encoded MOBI variable-width integer (high bit `0x80` marks the FIRST byte of the varint
 * when scanning backward from `endOffset - 1`).
 * Used when stripping MOBI trailing record entries (`ARCHITECTURE.md` §4.4).
 */
export function readMobiVarIntBackward(
  bytes: Uint8Array,
  endOffset: number,
): { readonly value: number; readonly bytesConsumed: number } {
  let value = 0;
  let shift = 0;
  let consumed = 0;
  let pos = endOffset - 1;
  while (pos >= 0 && consumed < 4) {
    const b = bytes[pos]!;
    consumed++;
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) !== 0) {
      return { value, bytesConsumed: consumed };
    }
    shift += 7;
    pos--;
  }
  return { value, bytesConsumed: consumed };
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  let total = 0;
  for (let i = 0; i < chunks.length; i++) total += chunks[i]!.byteLength;
  const out = new Uint8Array(total);
  let pos = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}
