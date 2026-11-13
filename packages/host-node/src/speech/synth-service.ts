/**
 * Server-side speech synthesis service (`ARCHITECTURE.md` §8.4, §12):
 *   - Hosts `EdgeSpeechProvider` (via `ws`) and `OpenAiSpeechProvider` (via `fetch`)
 *   - Enforces strict outbound URL allowlist (Edge endpoints + configured custom server only)
 *   - Injects stored API-key secrets via `{{secret:<name>}}`
 *   - Per-key single-flight deduplication + persistent disk/SQLite audio cache
 */
import {
  EdgeSpeechProvider,
  MiniBookError,
  OpenAiSpeechProvider,
  computeSpeechCacheKey,
  type AppSettings,
  type EdgeSynthOutput,
  type HttpTransport,
  type OpenAiSynthOutput,
  type SocketTransport,
  type SynthRequest,
  type SynthResult,
  type Voice,
} from '@minibook/core';
import type { FileSecretStore } from '../settings/secrets.js';
import { assertAllowedOutboundSpeechUrl } from './allowlist.js';
import type { CachedSpeechEntry, SpeechAudioCache } from './audio-cache.js';
import { createNodeHttpTransport } from './http-transport.js';
import { createNodeWsTransport } from './ws-transport.js';

const EDGE_VOICES_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const SPEECH_SECRET_CANDIDATES = [
  'custom-speech-key',
  'custom-speech-api-key',
  'openai-api-key',
  'openai',
  'customSpeechKey',
  'customSpeechApiKey',
  'speech-api-key',
] as const;

export interface EdgeProviderLike {
  synthesize(
    req: { readonly voiceId: string; readonly text: string; readonly lang?: string },
    signal?: AbortSignal,
  ): Promise<EdgeSynthOutput>;
  listVoices(signal?: AbortSignal): Promise<Voice[]>;
}

export interface OpenAiProviderLike {
  synthesize(
    req: {
      readonly baseUrl: string;
      readonly model: string;
      readonly voiceId: string;
      readonly text: string;
      readonly apiKeyHeader?: string;
      readonly timeoutMs?: number;
    },
    signal?: AbortSignal,
  ): Promise<OpenAiSynthOutput>;
  listVoices(
    opts: { readonly baseUrl: string; readonly apiKeyHeader?: string },
    signal?: AbortSignal,
  ): Promise<Voice[]>;
}

export interface SynthServiceOptions {
  readonly getSettings: () => AppSettings;
  readonly secrets: FileSecretStore;
  readonly cache: SpeechAudioCache;
  readonly getLastSecretName?: () => string | null;
  readonly httpTransport?: HttpTransport;
  readonly socketTransport?: SocketTransport;
  readonly edgeProvider?: EdgeProviderLike;
  readonly openAiProvider?: OpenAiProviderLike;
  readonly now?: () => number;
}

interface InFlightFlight {
  readonly promise: Promise<SynthResult>;
  readonly controller: AbortController;
  waiters: number;
}

export class SynthService {
  private readonly getSettings: () => AppSettings;
  private readonly secrets: FileSecretStore;
  private readonly cache: SpeechAudioCache;
  private readonly getLastSecretName: (() => string | null) | undefined;
  private readonly edgeProvider: EdgeProviderLike;
  private readonly openAiProvider: OpenAiProviderLike;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, InFlightFlight>();
  private cachedEdgeVoices: { readonly voices: Voice[]; readonly expiresAt: number } | null = null;

  constructor(options: SynthServiceOptions) {
    this.getSettings = options.getSettings;
    this.secrets = options.secrets;
    this.cache = options.cache;
    this.getLastSecretName = options.getLastSecretName;
    this.now = options.now ?? Date.now;

    const http =
      options.httpTransport ??
      createNodeHttpTransport({
        secrets: options.secrets,
        getAllowedCustomBaseUrl: () => this.getSettings().customSpeechServer?.baseUrl ?? null,
        allowEdge: () => true,
      });
    const socket =
      options.socketTransport ??
      createNodeWsTransport({
        secrets: options.secrets,
        allowEdge: () => true,
      });

    this.edgeProvider =
      options.edgeProvider ?? new EdgeSpeechProvider({ socket, http, now: this.now });
    this.openAiProvider = options.openAiProvider ?? new OpenAiSpeechProvider({ http });
  }

  getCachedAudio(key: string): CachedSpeechEntry | null {
    return this.cache.get(key);
  }

  clearCache(): void {
    this.cache.clear();
  }

  cacheSize(): number {
    return this.cache.totalBytes();
  }

  async synthesize(req: SynthRequest, signal?: AbortSignal): Promise<SynthResult> {
    if (!req.text || !req.text.trim()) {
      throw new MiniBookError('invalid-argument', 'Speech synthesis text must not be empty');
    }
    if (!req.voiceId || !req.voiceId.trim()) {
      throw new MiniBookError('invalid-argument', 'Speech synthesis voiceId is required');
    }

    const settings = this.getSettings();
    let effectiveModel = req.model;
    let effectiveBaseUrl: string | undefined;

    if (req.engine === 'openai') {
      const configured = settings.customSpeechServer?.baseUrl?.trim();
      if (!configured) {
        throw new MiniBookError(
          'speech-unavailable',
          'Custom speech server URL is not configured in Settings',
        );
      }
      if (req.baseUrl !== undefined && req.baseUrl.trim() !== '') {
        // Reject any caller-supplied baseUrl that does not match the configured server
        const probeUrl = `${req.baseUrl.replace(/\/+$/, '')}/audio/speech`;
        assertAllowedOutboundSpeechUrl(probeUrl, {
          allowEdge: false,
          configuredCustomBaseUrl: configured,
        });
      }
      effectiveBaseUrl = configured;
      effectiveModel = req.model ?? settings.customSpeechServer?.model ?? 'tts-1';
    } else if (req.engine === 'edge') {
      if (req.baseUrl !== undefined) {
        throw new MiniBookError('invalid-argument', 'Edge speech engine does not accept a custom baseUrl');
      }
    } else {
      throw new MiniBookError('invalid-argument', `Unsupported speech engine: ${String(req.engine)}`);
    }

    const key = await computeSpeechCacheKey({
      engine: req.engine,
      voiceId: req.voiceId,
      ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
      text: req.text,
    });

    const hit = this.cache.get(key);
    if (hit) {
      return {
        ref: `/api/speech/audio/${hit.key}`,
        mime: hit.mime,
        ...(hit.durationMs !== undefined ? { durationMs: hit.durationMs } : {}),
        ...(hit.marks !== undefined ? { marks: hit.marks } : {}),
        synthMs: 0,
        bytes: hit.bytes,
        cached: true,
      };
    }

    if (signal?.aborted) {
      throw new MiniBookError('cancelled', 'Speech synthesis aborted');
    }

    let flight = this.inFlight.get(key);
    if (!flight) {
      const controller = new AbortController();
      const promise = this.runSingleSynthesis(
        key,
        req,
        effectiveBaseUrl,
        effectiveModel,
        controller.signal,
      ).finally(() => {
        this.inFlight.delete(key);
      });
      flight = { promise, controller, waiters: 0 };
      this.inFlight.set(key, flight);
    }

    flight.waiters += 1;
    if (!signal) {
      return flight.promise;
    }

    return new Promise<SynthResult>((resolve, reject) => {
      const activeFlight = flight!;
      const onAbort = () => {
        activeFlight.waiters = Math.max(0, activeFlight.waiters - 1);
        if (activeFlight.waiters === 0) {
          activeFlight.controller.abort();
        }
        reject(new MiniBookError('cancelled', 'Speech synthesis cancelled'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      activeFlight.promise.then(
        (res) => {
          signal.removeEventListener('abort', onAbort);
          resolve(res);
        },
        (err: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  async listRemoteVoices(engine: 'edge' | 'openai', signal?: AbortSignal): Promise<Voice[]> {
    if (engine === 'edge') {
      const now = this.now();
      if (this.cachedEdgeVoices && this.cachedEdgeVoices.expiresAt > now) {
        return this.cachedEdgeVoices.voices;
      }
      const voices = await this.edgeProvider.listVoices(signal);
      this.cachedEdgeVoices = { voices, expiresAt: now + EDGE_VOICES_TTL_MS };
      return voices;
    }

    const configured = this.getSettings().customSpeechServer?.baseUrl?.trim();
    if (!configured) return [];
    const apiKeyHeader = this.resolveBearerPlaceholder();
    return this.openAiProvider.listVoices(
      {
        baseUrl: configured,
        ...(apiKeyHeader !== undefined ? { apiKeyHeader } : {}),
      },
      signal,
    );
  }

  private resolveBearerPlaceholder(): string | undefined {
    const last = this.getLastSecretName?.();
    if (last && this.secrets.has(last)) {
      return `Bearer {{secret:${last}}}`;
    }
    for (const candidate of SPEECH_SECRET_CANDIDATES) {
      if (this.secrets.has(candidate)) {
        return `Bearer {{secret:${candidate}}}`;
      }
    }
    return undefined;
  }

  private async runSingleSynthesis(
    key: string,
    req: SynthRequest,
    effectiveBaseUrl: string | undefined,
    effectiveModel: string | undefined,
    signal: AbortSignal,
  ): Promise<SynthResult> {
    const t0 = this.now();
    if (req.engine === 'edge') {
      const out = await this.edgeProvider.synthesize(
        {
          voiceId: req.voiceId,
          text: req.text,
          ...(req.lang ? { lang: req.lang } : {}),
        },
        signal,
      );
      const synthMs = Math.max(1, this.now() - t0);
      const stored = this.cache.put({
        key,
        audio: out.audio,
        mime: out.mime,
        ...(out.durationMs !== undefined ? { durationMs: out.durationMs } : {}),
        marks: out.marks,
      });
      return {
        ref: `/api/speech/audio/${stored.key}`,
        mime: stored.mime,
        ...(stored.durationMs !== undefined ? { durationMs: stored.durationMs } : {}),
        ...(stored.marks !== undefined ? { marks: stored.marks } : {}),
        synthMs,
        bytes: stored.bytes,
        cached: false,
      };
    }

    const apiKeyHeader = this.resolveBearerPlaceholder();
    const out = await this.openAiProvider.synthesize(
      {
        baseUrl: effectiveBaseUrl!,
        model: effectiveModel ?? 'tts-1',
        voiceId: req.voiceId,
        text: req.text,
        ...(apiKeyHeader !== undefined ? { apiKeyHeader } : {}),
        timeoutMs: 30_000,
      },
      signal,
    );
    const synthMs = Math.max(1, this.now() - t0);
    const stored = this.cache.put({
      key,
      audio: out.audio,
      mime: out.mime,
      ...(out.durationMs !== undefined ? { durationMs: out.durationMs } : {}),
    });
    return {
      ref: `/api/speech/audio/${stored.key}`,
      mime: stored.mime,
      ...(stored.durationMs !== undefined ? { durationMs: stored.durationMs } : {}),
      synthMs,
      bytes: stored.bytes,
      cached: false,
    };
  }
}
