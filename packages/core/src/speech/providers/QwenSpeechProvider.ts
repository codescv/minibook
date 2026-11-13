/**
 * First-class Qwen3-TTS / local GPU speech provider (`TTS_V2_SPEC.md` §6.1).
 * Supports three wire protocols with one platform-neutral implementation:
 *   1. `'mlx-audio'`   — Apple-Silicon Mac GPU (`scripts/mac-gpu-tts-server.sh`, `POST /v1/audio/speech` WAV)
 *   2. `'vllm-omni'`   — Linux/NVIDIA GPU (`POST /v1/audio/speech` WAV)
 *   3. `'qwen-native'` — Qwen3-TTS FastAPI (`POST /synthesize` with >30s split + `concatWav`)
 */
import { MiniBookError } from '../../errors.js';
import type { HttpTransport, QwenProtocol, QwenServerConfig, Voice } from '../../types.js';
import { bytesToHexLower, sha256Bytes } from '../../util/sha1.js';
import { containsCjkCharacters } from '../lang.js';
import { concatWav, parseWav } from '../wav.js';
import { OpenAiSpeechProvider } from './OpenAiSpeechProvider.js';

export interface QwenSpeechProviderDeps {
  readonly http: HttpTransport;
}

export interface QwenSynthRequest {
  readonly config: QwenServerConfig;
  readonly text: string;
  readonly voiceId?: string;
  readonly lang?: string;
  readonly apiKeyHeader?: string;
  readonly timeoutMs?: number;
}

export interface QwenSynthOutput {
  readonly audio: Uint8Array;
  readonly mime: 'audio/wav';
  readonly durationMs?: number;
}

export const QWEN_CUSTOM_VOICES_ZH = ['Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric'] as const;
export const QWEN_CUSTOM_VOICES_EN = ['Ryan', 'Aiden'] as const;

const MAX_QWEN_NATIVE_ESTIMATED_SECONDS = 30;
const TARGET_QWEN_NATIVE_CHUNK_SECONDS = 25;

export function computeQwenModelCacheTag(config: QwenServerConfig): string {
  const refInput = new TextEncoder().encode(`${config.refAudio ?? ''}\n${config.refText ?? ''}`);
  const refHash16 = bytesToHexLower(sha256Bytes(refInput)).slice(0, 16);
  return `${config.protocol}|${config.model}|${config.instruct ?? ''}|${refHash16}`;
}

export function estimateTextSecondsForQwen(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const cps = containsCjkCharacters(trimmed) ? 5.5 : 14;
  return trimmed.length / cps;
}

/**
 * Splits long utterances for `qwen-native` (`max_new_tokens=600` ~= 48 s cap, `TTS_V2_SPEC.md` §6.1):
 * if estimated duration exceeds 30 s, splits at clause punctuation (`，、；：。！？,;:.!?`) or whitespace
 * into <= 25 s pieces.
 */
export function splitForQwen(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (estimateTextSecondsForQwen(trimmed) <= MAX_QWEN_NATIVE_ESTIMATED_SECONDS) {
    return [trimmed];
  }

  const cps = containsCjkCharacters(trimmed) ? 5.5 : 14;
  const maxChars = Math.max(20, Math.floor(TARGET_QWEN_NATIVE_CHUNK_SECONDS * cps));
  const out: string[] = [];
  let remaining = trimmed;

  while (remaining.length > maxChars) {
    const sliceBuf = remaining.slice(0, maxChars);
    let splitAt = -1;
    // Prefer clause / sentence punctuation from right to left in the second half of the chunk
    for (let i = sliceBuf.length - 1; i >= Math.floor(maxChars * 0.35); i--) {
      if (/[，、；：。！？,.!?;:\n]/.test(sliceBuf[i]!)) {
        splitAt = i + 1;
        break;
      }
    }
    if (splitAt < 0) {
      for (let i = sliceBuf.length - 1; i >= Math.floor(maxChars * 0.35); i--) {
        if (/\s/.test(sliceBuf[i]!)) {
          splitAt = i + 1;
          break;
        }
      }
    }
    if (splitAt <= 0) {
      splitAt = maxChars;
    }
    const piece = remaining.slice(0, splitAt).trim();
    if (piece) out.push(piece);
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) out.push(remaining);
  return out;
}

function mapMlxLangCode(model: string, voiceId: string, lang = ''): string {
  const lowLang = lang.toLowerCase();
  if (/kokoro/i.test(model)) {
    if (lowLang.startsWith('zh')) return 'z';
    if (lowLang.startsWith('ja')) return 'j';
    if (/^b[fm]?_/i.test(voiceId) || lowLang === 'en-gb') return 'b';
    return 'a';
  }
  if (lowLang.startsWith('zh')) return 'chinese';
  if (lowLang.startsWith('en')) return 'english';
  if (lowLang.startsWith('ja')) return 'japanese';
  if (lowLang.startsWith('ko')) return 'korean';
  return 'auto';
}

function mapVllmLanguage(lang = ''): string {
  const lowLang = lang.toLowerCase();
  if (lowLang.startsWith('zh')) return 'Chinese';
  if (lowLang.startsWith('en')) return 'English';
  if (lowLang.startsWith('ja')) return 'Japanese';
  if (lowLang.startsWith('ko')) return 'Korean';
  return 'Auto';
}

function trimBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new MiniBookError('invalid-argument', 'Local GPU speech server URL is empty');
  }
  return trimmed;
}

function extractFastApiDetail(body: Uint8Array): string | null {
  if (body.byteLength === 0 || body.byteLength > 16_384) return null;
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8').decode(body)) as Record<string, unknown>;
    if (typeof parsed['detail'] === 'string' && parsed['detail'].trim()) {
      return parsed['detail'].trim();
    }
    if (
      parsed['error'] &&
      typeof parsed['error'] === 'object' &&
      typeof (parsed['error'] as Record<string, unknown>)['message'] === 'string'
    ) {
      return ((parsed['error'] as Record<string, unknown>)['message'] as string).trim();
    }
  } catch {
    // non-JSON body
  }
  return null;
}

export class QwenSpeechProvider {
  private readonly http: HttpTransport;
  private readonly openAi: OpenAiSpeechProvider;

  constructor(deps: QwenSpeechProviderDeps) {
    this.http = deps.http;
    this.openAi = new OpenAiSpeechProvider({ http: deps.http });
  }

  async synthesize(req: QwenSynthRequest, signal?: AbortSignal): Promise<QwenSynthOutput> {
    if (signal?.aborted) {
      throw new MiniBookError('cancelled', 'Qwen speech synthesis aborted');
    }
    const cfg = req.config;
    const baseUrl = trimBaseUrl(cfg.baseUrl);
    const voiceId = (req.voiceId ?? cfg.voice).trim() || 'Vivian';

    if (cfg.protocol === 'qwen-native') {
      return this.synthesizeQwenNative(baseUrl, cfg, req.text, req.apiKeyHeader, req.timeoutMs, signal);
    }

    const extraBody: Record<string, unknown> = {};
    let wireVoice = voiceId;
    if (cfg.protocol === 'mlx-audio') {
      extraBody['lang_code'] = mapMlxLangCode(cfg.model, voiceId, req.lang);
      if (cfg.instruct && cfg.instruct.trim()) extraBody['instruct'] = cfg.instruct.trim();
      if (cfg.refAudio && cfg.refAudio.trim()) extraBody['ref_audio'] = cfg.refAudio.trim();
      if (cfg.refText && cfg.refText.trim()) extraBody['ref_text'] = cfg.refText.trim();
    } else {
      // vllm-omni
      wireVoice = voiceId.toLowerCase();
      extraBody['language'] = mapVllmLanguage(req.lang);
      if (cfg.instruct && cfg.instruct.trim()) extraBody['instructions'] = cfg.instruct.trim();
    }

    const out = await this.openAi.synthesize(
      {
        baseUrl,
        model: cfg.model,
        voiceId: wireVoice,
        text: req.text,
        responseFormat: 'wav',
        extraBody,
        ...(req.apiKeyHeader !== undefined ? { apiKeyHeader: req.apiKeyHeader } : {}),
        timeoutMs: req.timeoutMs ?? 60_000,
      },
      signal,
    );

    return {
      audio: out.audio,
      mime: 'audio/wav',
      ...(out.durationMs !== undefined ? { durationMs: out.durationMs } : {}),
    };
  }

  private async synthesizeQwenNative(
    baseUrl: string,
    cfg: QwenServerConfig,
    text: string,
    apiKeyHeader: string | undefined,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<QwenSynthOutput> {
    const refAudio = cfg.refAudio?.trim();
    if (!refAudio) {
      throw new MiniBookError(
        'invalid-argument',
        'qwen-native (/synthesize) requires a reference audio path or URL',
      );
    }
    const pieces = splitForQwen(text);
    if (pieces.length === 0) {
      throw new MiniBookError('invalid-argument', 'Speech synthesis text must not be empty');
    }

    const url = /\/synthesize$/i.test(baseUrl) ? baseUrl : `${baseUrl}/synthesize`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'audio/wav',
    };
    if (apiKeyHeader) {
      headers['Authorization'] = apiKeyHeader.startsWith('Bearer ')
        ? apiKeyHeader
        : `Bearer ${apiKeyHeader}`;
    }

    const wavChunks: Uint8Array[] = [];
    for (const piece of pieces) {
      if (signal?.aborted) {
        throw new MiniBookError('cancelled', 'Qwen speech synthesis aborted');
      }
      const payload: Record<string, unknown> = {
        text: piece,
        ref_audio: refAudio,
        x_vector_only_mode: Boolean(cfg.xVectorOnly),
      };
      if (cfg.refText && cfg.refText.trim()) {
        payload['ref_text'] = cfg.refText.trim();
      }

      let res;
      try {
        res = await this.http({
          url,
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          timeoutMs: timeoutMs ?? 150_000,
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        if (err instanceof MiniBookError) throw err;
        throw new MiniBookError('network', `Qwen server request failed: ${(err as Error).message}`, {
          cause: err,
        });
      }

      if (res.status === 401 || res.status === 403) {
        throw new MiniBookError('speech-auth', `Qwen server authentication failed (HTTP ${res.status})`);
      }
      if (res.status < 200 || res.status >= 300) {
        const detail = extractFastApiDetail(res.body);
        throw new MiniBookError(
          'speech-unavailable',
          detail ? `Qwen server HTTP ${res.status}: ${detail}` : `Qwen server returned HTTP ${res.status}`,
        );
      }
      if (res.body.byteLength === 0) {
        throw new MiniBookError('speech-unavailable', 'Qwen server returned empty audio body');
      }
      wavChunks.push(res.body);
    }

    if (wavChunks.length === 1) {
      const single = wavChunks[0]!;
      let durationMs: number | undefined;
      try {
        durationMs = parseWav(single).durationMs;
      } catch {
        // leave undefined if non-standard header
      }
      return {
        audio: single,
        mime: 'audio/wav',
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
    }

    const merged = concatWav(wavChunks);
    return {
      audio: merged.wav,
      mime: 'audio/wav',
      durationMs: merged.durationMs,
    };
  }

  async listVoices(
    opts: { readonly config: QwenServerConfig; readonly apiKeyHeader?: string },
    signal?: AbortSignal,
  ): Promise<Voice[]> {
    const cfg = opts.config;
    const baseUrl = trimBaseUrl(cfg.baseUrl);

    if (cfg.protocol === 'qwen-native') {
      const label = cfg.voice.trim() || 'Cloned voice';
      return [
        {
          id: label,
          provider: 'qwen',
          name: label,
          lang: 'und',
          quality: 'neural',
          local: false,
        },
      ];
    }

    if (cfg.protocol === 'mlx-audio' && !/kokoro/i.test(cfg.model)) {
      const zhVoices: Voice[] = QWEN_CUSTOM_VOICES_ZH.map((id) => ({
        id,
        provider: 'qwen',
        name: id.replace('_', ' '),
        lang: 'zh-CN',
        quality: 'neural',
        local: false,
      }));
      const enVoices: Voice[] = QWEN_CUSTOM_VOICES_EN.map((id) => ({
        id,
        provider: 'qwen',
        name: id,
        lang: 'en-US',
        quality: 'neural',
        local: false,
      }));
      return [...zhVoices, ...enVoices];
    }

    const remote = await this.openAi.listVoices(
      {
        baseUrl,
        ...(cfg.protocol === 'mlx-audio' && cfg.model ? { model: cfg.model } : {}),
        ...(opts.apiKeyHeader !== undefined ? { apiKeyHeader: opts.apiKeyHeader } : {}),
      },
      signal,
    );
    return remote.map((v) => ({ ...v, provider: 'qwen' as const }));
  }

  async checkHealth(
    opts: { readonly baseUrl: string; readonly protocol: QwenProtocol; readonly apiKeyHeader?: string },
    signal?: AbortSignal,
  ): Promise<boolean> {
    const base = trimBaseUrl(opts.baseUrl);
    const url =
      opts.protocol === 'qwen-native'
        ? `${base.replace(/\/synthesize$/i, '')}/health`
        : `${base.replace(/\/v\d+$/i, '')}/v1/models`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.apiKeyHeader) {
      headers['Authorization'] = opts.apiKeyHeader.startsWith('Bearer ')
        ? opts.apiKeyHeader
        : `Bearer ${opts.apiKeyHeader}`;
    }
    const res = await this.http({
      url,
      method: 'GET',
      headers,
      timeoutMs: 8_000,
      ...(signal ? { signal } : {}),
    });
    if (res.status < 200 || res.status >= 300) return false;
    if (opts.protocol === 'qwen-native') {
      try {
        const json = JSON.parse(new TextDecoder('utf-8').decode(res.body)) as { status?: string };
        return json.status === 'healthy';
      } catch {
        return false;
      }
    }
    return true;
  }
}
