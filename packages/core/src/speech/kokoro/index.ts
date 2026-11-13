/**
 * Platform-neutral Kokoro-82M v1.1-zh G2P & model manifest surface (`TTS_V2_SPEC.md` §3, §4).
 */
import type { KokoroWordSpan } from '../../types.js';
import { kokoroSpeed } from './speed.js';
import { encodeKokoroPhonemes } from './vocab.js';

export * from './manifest.js';
export * from './vocab.js';
export * from './speed.js';

export const KOKORO_G2P_VERSION = 1;
export const KOKORO_TARGET_CHUNK_TOKENS = 150;
export const KOKORO_MAX_CHUNK_TOKENS = 400;

export const KOKORO_G2P_ZH_ASSETS = [
  'jieba_dict.txt.gz',
  'jieba_posseg.json.gz',
  'jieba_finalseg.json.gz',
  'jieba_logs.json.gz',
  'py_chars.txt.gz',
  'py_phrases_pruned.txt.gz',
  'py_syllables.json.gz',
  'misaki_tables.json.gz',
] as const;

export const KOKORO_G2P_EN_ASSETS = [
  'en_us_gold.tsv.gz',
  'en_us_silver.tsv.gz',
] as const;

export type KokoroG2PAssetName =
  | (typeof KOKORO_G2P_ZH_ASSETS)[number]
  | (typeof KOKORO_G2P_EN_ASSETS)[number];

export interface KokoroG2POptions {
  /**
   * Platform-injected loader returning raw decompressed UTF-8 bytes (or gzipped `.gz` bytes,
   * automatically detected via magic `0x1f 0x8b`) for a named `kokoro-g2p/v1/<name>` asset.
   */
  readonly loadAsset: (name: KokoroG2PAssetName | string) => Promise<Uint8Array>;
}

export interface KokoroPhonemizeOptions {
  readonly voiceId?: string;
  readonly normalize?: boolean;
}

export interface KokoroG2PResult {
  /** Full unchunked Kokoro v1.1-zh phoneme string. */
  readonly phonemes: string;
  /** Token IDs (`1..177`) per <= `KOKORO_MAX_CHUNK_TOKENS` chunk, WITHOUT leading/trailing `0` pads. */
  readonly phonemeIds: readonly (readonly number[])[];
  /** Per-chunk model `speed` input (`kokoroSpeed(ids.length, voiceId)`). */
  readonly phonemeSpeeds: readonly number[];
  /** Per-chunk word timing spans mapping token indices `[t0, t1)` -> UTF-16 `Utterance.text` `[c0, c1)`. */
  readonly phonemeSpans: readonly (readonly KokoroWordSpan[])[];
}

export interface KokoroG2P {
  phonemize(text: string, lang?: string, opts?: KokoroPhonemizeOptions): Promise<KokoroG2PResult>;
  phonemizeSync?(text: string, lang?: string, opts?: KokoroPhonemizeOptions): KokoroG2PResult;
  preload(opts?: { readonly includeEnglish?: boolean }): Promise<void>;
}

/**
 * Creates a platform-neutral `KokoroG2P` instance (`TTS_V2_SPEC.md` §4.3).
 * Full jieba + pypinyin + cn2an + ToneSandhi + US English lexicon implementation lands in `@minibook/core`.
 */
export function createKokoroG2P(_options: KokoroG2POptions): KokoroG2P {
  return {
    async preload(): Promise<void> {
      // Base contract stub; full dictionary preload implemented in @minibook/core
    },
    async phonemize(
      text: string,
      _lang = 'zh-CN',
      opts?: KokoroPhonemizeOptions,
    ): Promise<KokoroG2PResult> {
      const ids = encodeKokoroPhonemes(text);
      const chunks = ids.length > 0 ? [ids.slice(0, KOKORO_MAX_CHUNK_TOKENS)] : [];
      const voiceId = opts?.voiceId ?? 'zf_001';
      const speeds = chunks.map((c) => kokoroSpeed(c.length, voiceId));
      const spans: KokoroWordSpan[][] = chunks.map((c) =>
        c.length > 0 && text.length > 0
          ? [{ t0: 0, t1: c.length, c0: 0, c1: text.length }]
          : [],
      );
      return {
        phonemes: text,
        phonemeIds: chunks,
        phonemeSpeeds: speeds,
        phonemeSpans: spans,
      };
    },
  };
}
