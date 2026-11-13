import type { QwenServerConfig, SpeechModelVariant, SynthRequest } from '../types.js';
import { sha1Hex } from '../util/sha1.js';
import { KOKORO_G2P_VERSION } from './kokoro/index.js';
import { computeQwenModelCacheTag } from './providers/QwenSpeechProvider.js';

/**
 * Formats the `model` cache-key component for on-device Kokoro (`TTS_V2_SPEC.md` §2):
 * `` `v1.1-zh|${variant}|g2p${KOKORO_G2P_VERSION}` `` so any G2P or variant upgrade invalidates cached audio.
 */
export function computeKokoroModelCacheTag(
  variant: SpeechModelVariant = 'onnx-fp32',
  g2pVersion: number = KOKORO_G2P_VERSION,
): string {
  return `v1.1-zh|${variant}|g2p${g2pVersion}`;
}

export { computeQwenModelCacheTag };

/**
 * Deterministic speech cache key (`ARCHITECTURE.md` §8.4, `TTS_V2_SPEC.md` §2, §6.1):
 * `sha1(engine | voice | model | text)`.
 * Playback speed is applied at output time (pitch-preserving), never baked into the cache key.
 */
export function computeSpeechCacheKeySync(
  req: Pick<SynthRequest, 'engine' | 'voiceId' | 'model' | 'text'> & {
    readonly variant?: SpeechModelVariant;
    readonly qwenConfig?: QwenServerConfig;
  },
): string {
  const effectiveModel =
    req.model !== undefined
      ? req.model
      : req.engine === 'kokoro'
        ? computeKokoroModelCacheTag(req.variant ?? 'onnx-fp32')
        : req.engine === 'qwen' && req.qwenConfig
          ? computeQwenModelCacheTag(req.qwenConfig)
          : '';
  return sha1Hex(`${req.engine}|${req.voiceId}|${effectiveModel}|${req.text}`);
}

export async function computeSpeechCacheKey(
  req: Pick<SynthRequest, 'engine' | 'voiceId' | 'model' | 'text'> & {
    readonly variant?: SpeechModelVariant;
    readonly qwenConfig?: QwenServerConfig;
  },
): Promise<string> {
  return computeSpeechCacheKeySync(req);
}
