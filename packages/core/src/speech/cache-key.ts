import type { SynthRequest } from '../types.js';
import { sha1Hex } from '../util/sha1.js';

/**
 * Deterministic speech cache key (`ARCHITECTURE.md` §8.4):
 * `sha1(engine | voice | model | text)`.
 * Playback speed is applied at output time (pitch-preserving), never baked into the cache key.
 */
export function computeSpeechCacheKeySync(
  req: Pick<SynthRequest, 'engine' | 'voiceId' | 'model' | 'text'>,
): string {
  return sha1Hex(`${req.engine}|${req.voiceId}|${req.model ?? ''}|${req.text}`);
}

export async function computeSpeechCacheKey(
  req: Pick<SynthRequest, 'engine' | 'voiceId' | 'model' | 'text'>,
): Promise<string> {
  return computeSpeechCacheKeySync(req);
}
