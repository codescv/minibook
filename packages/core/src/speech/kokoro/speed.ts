/**
 * Upstream Kokoro v1.1-zh length-dependent pacing correction (`TTS_V2_SPEC.md` §4.6,
 * `samples/make_zh.py` `speed_callable`).
 *
 * NOTE: This is the model's `speed` tensor input — NEVER the user playback rate!
 * User playback rate stays pitch-preserving at the audio player so cached audio survives rate changes.
 */
export function kokoroSpeed(unpaddedTokenCount: number, voiceId: string): number {
  const n = Math.max(0, Math.trunc(unpaddedTokenCount));
  if (voiceId.toLowerCase().startsWith('z')) {
    const factor = n <= 83 ? 1 : n < 183 ? 1 - (n - 83) / 500 : 0.8;
    return Math.round(1.1 * factor * 10_000) / 10_000;
  }
  return 1.0;
}
