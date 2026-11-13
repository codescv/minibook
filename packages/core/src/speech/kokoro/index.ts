/**
 * Platform-neutral Kokoro-82M v1.1-zh G2P & model manifest surface (`TTS_V2_SPEC.md` §3, §4).
 * Zero `node:*`, zero DOM globals, zero native addons.
 */
import { gunzipSync } from 'fflate';
import type { KokoroWordSpan } from '../../types.js';
import { containsCjkCharacters } from '../lang.js';
import {
  KOKORO_MAX_CHUNK_TOKENS,
  KOKORO_TARGET_CHUNK_TOKENS,
  encodeAndChunkKokoroPieces,
} from './chunk.js';
import { an2cn, transformAn2cn, transformAn2cnTracked } from './cn2an.js';
import { EnG2P, parseEnLexiconTsv, type EnLexiconDict } from './en-g2p.js';
import { createEnglishOovFallback, englishLts } from './en-lts.js';
import {
  Jieba,
  type JiebaFinalsegModel,
  type JiebaLogTable,
  type JiebaPossegModel,
} from './jieba.js';
import { normalizeEnTracked, normalizeForKokoro, normalizeZhTracked } from './normalize.js';
import { TrackedText } from './offset-text.js';
import { KOKORO_WORD_OVERRIDES } from './overrides.js';
import { Pinyin, type SyllablePair } from './pinyin.js';
import { kokoroSpeed } from './speed.js';
import { ToneSandhi, type MisakiZhTables } from './tone-sandhi.js';
import { ZHG2P } from './zh-g2p.js';

export * from './manifest.js';
export * from './vocab.js';
export * from './speed.js';
export {
  KOKORO_MAX_CHUNK_TOKENS,
  KOKORO_TARGET_CHUNK_TOKENS,
  KOKORO_WORD_OVERRIDES,
  EnG2P,
  Jieba,
  Pinyin,
  ToneSandhi,
  TrackedText,
  ZHG2P,
  an2cn,
  createEnglishOovFallback,
  encodeAndChunkKokoroPieces,
  englishLts,
  normalizeForKokoro,
  parseEnLexiconTsv,
  transformAn2cn,
  transformAn2cnTracked,
};

export const KOKORO_G2P_VERSION = 1;

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
   * Platform-injected loader returning raw `.gz` bytes (or already-decompressed UTF-8 bytes)
   * for a named `kokoro-g2p/v1/<name>` asset (`TTS_V2_SPEC.md` §4.3).
   */
  readonly loadAsset: (name: KokoroG2PAssetName | string) => Promise<Uint8Array>;
  /** Optional word->pinyin override dictionary (defaults to `KOKORO_WORD_OVERRIDES`). */
  readonly wordOverrides?: Readonly<Record<string, string>>;
}

export interface KokoroPhonemizeOptions {
  readonly voiceId?: string;
  /** Run app-side pre-normaliser (`normalize.ts`, default `true`). Pass `false` for raw misaki benchmark parity. */
  readonly normalize?: boolean;
  /** Enable rule-based English OOV letter-to-sound fallback (`en-lts.ts`, default `true`). */
  readonly enFallback?: boolean;
  readonly targetChunkTokens?: number;
  readonly maxChunkTokens?: number;
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

const utf8Decoder = new TextDecoder('utf-8');

function decodePossiblyGzippedUtf8(bytes: Uint8Array): string {
  if (bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return utf8Decoder.decode(gunzipSync(bytes));
  }
  return utf8Decoder.decode(bytes);
}

const RE_HAS_LATIN = /[A-Za-z]/;

export function createKokoroG2P(options: KokoroG2POptions): KokoroG2P {
  let zhEngine: ZHG2P | null = null;
  let zhPromise: Promise<ZHG2P> | null = null;
  let enEngine: EnG2P | null = null;
  let enPromise: Promise<EnG2P> | null = null;

  async function readTextAsset(gzName: KokoroG2PAssetName): Promise<string> {
    const raw = await options.loadAsset(gzName);
    return decodePossiblyGzippedUtf8(raw);
  }

  function ensureZh(): Promise<ZHG2P> {
    if (zhEngine) return Promise.resolve(zhEngine);
    if (zhPromise) return zhPromise;
    zhPromise = (async () => {
      const [
        dictText,
        possegJson,
        finalsegJson,
        logsJson,
        charsText,
        phrasesText,
        syllablesJson,
        tablesJson,
      ] = await Promise.all([
        readTextAsset('jieba_dict.txt.gz'),
        readTextAsset('jieba_posseg.json.gz'),
        readTextAsset('jieba_finalseg.json.gz'),
        readTextAsset('jieba_logs.json.gz'),
        readTextAsset('py_chars.txt.gz'),
        readTextAsset('py_phrases_pruned.txt.gz'),
        readTextAsset('py_syllables.json.gz'),
        readTextAsset('misaki_tables.json.gz'),
      ]);

      const finalseg = JSON.parse(finalsegJson) as JiebaFinalsegModel;
      const posseg = JSON.parse(possegJson) as JiebaPossegModel;
      const logs = JSON.parse(logsJson) as JiebaLogTable;
      const syllables = JSON.parse(syllablesJson) as readonly SyllablePair[];
      const tables = JSON.parse(tablesJson) as MisakiZhTables;

      const jieba = new Jieba(dictText, finalseg, posseg, logs);
      const pinyin = new Pinyin(
        syllables,
        charsText,
        phrasesText,
        options.wordOverrides ? { wordOverrides: options.wordOverrides } : undefined,
      );
      zhEngine = new ZHG2P({ jieba, pinyin, tables });
      return zhEngine;
    })().catch((err) => {
      zhPromise = null;
      throw err;
    });
    return zhPromise;
  }

  function ensureEn(): Promise<EnG2P> {
    if (enEngine) return Promise.resolve(enEngine);
    if (enPromise) return enPromise;
    enPromise = (async () => {
      const [goldTsv, silverTsv] = await Promise.all([
        readTextAsset('en_us_gold.tsv.gz'),
        readTextAsset('en_us_silver.tsv.gz'),
      ]);
      const gold: EnLexiconDict = parseEnLexiconTsv(goldTsv);
      const silver: EnLexiconDict = parseEnLexiconTsv(silverTsv);
      const en = new EnG2P(gold, silver, { unk: '❓' });
      en.fallback = createEnglishOovFallback((w) => en.getNNP(w));
      enEngine = en;
      return en;
    })().catch((err) => {
      enPromise = null;
      throw err;
    });
    return enPromise;
  }

  function runLoaded(
    rawText: string,
    lang: string,
    opts?: KokoroPhonemizeOptions,
  ): KokoroG2PResult {
    const trimmedCheck = rawText.trim();
    if (!trimmedCheck) {
      return {
        phonemes: '',
        phonemeIds: [],
        phonemeSpeeds: [],
        phonemeSpans: [],
      };
    }

    const useNormalize = opts?.normalize !== false;
    const useEnFallback = opts?.enFallback !== false;
    const lowLang = lang.toLowerCase();
    const isPureEnglishLang = lowLang.startsWith('en') && !containsCjkCharacters(rawText);

    let phonemes: string;
    let pieces;

    if (isPureEnglishLang && enEngine) {
      let tracked = TrackedText.fromRaw(rawText);
      if (useNormalize) {
        tracked = normalizeEnTracked(tracked);
      }
      const enOut = enEngine.g2pTracked(tracked, { enableFallback: useEnFallback });
      phonemes = enOut.phonemes;
      pieces = enOut.pieces;
    } else {
      if (!zhEngine) {
        throw new Error('KokoroG2P Chinese dictionaries are not loaded yet (call preload() or phonemize())');
      }
      let tracked = TrackedText.fromRaw(rawText);
      if (useNormalize) {
        tracked = normalizeZhTracked(tracked);
      }
      const enCallable = enEngine
        ? (enTracked: TrackedText) =>
            enEngine!.g2pTracked(enTracked, { enableFallback: useEnFallback })
        : null;
      const zhOut = zhEngine.g2pTracked(tracked, enCallable);
      phonemes = zhOut.phonemes;
      pieces = zhOut.pieces;
    }

    const chunked = encodeAndChunkKokoroPieces(pieces, rawText.length, {
      ...(opts?.targetChunkTokens !== undefined ? { targetTokens: opts.targetChunkTokens } : {}),
      ...(opts?.maxChunkTokens !== undefined ? { maxTokens: opts.maxChunkTokens } : {}),
    });

    const defaultVoiceId = isPureEnglishLang ? 'af_maple' : 'zf_001';
    const voiceId = opts?.voiceId ?? defaultVoiceId;
    const speeds = chunked.chunks.map((c) => kokoroSpeed(c.length, voiceId));

    return {
      phonemes,
      phonemeIds: chunked.chunks,
      phonemeSpeeds: speeds,
      phonemeSpans: chunked.chunkSpans,
    };
  }

  return {
    async preload(opts?: { readonly includeEnglish?: boolean }): Promise<void> {
      if (opts?.includeEnglish) {
        await Promise.all([ensureZh(), ensureEn()]);
      } else {
        await ensureZh();
      }
    },

    async phonemize(
      text: string,
      lang = 'zh-CN',
      opts?: KokoroPhonemizeOptions,
    ): Promise<KokoroG2PResult> {
      const lowLang = lang.toLowerCase();
      const needsEn = lowLang.startsWith('en') || RE_HAS_LATIN.test(text);
      const needsZh = !lowLang.startsWith('en') || containsCjkCharacters(text);

      if (needsZh && needsEn) {
        await Promise.all([ensureZh(), ensureEn()]);
      } else if (needsEn) {
        await ensureEn();
      } else {
        await ensureZh();
      }

      return runLoaded(text, lang, opts);
    },

    phonemizeSync(
      text: string,
      lang = 'zh-CN',
      opts?: KokoroPhonemizeOptions,
    ): KokoroG2PResult {
      return runLoaded(text, lang, opts);
    },
  };
}
