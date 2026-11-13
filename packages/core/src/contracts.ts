/**
 * Locked public function & class signatures for `@minibook/core` (`ARCHITECTURE.md` §3, §4, §5, §8).
 *
 * On `main` (scaffold commit) these provide exact compile-time contracts so `@minibook/ui` and
 * `@minibook/host-*` can develop in isolated worktrees with zero signature drift. Full pure-TS
 * implementations land on `feat/core`.
 */
import { MiniBookError } from './errors.js';
import type {
  AttachedAudio,
  BookId,
  BookIndex,
  BookInspectHint,
  BookOpenHint,
  BookSession,
  ByteSource,
  HttpTransport,
  InspectedBook,
  Locator,
  SavedPosition,
  SearchHit,
  SectionRef,
  SectionText,
  SocketTransport,
  SynthRequest,
  SynthResult,
  Utterance,
  Voice,
  WordMark,
} from './types.js';

export interface WindowedByteSourceOptions {
  /** Window alignment size in bytes (default `65536` = 64 KiB). */
  readonly windowBytes?: number;
  /** Maximum cached bytes across windows (default `2097152` = 2 MiB). */
  readonly maxCacheBytes?: number;
  /** Maximum bytes requested per underlying `read` call (default `1048576` = 1 MiB). */
  readonly maxReadBytes?: number;
}

/**
 * Coalesces small random reads into 64 KiB-aligned windows backed by a 2 MiB LRU cache,
 * splitting reads > 1 MiB into sequential <= 1 MiB calls (`ARCHITECTURE.md` §3.3).
 */
export class WindowedByteSource implements ByteSource {
  readonly size: number;
  private readonly inner: ByteSource;

  constructor(inner: ByteSource, _options?: WindowedByteSourceOptions) {
    this.inner = inner;
    this.size = inner.size;
  }

  read(offset: number, length: number): Promise<Uint8Array> {
    return this.inner.read(offset, length);
  }

  readAll(): Promise<Uint8Array> {
    if (this.inner.readAll) return this.inner.readAll();
    return this.inner.read(0, this.size);
  }
}

export function memoryByteSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.byteLength,
    async read(offset: number, length: number): Promise<Uint8Array> {
      const start = Math.max(0, Math.min(bytes.byteLength, offset));
      const end = Math.max(start, Math.min(bytes.byteLength, start + Math.max(0, length)));
      return bytes.subarray(start, end);
    },
    async readAll(): Promise<Uint8Array> {
      return bytes;
    },
  };
}

export async function computeBookId(_src: ByteSource): Promise<BookId> {
  throw new MiniBookError('unsupported', 'computeBookId stub on scaffold');
}

export async function openBook(
  _src: ByteSource,
  _hint: BookOpenHint,
  _index?: BookIndex,
): Promise<BookSession> {
  throw new MiniBookError('unsupported', 'openBook stub on scaffold');
}

export async function inspectBook(
  _src: ByteSource,
  _hint: BookInspectHint,
): Promise<InspectedBook> {
  throw new MiniBookError('unsupported', 'inspectBook stub on scaffold');
}

export async function* search(
  _session: BookSession,
  _query: string,
  _options?: { readonly signal?: AbortSignal },
): AsyncGenerator<SearchHit, void, void> {
  // Implemented on feat/core
}

export const searchBook = search;

export function fractionForLocator(
  spine: readonly SectionRef[],
  locator: Locator,
  currentSectionLength?: number,
): number {
  const linear = spine.filter((s) => s.linear || s.index === locator.section);
  const total = linear.reduce((acc, s) => acc + Math.max(1, s.sizeHint), 0);
  if (total <= 0) return 0;
  let before = 0;
  let currentWeight = 1;
  for (const s of linear) {
    const w = Math.max(1, s.sizeHint);
    if (s.index < locator.section) {
      before += w;
    } else if (s.index === locator.section) {
      currentWeight = w;
      break;
    }
  }
  const denom = Math.max(1, currentSectionLength ?? currentWeight);
  const within = Math.max(0, Math.min(1, locator.offset / denom));
  return Math.max(0, Math.min(1, (before + within * currentWeight) / total));
}

export function locatorForFraction(spine: readonly SectionRef[], fraction: number): Locator {
  const clamped = Math.max(0, Math.min(1, fraction));
  const linear = spine.filter((s) => s.linear);
  const items = linear.length > 0 ? linear : spine;
  if (items.length === 0) return { section: 0, offset: 0 };
  const total = items.reduce((acc, s) => acc + Math.max(1, s.sizeHint), 0);
  const target = clamped * total;
  let acc = 0;
  for (const s of items) {
    const w = Math.max(1, s.sizeHint);
    if (acc + w >= target) {
      const localShare = w > 0 ? Math.max(0, Math.min(1, (target - acc) / w)) : 0;
      return { section: s.index, offset: Math.floor(localShare * s.sizeHint) };
    }
    acc += w;
  }
  const last = items[items.length - 1]!;
  return { section: last.index, offset: Math.max(0, last.sizeHint) };
}

export function reanchorLocator(
  sectionText: SectionText,
  saved: Pick<SavedPosition, 'offset' | 'snippet' | 'fraction'>,
): number {
  const str = sectionText.text;
  if (str.length === 0) return 0;
  const clamped = Math.max(0, Math.min(str.length, saved.offset));
  if (!saved.snippet) return clamped;
  if (str.slice(clamped, clamped + saved.snippet.length) === saved.snippet) {
    return clamped;
  }
  const winStart = Math.max(0, clamped - 2000);
  const winEnd = Math.min(str.length, clamped + 2000 + saved.snippet.length);
  const found = str.slice(winStart, winEnd).indexOf(saved.snippet);
  if (found >= 0) return winStart + found;
  return Math.max(0, Math.min(str.length, Math.floor(saved.fraction * str.length)));
}

export interface SegmentOptions {
  readonly bookLang?: string | null;
  readonly startOffset?: number;
  readonly splitFirstLongUtterance?: boolean;
}

export function segmentSection(
  _sectionIndex: number,
  _sectionText: SectionText,
  _options?: SegmentOptions,
): Utterance[] {
  return [];
}

export async function computeSpeechCacheKey(
  req: Pick<SynthRequest, 'engine' | 'voiceId' | 'model' | 'text'>,
): Promise<string> {
  const raw = `${req.engine}|${req.voiceId}|${req.model ?? ''}|${req.text}`;
  const bytes = new TextEncoder().encode(raw);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
  let hex = '';
  for (let i = 0; i < digest.length; i++) {
    hex += digest[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

export interface SynthSchedulerConfig {
  readonly engine: 'edge' | 'openai';
  readonly voiceId: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly maxConcurrency?: number;
}

export interface SynthSchedulerOptions {
  readonly synthesize: (req: SynthRequest, signal: AbortSignal) => Promise<SynthResult>;
  readonly attachAudio: (id: string, audio: AttachedAudio) => void;
  readonly onEngineSlow?: (info: { readonly rtf: number; readonly engine: 'edge' | 'openai' }) => void;
  readonly onUtteranceFailed?: (id: string, error: MiniBookError) => void;
  readonly isHidden?: () => boolean;
  readonly now?: () => number;
}

export class SynthScheduler {
  constructor(_options: SynthSchedulerOptions) {}
  configure(_config: SynthSchedulerConfig | null): void {}
  setQueue(_utterances: readonly Utterance[], _currentId: string | null): void {}
  onUtteranceStart(_id: string): void {}
  onVisibilityChange(_hidden: boolean): void {}
  abortAll(): void {}
  getRtf(): number | null {
    return null;
  }
  getEffectiveConcurrency(): number {
    return 1;
  }
  dispose(): void {}
}

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

export class EdgeSpeechProvider {
  constructor(_deps: EdgeSpeechProviderDeps) {}
  async synthesize(
    _req: { readonly voiceId: string; readonly text: string; readonly lang?: string },
    _signal?: AbortSignal,
  ): Promise<EdgeSynthOutput> {
    throw new MiniBookError('unsupported', 'EdgeSpeechProvider stub on scaffold');
  }
  async listVoices(_signal?: AbortSignal): Promise<Voice[]> {
    return [];
  }
}

export interface OpenAiSpeechProviderDeps {
  readonly http: HttpTransport;
}

export interface OpenAiSynthOutput {
  readonly audio: Uint8Array;
  readonly mime: 'audio/mpeg' | 'audio/wav';
  readonly durationMs?: number;
}

export class OpenAiSpeechProvider {
  constructor(_deps: OpenAiSpeechProviderDeps) {}
  async synthesize(
    _req: {
      readonly baseUrl: string;
      readonly model: string;
      readonly voiceId: string;
      readonly text: string;
      readonly apiKeyHeader?: string;
      readonly timeoutMs?: number;
    },
    _signal?: AbortSignal,
  ): Promise<OpenAiSynthOutput> {
    throw new MiniBookError('unsupported', 'OpenAiSpeechProvider stub on scaffold');
  }
  async listVoices(
    _opts: { readonly baseUrl: string; readonly apiKeyHeader?: string },
    _signal?: AbortSignal,
  ): Promise<Voice[]> {
    return [];
  }
}
