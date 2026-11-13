import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** Interleaved RGBA bytes (`width * height * 4`). */
  readonly rgba: Uint8Array;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Pure-Node PNG decoder (`node:zlib` only, zero native C++ addons) for
 * pixel-exact E-Ink 2-colour `#000000` / `#FFFFFF` screenshot histogram verification.
 */
export function decodePng(buffer: Uint8Array): DecodedPng {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (
    buffer[0] !== 0x89 ||
    buffer[1] !== 0x50 ||
    buffer[2] !== 0x4e ||
    buffer[3] !== 0x47
  ) {
    throw new Error('Invalid PNG signature');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let palette: Uint8Array | null = null;
  const idatChunks: Uint8Array[] = [];

  let offset = 8;
  while (offset + 8 <= buffer.byteLength) {
    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(
      buffer[offset + 4]!,
      buffer[offset + 5]!,
      buffer[offset + 6]!,
      buffer[offset + 7]!,
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunk = buffer.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      width = view.getUint32(dataStart, false);
      height = view.getUint32(dataStart + 4, false);
      bitDepth = chunk[8]!;
      colorType = chunk[9]!;
      if (bitDepth !== 8) {
        throw new Error(`Unsupported PNG bitDepth ${bitDepth}`);
      }
    } else if (type === 'PLTE') {
      palette = chunk;
    } else if (type === 'IDAT') {
      idatChunks.push(chunk);
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4; // skip CRC
  }

  const totalIdat = idatChunks.reduce((acc, c) => acc + c.byteLength, 0);
  const combinedIdat = new Uint8Array(totalIdat);
  let writePos = 0;
  for (const c of idatChunks) {
    combinedIdat.set(c, writePos);
    writePos += c.byteLength;
  }

  const inflated = inflateSync(combinedIdat);
  const channels =
    colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const stride = width * channels;
  const unfiltered = new Uint8Array(height * stride);

  let inPos = 0;
  for (let y = 0; y < height; y++) {
    const filterType = inflated[inPos++]!;
    const rowStart = y * stride;
    const prevRowStart = (y - 1) * stride;

    for (let x = 0; x < stride; x++) {
      const raw = inflated[inPos++]!;
      const left = x >= channels ? unfiltered[rowStart + x - channels]! : 0;
      const up = y > 0 ? unfiltered[prevRowStart + x]! : 0;
      const upLeft = y > 0 && x >= channels ? unfiltered[prevRowStart + x - channels]! : 0;

      let recon = raw;
      switch (filterType) {
        case 0:
          recon = raw;
          break;
        case 1:
          recon = (raw + left) & 0xff;
          break;
        case 2:
          recon = (raw + up) & 0xff;
          break;
        case 3:
          recon = (raw + ((left + up) >>> 1)) & 0xff;
          break;
        case 4:
          recon = (raw + paethPredictor(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error(`Unknown PNG scanline filter ${filterType}`);
      }
      unfiltered[rowStart + x] = recon;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const out = i * 4;
    if (colorType === 6) {
      const src = i * 4;
      rgba[out] = unfiltered[src]!;
      rgba[out + 1] = unfiltered[src + 1]!;
      rgba[out + 2] = unfiltered[src + 2]!;
      rgba[out + 3] = unfiltered[src + 3]!;
    } else if (colorType === 2) {
      const src = i * 3;
      rgba[out] = unfiltered[src]!;
      rgba[out + 1] = unfiltered[src + 1]!;
      rgba[out + 2] = unfiltered[src + 2]!;
      rgba[out + 3] = 255;
    } else if (colorType === 4) {
      const src = i * 2;
      const g = unfiltered[src]!;
      rgba[out] = g;
      rgba[out + 1] = g;
      rgba[out + 2] = g;
      rgba[out + 3] = unfiltered[src + 1]!;
    } else if (colorType === 0) {
      const g = unfiltered[i]!;
      rgba[out] = g;
      rgba[out + 1] = g;
      rgba[out + 2] = g;
      rgba[out + 3] = 255;
    } else if (colorType === 3 && palette) {
      const idx = unfiltered[i]! * 3;
      rgba[out] = palette[idx] ?? 0;
      rgba[out + 1] = palette[idx + 1] ?? 0;
      rgba[out + 2] = palette[idx + 2] ?? 0;
      rgba[out + 3] = 255;
    }
  }

  return { width, height, rgba };
}
