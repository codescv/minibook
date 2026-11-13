import { MiniBookError } from '../../errors.js';
import type { HttpTransport, Voice } from '../../types.js';
import { estimateAudioDurationMs } from '../transports.js';

export interface OpenAiSpeechProviderDeps {
  readonly http: HttpTransport;
}

export interface OpenAiSynthOutput {
  readonly audio: Uint8Array;
  readonly mime: 'audio/mpeg' | 'audio/wav';
  readonly durationMs?: number;
}

export function resolveOpenAiSpeechUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new MiniBookError('invalid-argument', 'Custom speech server URL is empty');
  }
  if (/\/audio\/speech$/i.test(trimmed)) return trimmed;
  if (/\/v\d+$/i.test(trimmed)) return `${trimmed}/audio/speech`;
  return `${trimmed}/v1/audio/speech`;
}

export function resolveOpenAiVoicesUrl(baseUrl: string, model?: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  const withoutSpeech = trimmed.replace(/\/audio\/speech$/i, '');
  const base = /\/v\d+$/i.test(withoutSpeech)
    ? `${withoutSpeech}/audio/voices`
    : `${withoutSpeech}/v1/audio/voices`;
  return model ? `${base}?model=${encodeURIComponent(model)}` : base;
}

/**
 * Generic OpenAI-compatible `/v1/audio/speech` client (`ARCHITECTURE.md` §8.4).
 * Works unchanged with OpenAI, Kokoro-FastAPI, LocalAI, openedai-speech, vLLM-Omni, or LiteLLM.
 */
export class OpenAiSpeechProvider {
  private readonly http: HttpTransport;

  constructor(deps: OpenAiSpeechProviderDeps) {
    this.http = deps.http;
  }

  async synthesize(
    req: {
      readonly baseUrl: string;
      readonly model: string;
      readonly voiceId: string;
      readonly text: string;
      /** Bearer header value (e.g. `'Bearer {{secret:custom-speech-api-key}}'` or `'Bearer sk-...'`). */
      readonly apiKeyHeader?: string;
      readonly responseFormat?: 'mp3' | 'wav';
      readonly extraBody?: Readonly<Record<string, unknown>>;
      readonly timeoutMs?: number;
    },
    signal?: AbortSignal,
  ): Promise<OpenAiSynthOutput> {
    if (signal?.aborted) {
      throw new MiniBookError('cancelled', 'OpenAI speech synthesis aborted');
    }

    const url = resolveOpenAiSpeechUrl(req.baseUrl);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg, audio/wav',
    };
    if (req.apiKeyHeader) {
      headers['Authorization'] = req.apiKeyHeader.startsWith('Bearer ')
        ? req.apiKeyHeader
        : `Bearer ${req.apiKeyHeader}`;
    }

    const bodyJson = JSON.stringify({
      ...(req.extraBody ?? {}),
      model: req.model || 'tts-1',
      input: req.text,
      voice: req.voiceId || 'alloy',
      response_format: req.responseFormat ?? 'mp3',
      speed: 1.0,
    });

    let res;
    try {
      res = await this.http({
        url,
        method: 'POST',
        headers,
        body: bodyJson,
        timeoutMs: req.timeoutMs ?? 30_000,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (err instanceof MiniBookError) throw err;
      throw new MiniBookError('network', `Speech server request failed: ${(err as Error).message}`, {
        cause: err,
      });
    }

    if (res.status === 401 || res.status === 403) {
      throw new MiniBookError('speech-auth', `Speech server authentication failed (HTTP ${res.status})`);
    }
    if (res.status < 200 || res.status >= 300) {
      let detail = '';
      if (res.body.byteLength > 0 && res.body.byteLength <= 16_384) {
        try {
          const errJson = JSON.parse(new TextDecoder('utf-8').decode(res.body)) as Record<string, unknown>;
          if (typeof errJson['detail'] === 'string' && errJson['detail'].trim()) {
            detail = `: ${errJson['detail'].trim()}`;
          }
        } catch {
          // ignore non-JSON body
        }
      }
      throw new MiniBookError('speech-unavailable', `Speech server returned HTTP ${res.status}${detail}`);
    }
    if (res.body.byteLength === 0) {
      throw new MiniBookError('speech-unavailable', 'Speech server returned empty audio body');
    }

    const ct = (res.headers['content-type'] ?? '').toLowerCase();
    const isWav =
      ct.includes('wav') ||
      (res.body.byteLength >= 12 &&
        res.body[0] === 0x52 &&
        res.body[1] === 0x49 &&
        res.body[2] === 0x46 &&
        res.body[3] === 0x46);
    const mime: 'audio/mpeg' | 'audio/wav' = isWav ? 'audio/wav' : 'audio/mpeg';
    const durationMs = estimateAudioDurationMs(res.body, mime);

    return {
      audio: res.body,
      mime,
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }

  async listVoices(
    opts: { readonly baseUrl: string; readonly apiKeyHeader?: string; readonly model?: string },
    signal?: AbortSignal,
  ): Promise<Voice[]> {
    const url = resolveOpenAiVoicesUrl(opts.baseUrl, opts.model);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.apiKeyHeader) {
      headers['Authorization'] = opts.apiKeyHeader.startsWith('Bearer ')
        ? opts.apiKeyHeader
        : `Bearer ${opts.apiKeyHeader}`;
    }

    try {
      const res = await this.http({
        url,
        method: 'GET',
        headers,
        timeoutMs: 8_000,
        ...(signal ? { signal } : {}),
      });
      if (res.status >= 200 && res.status < 300) {
        const parsed = JSON.parse(new TextDecoder('utf-8').decode(res.body)) as unknown;
        const list = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === 'object' && Array.isArray((parsed as { voices?: unknown[] }).voices)
            ? (parsed as { voices: unknown[] }).voices
            : parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown[] }).data)
              ? (parsed as { data: unknown[] }).data
              : [];
        const out: Voice[] = [];
        for (const item of list) {
          if (typeof item === 'string') {
            out.push({ id: item, provider: 'openai', name: item, lang: 'und', quality: 'remote', local: false });
          } else if (item && typeof item === 'object') {
            const o = item as Record<string, unknown>;
            const id = typeof o['id'] === 'string' ? o['id'] : typeof o['voice_id'] === 'string' ? o['voice_id'] : null;
            if (!id) continue;
            out.push({
              id,
              provider: 'openai',
              name: typeof o['name'] === 'string' ? o['name'] : id,
              lang: typeof o['lang'] === 'string' ? o['lang'] : 'und',
              quality: 'remote',
              local: false,
            });
          }
        }
        if (out.length > 0) return out;
      }
    } catch {
      // Many OpenAI-compatible servers (including OpenAI itself) lack `/v1/audio/voices`; return standard preset voices
    }

    return ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'].map((id) => ({
      id,
      provider: 'openai',
      name: id[0]!.toUpperCase() + id.slice(1),
      lang: 'und',
      quality: 'remote',
      local: false,
    }));
  }
}
