/**
 * Re-exports all authoritative MiniBook v0.2.0 contracts, error shapes, manifest constants,
 * Kokoro G2P interfaces, and Qwen3-TTS types (`TTS_V2_SPEC.md` §2–§6).
 */
export * from './types.js';
export * from './errors.js';
export * from './speech/kokoro/index.js';
export * from './speech/wav.js';
export * from './speech/providers/QwenSpeechProvider.js';
