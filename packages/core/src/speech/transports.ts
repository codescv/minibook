import { BinaryReader } from '../io/binary.js';

/**
 * Estimates audio duration in milliseconds from WAV RIFF headers or CBR/VBR MP3 frames
 * (`ARCHITECTURE.md` §8.4).
 */
export function estimateAudioDurationMs(bytes: Uint8Array, mime: string): number | undefined {
  if (bytes.byteLength < 12) return undefined;

  // 1. RIFF WAVE (`RIFF....WAVE`)
  const r = new BinaryReader(bytes);
  if (
    bytes.byteLength >= 44 &&
    r.asciiAt(0, 4) === 'RIFF' &&
    r.asciiAt(8, 4) === 'WAVE'
  ) {
    let pos = 12;
    let byteRate = 0;
    let dataBytes = 0;
    while (pos + 8 <= bytes.byteLength) {
      const chunkId = r.asciiAt(pos, 4);
      const chunkSize = r.u32leAt(pos + 4);
      if (chunkId === 'fmt ' && pos + 20 <= bytes.byteLength) {
        byteRate = r.u32leAt(pos + 16);
      } else if (chunkId === 'data') {
        dataBytes = Math.min(chunkSize, bytes.byteLength - (pos + 8));
        break;
      }
      pos += 8 + chunkSize + (chunkSize & 1);
    }
    if (byteRate > 0 && dataBytes > 0) {
      return Math.max(1, Math.round((dataBytes / byteRate) * 1000));
    }
  }

  // 2. MP3 (`audio/mpeg`): parse first MPEG audio frame header for bitrate, or fall back to Edge 48 kbps
  if (mime.toLowerCase().includes('mpeg') || mime.toLowerCase().includes('mp3')) {
    let offset = 0;
    // Skip ID3v2 tag if present
    if (
      bytes.byteLength >= 10 &&
      bytes[0] === 0x49 &&
      bytes[1] === 0x44 &&
      bytes[2] === 0x33
    ) {
      const id3Size =
        ((bytes[6]! & 0x7f) << 21) |
        ((bytes[7]! & 0x7f) << 14) |
        ((bytes[8]! & 0x7f) << 7) |
        (bytes[9]! & 0x7f);
      offset = Math.min(bytes.byteLength, 10 + id3Size);
    }

    const bitrateKbps = sniffMp3FirstFrameBitrateKbps(bytes, offset) ?? 48;
    const payloadBytes = Math.max(0, bytes.byteLength - offset);
    if (bitrateKbps > 0 && payloadBytes > 0) {
      return Math.max(1, Math.round((payloadBytes * 8) / bitrateKbps));
    }
  }

  return undefined;
}

const MPEG1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_L3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];

function sniffMp3FirstFrameBitrateKbps(bytes: Uint8Array, startOffset: number): number | null {
  const limit = Math.min(bytes.byteLength - 4, startOffset + 4096);
  for (let i = startOffset; i <= limit; i++) {
    if (bytes[i] === 0xff && (bytes[i + 1]! & 0xe0) === 0xe0) {
      const versionBits = (bytes[i + 1]! >>> 3) & 0x03; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
      const layerBits = (bytes[i + 1]! >>> 1) & 0x03; // 1 = Layer III
      const bitrateIdx = (bytes[i + 2]! >>> 4) & 0x0f;
      if (versionBits === 1 || layerBits !== 1 || bitrateIdx === 0 || bitrateIdx === 15) {
        continue;
      }
      const kbps = versionBits === 3 ? MPEG1_L3_KBPS[bitrateIdx]! : MPEG2_L3_KBPS[bitrateIdx]!;
      if (kbps > 0) return kbps;
    }
  }
  return null;
}
