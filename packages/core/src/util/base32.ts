/**
 * Kindle base-32 (`0-9A-V`), Base64, and Hex codecs (pure TS, zero `Buffer` / `atob` size limits).
 */

const KINDLE_B32_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUV';

export function decodeKindleBase32(str: string): number {
  let value = 0;
  const trimmed = str.trim();
  if (trimmed.length === 0) return Number.NaN;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    let digit = -1;
    if (code >= 48 && code <= 57) {
      digit = code - 48;
    } else if (code >= 65 && code <= 86) {
      digit = code - 65 + 10;
    } else if (code >= 97 && code <= 118) {
      digit = code - 97 + 10;
    } else {
      return Number.NaN;
    }
    value = value * 32 + digit;
  }
  return value;
}

export function encodeKindleBase32(num: number, width = 4): string {
  let n = Math.max(0, Math.floor(num));
  if (n === 0) return '0'.repeat(Math.max(1, width));
  let out = '';
  while (n > 0) {
    out = KINDLE_B32_ALPHABET[n % 32]! + out;
    n = Math.floor(n / 32);
  }
  return out.padStart(width, '0');
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < B64_CHARS.length; i++) {
  B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;
}
B64_LOOKUP['-'.charCodeAt(0)] = 62;
B64_LOOKUP['_'.charCodeAt(0)] = 63;

export function bytesToBase64(bytes: Uint8Array): string {
  const len = bytes.length;
  let out = '';
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      B64_CHARS[(n >>> 18) & 63]! +
      B64_CHARS[(n >>> 12) & 63]! +
      B64_CHARS[(n >>> 6) & 63]! +
      B64_CHARS[n & 63]!;
  }
  const rem = len - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64_CHARS[(n >>> 18) & 63]! + B64_CHARS[(n >>> 12) & 63]! + '==';
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64_CHARS[(n >>> 18) & 63]! + B64_CHARS[(n >>> 12) & 63]! + B64_CHARS[(n >>> 6) & 63]! + '=';
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  // Ignore whitespace (crucial for multi-line FB2 `<binary>` blocks)
  let validCount = 0;
  for (let i = 0; i < b64.length; i++) {
    const c = b64.charCodeAt(i);
    if (c < 128 && B64_LOOKUP[c]! >= 0) validCount++;
  }
  const outLen = Math.floor((validCount * 3) / 4);
  const out = new Uint8Array(outLen);
  let acc = 0;
  let bits = 0;
  let writeIdx = 0;
  for (let i = 0; i < b64.length; i++) {
    const c = b64.charCodeAt(i);
    if (c >= 128) continue;
    const v = B64_LOOKUP[c]!;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (writeIdx < outLen) {
        out[writeIdx++] = (acc >>> bits) & 0xff;
      }
    }
  }
  return writeIdx === outLen ? out : out.subarray(0, writeIdx);
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const len = Math.floor(clean.length / 2);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, '0');
  }
  return s;
}
