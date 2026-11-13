/**
 * Platform-neutral PCM16 WAV encoding, RIFF/WAVE parsing, multi-chunk stitching (`concatWav`),
 * and Kokoro frame-duration -> `WordMark[]` conversion (`TTS_V2_SPEC.md` §5, §6.1).
 */
import { MiniBookError } from '../errors.js';
import type { KokoroWordSpan, WordMark } from '../types.js';

export interface ParsedWav {
  readonly audioFormat: number;
  readonly numChannels: number;
  readonly sampleRate: number;
  readonly byteRate: number;
  readonly blockAlign: number;
  readonly bitsPerSample: number;
  readonly fmtBytes: Uint8Array;
  readonly pcmBytes: Uint8Array;
  readonly durationMs: number;
}

function readAscii4(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );
}

function writeAscii4(view: DataView, offset: number, tag: string): void {
  for (let i = 0; i < 4; i++) {
    view.setUint8(offset + i, tag.charCodeAt(i));
  }
}

/**
 * Encodes finite `Float32Array` mono audio samples (`[-1, 1]`) into a 16-bit PCM RIFF WAVE buffer.
 * Rejects non-finite (`NaN`/`Infinity`) or near-silent (`max|x| < minPeak`) waveforms (`TTS_V2_SPEC.md` §5).
 */
export function encodeMonoPcm16Wav(
  samples: Float32Array | readonly number[],
  sampleRate = 24_000,
  opts?: { readonly minPeak?: number },
): { readonly wav: Uint8Array; readonly durationMs: number; readonly peak: number } {
  const minPeak = opts?.minPeak ?? 1e-3;
  const n = samples.length;
  if (n <= 0) {
    throw new MiniBookError('speech-unavailable', 'Synthesized waveform is empty');
  }

  let peak = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i]!;
    if (!Number.isFinite(s)) {
      throw new MiniBookError('speech-unavailable', `Non-finite audio sample at index ${i}`);
    }
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
  }
  if (peak < minPeak) {
    throw new MiniBookError('speech-unavailable', `Synthesized waveform is silent (peak=${peak})`);
  }

  const dataBytes = n * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);

  writeAscii4(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii4(view, 8, 'WAVE');
  writeAscii4(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audioFormat = PCM (1)
  view.setUint16(22, 1, true); // numChannels = 1
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byteRate
  view.setUint16(32, 2, true); // blockAlign
  view.setUint16(34, 16, true); // bitsPerSample
  writeAscii4(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let byteOff = 44;
  for (let i = 0; i < n; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    const pcm = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    view.setInt16(byteOff, pcm, true);
    byteOff += 2;
  }

  const durationMs = Math.round((n / sampleRate) * 1000);
  return { wav: out, durationMs, peak };
}

/**
 * Parses a RIFF/WAVE file into its `fmt ` metadata and raw `data` payload.
 */
export function parseWav(bytes: Uint8Array): ParsedWav {
  if (bytes.byteLength < 44) {
    throw new MiniBookError('speech-unavailable', 'Truncated WAV buffer (< 44 bytes)');
  }
  if (readAscii4(bytes, 0) !== 'RIFF' || readAscii4(bytes, 8) !== 'WAVE') {
    throw new MiniBookError('speech-unavailable', 'Invalid RIFF/WAVE header');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let fmtBytes: Uint8Array | null = null;
  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let byteRate = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let pcmBytes: Uint8Array | null = null;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readAscii4(bytes, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    const available = Math.max(0, bytes.byteLength - dataStart);
    // Streaming servers sometimes write 0xFFFFFFFF for data size; clamp to remaining buffer
    const effectiveSize =
      chunkId === 'data' && chunkSize > available ? available : Math.min(chunkSize, available);

    if (chunkId === 'fmt ') {
      if (effectiveSize < 16) {
        throw new MiniBookError('speech-unavailable', 'WAV fmt chunk shorter than 16 bytes');
      }
      fmtBytes = bytes.subarray(dataStart, dataStart + effectiveSize);
      audioFormat = view.getUint16(dataStart, true);
      numChannels = view.getUint16(dataStart + 2, true);
      sampleRate = view.getUint32(dataStart + 4, true);
      byteRate = view.getUint32(dataStart + 8, true);
      blockAlign = view.getUint16(dataStart + 12, true);
      bitsPerSample = view.getUint16(dataStart + 14, true);
    } else if (chunkId === 'data') {
      pcmBytes = bytes.subarray(dataStart, dataStart + effectiveSize);
      break;
    }

    const padded = chunkSize + (chunkSize & 1);
    if (padded <= 0 && chunkSize > 0) break;
    offset = dataStart + padded;
  }

  if (!fmtBytes || !pcmBytes || sampleRate <= 0 || byteRate <= 0) {
    throw new MiniBookError('speech-unavailable', 'WAV missing valid fmt or data chunk');
  }

  const durationMs = Math.round((pcmBytes.byteLength / byteRate) * 1000);
  return {
    audioFormat,
    numChannels,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample,
    fmtBytes,
    pcmBytes,
    durationMs,
  };
}

/**
 * Concatenates one or more RIFF/WAVE buffers with identical `fmt ` headers into a single valid WAV
 * (`TTS_V2_SPEC.md` §6.1).
 */
export function concatWav(chunks: readonly Uint8Array[]): {
  readonly wav: Uint8Array;
  readonly durationMs: number;
} {
  if (chunks.length === 0) {
    throw new MiniBookError('invalid-argument', 'concatWav requires at least one WAV chunk');
  }
  const parsed = chunks.map(parseWav);
  const first = parsed[0]!;
  if (chunks.length === 1) {
    return { wav: chunks[0]!, durationMs: first.durationMs };
  }

  let totalDataBytes = 0;
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i]!;
    if (
      p.audioFormat !== first.audioFormat ||
      p.numChannels !== first.numChannels ||
      p.sampleRate !== first.sampleRate ||
      p.bitsPerSample !== first.bitsPerSample ||
      p.blockAlign !== first.blockAlign
    ) {
      throw new MiniBookError(
        'speech-unavailable',
        `Incompatible WAV format in chunk ${i}: expected ${first.sampleRate}Hz/${first.numChannels}ch/${first.bitsPerSample}b, got ${p.sampleRate}Hz/${p.numChannels}ch/${p.bitsPerSample}b`,
      );
    }
    totalDataBytes += p.pcmBytes.byteLength;
  }

  const fmtLen = 16; // canonical 16-byte PCM/IEEE fmt header
  const out = new Uint8Array(12 + 8 + fmtLen + 8 + totalDataBytes);
  const view = new DataView(out.buffer);

  writeAscii4(view, 0, 'RIFF');
  view.setUint32(4, out.byteLength - 8, true);
  writeAscii4(view, 8, 'WAVE');
  writeAscii4(view, 12, 'fmt ');
  view.setUint32(16, fmtLen, true);
  out.set(first.fmtBytes.subarray(0, fmtLen), 20);
  writeAscii4(view, 20 + fmtLen, 'data');
  view.setUint32(24 + fmtLen, totalDataBytes, true);

  let cursor = 28 + fmtLen;
  for (const p of parsed) {
    out.set(p.pcmBytes, cursor);
    cursor += p.pcmBytes.byteLength;
  }

  const durationMs = Math.round((totalDataBytes / first.byteRate) * 1000);
  return { wav: out, durationMs };
}

/**
 * Converts Kokoro per-token frame durations (`len == unpaddedIds.length + 2` including leading/trailing
 * pad `0` tokens; 1 frame = `600` samples = `25 ms` @ 24 kHz) + `KokoroWordSpan[]` into `WordMark[]`.
 */
export function wordMarksFromKokoroDurations(
  spans: readonly KokoroWordSpan[],
  paddedDurations: ArrayLike<number | bigint>,
  chunkTimeOffsetMs = 0,
  text?: string,
  frameMs = 25,
): WordMark[] {
  if (spans.length === 0 || paddedDurations.length < 2) return [];
  const prefixFrames = new Float64Array(paddedDurations.length + 1);
  for (let i = 0; i < paddedDurations.length; i++) {
    const d = Number(paddedDurations[i]);
    prefixFrames[i + 1] = prefixFrames[i]! + (Number.isFinite(d) && d > 0 ? d : 0);
  }
  // Unpadded token `t` corresponds to `paddedDurations[t + 1]` (`paddedDurations[0]` is leading pad)
  const marks: WordMark[] = [];
  const maxUnpadded = Math.max(0, paddedDurations.length - 2);
  for (const sp of spans) {
    const t0 = Math.max(0, Math.min(maxUnpadded, sp.t0));
    const t1 = Math.max(t0, Math.min(maxUnpadded, sp.t1));
    const startFrames = prefixFrames[t0 + 1]!;
    const endFrames = prefixFrames[t1 + 1]!;
    const timeMs = Math.round(chunkTimeOffsetMs + startFrames * frameMs);
    const durationMs = Math.max(0, Math.round((endFrames - startFrames) * frameMs));
    marks.push({
      start: sp.c0,
      end: sp.c1,
      timeMs,
      durationMs,
      ...(text !== undefined ? { word: text.slice(sp.c0, sp.c1) } : {}),
    });
  }
  return marks;
}
