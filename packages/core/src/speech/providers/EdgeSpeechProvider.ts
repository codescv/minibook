import { MiniBookError } from '../../errors.js';
import { concatBytes } from '../../io/binary.js';
import { escapeXmlAttr, escapeXmlText } from '../../markup/entities.js';
import type { HttpTransport, SocketTransport, Voice, WordMark } from '../../types.js';
import { sha256HexUpper } from '../../util/sha1.js';
import { estimateAudioDurationMs } from '../transports.js';
import {
  EDGE_ORIGIN,
  EDGE_OUTPUT_FORMAT,
  EDGE_SEC_MS_GEC_VERSION,
  EDGE_TRUSTED_CLIENT_TOKEN,
  EDGE_USER_AGENT,
  EDGE_VOICES_LIST_URL,
  EDGE_VOICE_CACHE_TTL_MS,
  EDGE_WSS_BASE_URL,
  WIN_FILETIME_EPOCH_OFFSET_SEC,
} from './edge-constants.js';

export interface EdgeSpeechProviderDeps {
  readonly socket: SocketTransport;
  readonly http: HttpTransport;
  readonly now?: () => number;
}

export interface EdgeSynthOutput {
  readonly audio: Uint8Array;
  readonly mime: 'audio/mpeg';
  readonly durationMs?: number;
  readonly marks: readonly WordMark[];
}

/**
 * Generates the rotating `Sec-MS-GEC` SHA-256 token (`ARCHITECTURE.md` §8.4):
 *   1. Unix seconds + `11644473600` (Windows epoch)
 *   2. Round down to nearest 300-second (5-minute) boundary
 *   3. Convert to 100-ns FILETIME ticks (`* 10_000_000`)
 *   4. Uppercase SHA-256 hex of `"${ticks}${TRUSTED_CLIENT_TOKEN}"`
 */
export function computeSecMsGecToken(nowMs: number): string {
  const winSeconds = Math.floor(nowMs / 1000) + WIN_FILETIME_EPOCH_OFFSET_SEC;
  const roundedSeconds = winSeconds - (winSeconds % 300);
  // Use BigInt so `roundedSeconds * 10_000_000` (`~1.34e17`) never loses IEEE-754 integer precision!
  const ticks = BigInt(roundedSeconds) * 10_000_000n;
  return sha256HexUpper(`${ticks.toString()}${EDGE_TRUSTED_CLIENT_TOKEN}`);
}

function generateRequestId(seed: number): string {
  // Deterministic-friendly 32-char lowercase hex request ID
  return sha256HexUpper(`req:${seed}:${Math.random()}`).slice(0, 32).toLowerCase();
}

function buildSpeechConfigFrame(timestampIso: string): string {
  const payload = JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: {
            sentenceBoundaryEnabled: 'false',
            wordBoundaryEnabled: 'true',
          },
          outputFormat: EDGE_OUTPUT_FORMAT,
        },
      },
    },
  });
  return (
    `X-Timestamp:${timestampIso}\r\n` +
    `Content-Type:application/json; charset=utf-8\r\n` +
    `Path:speech.config\r\n\r\n` +
    payload
  );
}

function buildSsmlFrame(
  requestId: string,
  timestampIso: string,
  voiceId: string,
  lang: string,
  text: string,
): string {
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${escapeXmlAttr(lang)}'>` +
    `<voice name='${escapeXmlAttr(voiceId)}'>` +
    `<prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXmlText(text)}</prosody>` +
    `</voice></speak>`;

  return (
    `X-RequestId:${requestId}\r\n` +
    `Content-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${timestampIso}Z\r\n` +
    `Path:ssml\r\n\r\n` +
    ssml
  );
}

interface RawWordBoundary {
  readonly word: string;
  readonly timeMs: number;
  readonly durationMs?: number;
}

/**
 * Forward-matches Edge `WordBoundary` tokens against `utteranceText` so `WordMark` offsets
 * (`[start, end)`) are exact UTF-16 code-unit offsets into `Utterance.text` (`§8.4`).
 */
export function alignWordBoundariesToText(
  utteranceText: string,
  boundaries: readonly RawWordBoundary[],
): WordMark[] {
  const marks: WordMark[] = [];
  let cursor = 0;

  for (const b of boundaries) {
    const w = b.word;
    if (!w) continue;
    let foundIdx = utteranceText.indexOf(w, cursor);
    if (foundIdx < 0) {
      // Case-insensitive fallback scan from `cursor`
      const lowerRest = utteranceText.slice(cursor).toLowerCase();
      const rel = lowerRest.indexOf(w.toLowerCase());
      if (rel >= 0) foundIdx = cursor + rel;
    }
    if (foundIdx < 0) continue;

    const end = foundIdx + w.length;
    marks.push({
      start: foundIdx,
      end,
      timeMs: b.timeMs,
      ...(b.durationMs !== undefined ? { durationMs: b.durationMs } : {}),
      word: w,
    });
    cursor = end;
  }

  return marks;
}

function parseBinaryFrame(bytes: Uint8Array): { readonly path: string; readonly payload: Uint8Array } | null {
  if (bytes.byteLength < 2) return null;
  const headerLen = (bytes[0]! << 8) | bytes[1]!;
  if (2 + headerLen > bytes.byteLength) return null;
  const headerText = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(2, 2 + headerLen));
  const pathMatch = /(?:^|\r?\n)Path\s*:\s*([^\r\n]+)/i.exec(headerText);
  const path = pathMatch?.[1]?.trim().toLowerCase() ?? '';
  return {
    path,
    payload: bytes.subarray(2 + headerLen),
  };
}

function parseTextFrame(text: string): { readonly path: string; readonly body: string } {
  const sep = text.indexOf('\r\n\r\n');
  const splitIdx = sep >= 0 ? sep : text.indexOf('\n\n');
  const sepLen = sep >= 0 ? 4 : 2;
  const headerText = splitIdx >= 0 ? text.slice(0, splitIdx) : text;
  const body = splitIdx >= 0 ? text.slice(splitIdx + sepLen) : '';
  const pathMatch = /(?:^|\r?\n)Path\s*:\s*([^\r\n]+)/i.exec(headerText);
  return {
    path: pathMatch?.[1]?.trim().toLowerCase() ?? '',
    body,
  };
}

/**
 * Transport-injected Microsoft Edge Read-Aloud WebSocket speech provider (`ARCHITECTURE.md` §8.4).
 */
export class EdgeSpeechProvider {
  private readonly socket: SocketTransport;
  private readonly http: HttpTransport;
  private readonly now: () => number;
  private cachedVoices: { readonly expiresAt: number; readonly voices: Voice[] } | null = null;

  constructor(deps: EdgeSpeechProviderDeps) {
    this.socket = deps.socket;
    this.http = deps.http;
    this.now = deps.now ?? (() => Date.now());
  }

  async synthesize(
    req: { readonly voiceId: string; readonly text: string; readonly lang?: string; readonly timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<EdgeSynthOutput> {
    if (signal?.aborted) {
      throw new MiniBookError('cancelled', 'Edge TTS synthesis aborted');
    }

    const nowMs = this.now();
    const connId = generateRequestId(nowMs);
    const requestId = generateRequestId(nowMs + 1);
    const secMsGec = computeSecMsGecToken(nowMs);
    const wsUrl =
      `${EDGE_WSS_BASE_URL}?TrustedClientToken=${EDGE_TRUSTED_CLIENT_TOKEN}` +
      `&ConnectionId=${connId}` +
      `&Sec-MS-GEC=${secMsGec}` +
      `&Sec-MS-GEC-Version=${EDGE_SEC_MS_GEC_VERSION}`;

    const audioChunks: Uint8Array[] = [];
    const rawBoundaries: RawWordBoundary[] = [];
    const lang = req.lang ?? (req.voiceId.split('-').slice(0, 2).join('-') || 'en-US');
    const timestampIso = new Date(nowMs).toUTCString();

    return new Promise<EdgeSynthOutput>((resolve, reject) => {
      let settled = false;
      let connRef: { close(code?: number): void } | null = null;

      const finishError = (err: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        try {
          connRef?.close(1000);
        } catch {
          // Ignore close errors
        }
        if (err instanceof MiniBookError) {
          reject(err);
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (/403|forbidden|unauthorized|401/i.test(msg)) {
          reject(new MiniBookError('speech-auth', `Edge TTS rejected handshake (HTTP 403): ${msg}`, { cause: err }));
          return;
        }
        reject(new MiniBookError('network', `Edge TTS connection failed: ${msg}`, { cause: err }));
      };

      const finishSuccess = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        try {
          connRef?.close(1000);
        } catch {
          // Ignore
        }
        const audio = concatBytes(audioChunks);
        if (audio.byteLength === 0) {
          reject(new MiniBookError('speech-unavailable', 'Edge TTS returned zero audio bytes'));
          return;
        }
        const marks = alignWordBoundariesToText(req.text, rawBoundaries);
        const lastMark = marks[marks.length - 1];
        const markDuration =
          lastMark !== undefined ? lastMark.timeMs + (lastMark.durationMs ?? 120) : undefined;
        const durationMs = estimateAudioDurationMs(audio, 'audio/mpeg') ?? markDuration;
        resolve({
          audio,
          mime: 'audio/mpeg',
          ...(durationMs !== undefined ? { durationMs } : {}),
          marks,
        });
      };

      const onAbort = () => {
        finishError(new MiniBookError('cancelled', 'Edge TTS synthesis aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      let framesSent = false;
      const sendProtocolFrames = (conn: { sendText(t: string): void }) => {
        if (framesSent || settled) return;
        framesSent = true;
        conn.sendText(buildSpeechConfigFrame(timestampIso));
        conn.sendText(buildSsmlFrame(requestId, timestampIso, req.voiceId, lang, req.text));
      };

      this.socket(
        {
          url: wsUrl,
          headers: {
            Origin: EDGE_ORIGIN,
            'User-Agent': EDGE_USER_AGENT,
            Pragma: 'no-cache',
            'Cache-Control': 'no-cache',
          },
          timeoutMs: req.timeoutMs ?? 15_000,
          ...(signal ? { signal } : {}),
        },
        {
          onOpen: () => {
            if (connRef && 'sendText' in connRef) {
              sendProtocolFrames(connRef as { sendText(t: string): void });
            }
          },
          onMessage: (msg) => {
            if (settled) return;
            if (msg.kind === 'binary') {
              const parsed = parseBinaryFrame(msg.bytes);
              if (parsed?.path === 'audio' && parsed.payload.byteLength > 0) {
                audioChunks.push(parsed.payload);
              }
              return;
            }

            const frame = parseTextFrame(msg.text);
            if (frame.path === 'audio.metadata' && frame.body) {
              try {
                const json = JSON.parse(frame.body) as {
                  Metadata?: Array<{
                    Type?: string;
                    Data?: {
                      Offset?: number;
                      Duration?: number;
                      text?: { Text?: string };
                    };
                  }>;
                };
                for (const m of json.Metadata ?? []) {
                  if (m.Type === 'WordBoundary' && m.Data?.text?.Text) {
                    const timeMs = Math.round((m.Data.Offset ?? 0) / 10_000);
                    const dur = m.Data.Duration !== undefined ? Math.round(m.Data.Duration / 10_000) : undefined;
                    rawBoundaries.push({
                      word: m.Data.text.Text,
                      timeMs,
                      ...(dur !== undefined ? { durationMs: dur } : {}),
                    });
                  }
                }
              } catch {
                // Ignore malformed metadata frame
              }
            } else if (frame.path === 'turn.end') {
              finishSuccess();
            }
          },
          onClose: (info) => {
            if (settled) return;
            if (info.code === 403 || info.code === 1008 || /403/i.test(info.reason ?? '')) {
              finishError(new MiniBookError('speech-auth', `Edge TTS closed with ${info.code}`));
            } else if (audioChunks.length > 0) {
              finishSuccess();
            } else {
              finishError(new MiniBookError('network', `Edge TTS socket closed early (${info.code})`));
            }
          },
          onError: (err) => {
            finishError(err);
          },
        },
      )
        .then((conn) => {
          connRef = conn;
          sendProtocolFrames(conn);
        })
        .catch(finishError);
    });
  }

  async listVoices(signal?: AbortSignal): Promise<Voice[]> {
    const nowMs = this.now();
    if (this.cachedVoices && nowMs < this.cachedVoices.expiresAt) {
      return this.cachedVoices.voices;
    }

    const res = await this.http({
      url: EDGE_VOICES_LIST_URL,
      method: 'GET',
      headers: {
        'User-Agent': EDGE_USER_AGENT,
        'Sec-MS-GEC': computeSecMsGecToken(nowMs),
        'Sec-MS-GEC-Version': EDGE_SEC_MS_GEC_VERSION,
      },
      timeoutMs: 10_000,
      ...(signal ? { signal } : {}),
    });

    if (res.status === 401 || res.status === 403) {
      throw new MiniBookError('speech-auth', `Edge voice list returned HTTP ${res.status}`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new MiniBookError('network', `Edge voice list returned HTTP ${res.status}`);
    }

    const bodyText = new TextDecoder('utf-8', { fatal: false }).decode(res.body);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch (err) {
      throw new MiniBookError('speech-unavailable', 'Invalid JSON from Edge voice list', { cause: err });
    }

    if (!Array.isArray(parsed)) return [];
    const voices: Voice[] = [];
    for (const raw of parsed) {
      if (!raw || typeof raw !== 'object') continue;
      const obj = raw as Record<string, unknown>;
      const shortName = typeof obj['ShortName'] === 'string' ? obj['ShortName'] : null;
      const friendlyName = typeof obj['FriendlyName'] === 'string' ? obj['FriendlyName'] : shortName;
      const locale = typeof obj['Locale'] === 'string' ? obj['Locale'] : 'en-US';
      if (!shortName) continue;
      voices.push({
        id: shortName,
        provider: 'edge',
        name: friendlyName ?? shortName,
        lang: locale,
        quality: 'neural',
        local: false,
      });
    }

    this.cachedVoices = {
      expiresAt: nowMs + EDGE_VOICE_CACHE_TTL_MS,
      voices,
    };
    return voices;
  }
}
