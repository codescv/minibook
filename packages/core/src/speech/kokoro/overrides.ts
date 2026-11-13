/**
 * Optional word-level pinyin override table (`TTS_V2_SPEC.md` §4.4).
 * Ships empty in v0.2.0 to preserve 100% parity with `misaki` `ZHG2P(version='1.1')` training labels,
 * while exposing an explicit extension point for custom polyphone overrides (`word -> space-separated tone3 syllables`).
 */
export const KOKORO_WORD_OVERRIDES: Readonly<Record<string, string>> = {};
