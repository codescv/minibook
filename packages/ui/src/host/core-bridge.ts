import {
  MiniBookError,
  SynthScheduler,
  WindowedByteSource,
  fractionForLocator,
  inspectBook,
  locatorForFraction,
  openBook,
  reanchorLocator,
  search as coreSearch,
  segmentSection as coreSegmentSection,
  type BookId,
  type BookInspectHint,
  type BookSession,
  type ImportSource,
  type InspectedBook,
  type LibraryBookDetail,
  type PlatformHost,
  type SearchHit,
  type SectionText,
  type SegmentOptions,
  type SynthSchedulerConfig,
  type SynthSchedulerOptions,
  type Utterance,
} from '@minibook/core';

export interface MockHostHooks {
  readonly __isMockHost: true;
  openMockSession(bookId: BookId): Promise<BookSession>;
  inspectMockSource(src: ImportSource, hint: BookInspectHint): Promise<InspectedBook>;
}

export interface SearchFallbackSession extends BookSession {
  searchFallback?(query: string, signal?: AbortSignal): AsyncGenerator<SearchHit, void, void>;
}

function isMockHost(host: PlatformHost): host is PlatformHost & MockHostHooks {
  return '__isMockHost' in host && (host as unknown as MockHostHooks).__isMockHost === true;
}

export async function openBookWithHost(
  host: PlatformHost,
  bookId: BookId,
  detail: LibraryBookDetail | null,
): Promise<BookSession> {
  const rawBytes = new WindowedByteSource(host.files.byteSource(bookId, 'book'));
  try {
    return await openBook(
      rawBytes,
      {
        fileName: detail?.fileName ?? `${bookId}.epub`,
        getDerived: (name) => (name === 'text.bin' ? new WindowedByteSource(host.files.byteSource(bookId, 'text')) : null),
      },
      detail?.index,
    );
  } catch (err) {
    if (err instanceof MiniBookError && err.code === 'unsupported' && isMockHost(host)) {
      return host.openMockSession(bookId);
    }
    throw err;
  }
}

export async function inspectBookWithHost(
  host: PlatformHost,
  src: ImportSource,
  hint: BookInspectHint,
): Promise<InspectedBook> {
  try {
    return await inspectBook(src.bytes, hint);
  } catch (err) {
    if (err instanceof MiniBookError && err.code === 'unsupported' && isMockHost(host)) {
      return host.inspectMockSource(src, hint);
    }
    throw err;
  }
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const CLOSERS = new Set(['"', "'", '”', '’', '」', '』', '）', ')', '】', '》', '〉', ']']);
const ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'vs', 'etc', 'no', 'fig', 'vol', 'inc', 'ltd', 'jr', 'sr',
]);

function detectLang(slice: string, blockLang: string | null, bookLang: string | null): string {
  if (blockLang) return blockLang;
  if (/[\u3040-\u30ff]/.test(slice)) return 'ja';
  if (/[\uac00-\ud7af]/.test(slice)) return 'ko';
  if (CJK_RE.test(slice)) {
    if (bookLang && (bookLang.startsWith('zh') || bookLang.startsWith('ja'))) return bookLang;
    return 'zh-CN';
  }
  return bookLang ?? 'en';
}

/**
 * Calls `@minibook/core`'s `segmentSection`; falls back only when running against
 * the unmerged scaffold stub where `coreSegmentSection` returns `[]` for non-empty text.
 * Preserves the strict invariant `u.text === sectionText.text.slice(u.start, u.end)`.
 */
export function segmentSectionSafe(
  sectionIndex: number,
  sectionText: SectionText,
  options?: SegmentOptions,
): Utterance[] {
  const fromCore = coreSegmentSection(sectionIndex, sectionText, options);
  if (fromCore.length > 0 || sectionText.text.trim().length === 0) {
    return fromCore;
  }

  const full = sectionText.text;
  const blocks =
    sectionText.blocks.length > 0
      ? sectionText.blocks
      : [{ start: 0, end: full.length, kind: 'p' as const, lang: null }];
  const startFilter = options?.startOffset ?? 0;
  const out: Utterance[] = [];

  blocks.forEach((block, blockIndex) => {
    let cursor = Math.max(0, block.start);
    const blockEnd = Math.min(full.length, block.end);
    if (blockEnd <= startFilter) return;

    const rawRanges: Array<{ s: number; e: number }> = [];
    let segStart = cursor;

    while (cursor < blockEnd) {
      const ch = full[cursor]!;
      const isCjkTerm = ch === '。' || ch === '！' || ch === '？' || ch === '；' || ch === '…';
      let isLatinTerm = false;

      if (ch === '.' || ch === '!' || ch === '?') {
        const next = full[cursor + 1];
        if (ch === '.') {
          const prevWordMatch = full.slice(Math.max(segStart, cursor - 12), cursor).match(/([A-Za-z]+)$/);
          const prevWord = prevWordMatch?.[1]?.toLowerCase() ?? '';
          const inDecimal = /\d/.test(full[cursor - 1] ?? '') && /\d/.test(next ?? '');
          if (!inDecimal && !ABBREV.has(prevWord) && prevWord.length !== 1) {
            isLatinTerm = cursor + 1 >= blockEnd || /\s/.test(next ?? '') || CLOSERS.has(next ?? '');
          }
        } else {
          isLatinTerm = cursor + 1 >= blockEnd || /\s/.test(next ?? '') || CLOSERS.has(next ?? '');
        }
      }

      if (isCjkTerm || isLatinTerm) {
        let end = cursor + 1;
        while (end < blockEnd && /^[.!?。！？…]$/.test(full[end]!)) end++;
        while (end < blockEnd && CLOSERS.has(full[end]!)) end++;
        rawRanges.push({ s: segStart, e: end });
        segStart = end;
        cursor = end;
        continue;
      }
      cursor++;
    }

    if (segStart < blockEnd) {
      rawRanges.push({ s: segStart, e: blockEnd });
    }

    for (let i = 0; i < rawRanges.length; i++) {
      let { s, e } = rawRanges[i]!;
      while (s < e && /\s/.test(full[s]!)) s++;
      while (e > s && /\s/.test(full[e - 1]!)) e--;
      if (e <= s || e <= startFilter) continue;

      const text = full.slice(s, e);
      const isLastInBlock = i === rawRanges.length - 1;
      const pauseAfterMs =
        block.kind === 'h' ? 800 : isLastInBlock ? 450 : 200;

      out.push({
        id: `${sectionIndex}:${s}-${e}`,
        section: sectionIndex,
        start: s,
        end: e,
        blockIndex,
        text,
        lang: detectLang(text, block.lang, options?.bookLang ?? null),
        pauseAfterMs,
      });
    }
  });

  if (out.length > 0) {
    const lastIdx = out.length - 1;
    const last = out[lastIdx]!;
    out[lastIdx] = { ...last, pauseAfterMs: 1200 };
  }

  return out;
}

export async function* searchBookSafe(
  session: BookSession,
  query: string,
  options?: { readonly signal?: AbortSignal },
): AsyncGenerator<SearchHit, void, void> {
  const trimmed = query.trim();
  if (!trimmed) return;

  let yielded = 0;
  for await (const hit of coreSearch(session, trimmed, options)) {
    yielded++;
    yield hit;
  }

  const fallbackSession = session as SearchFallbackSession;
  if (yielded === 0 && typeof fallbackSession.searchFallback === 'function') {
    for await (const hit of fallbackSession.searchFallback(trimmed, options?.signal)) {
      yield hit;
    }
  }
}

function isScaffoldSchedulerStub(instance: SynthScheduler): boolean {
  const src = Function.prototype.toString.call(instance.setQueue);
  return src.replace(/\s+/g, '') === 'setQueue(_utterances,_currentId){}';
}

export function createSynthScheduler(options: SynthSchedulerOptions): SynthScheduler {
  const real = new SynthScheduler(options);
  if (!isScaffoldSchedulerStub(real)) {
    return real;
  }
  return new FallbackSynthScheduler(options) as unknown as SynthScheduler;
}

class FallbackSynthScheduler {
  private readonly opts: SynthSchedulerOptions;
  private config: SynthSchedulerConfig | null = null;
  private queue: Utterance[] = [];
  private currentId: string | null = null;
  private generation = 0;
  private inFlight = new Map<string, AbortController>();
  private doneIds = new Set<string>();
  private failedIds = new Set<string>();
  private rtfEma: number | null = null;

  constructor(opts: SynthSchedulerOptions) {
    this.opts = opts;
  }

  configure(config: SynthSchedulerConfig | null): void {
    this.abortAll();
    this.config = config;
    this.doneIds.clear();
    this.failedIds.clear();
    this.rtfEma = null;
    this.pump();
  }

  setQueue(utterances: readonly Utterance[], currentId: string | null): void {
    this.queue = [...utterances];
    this.currentId = currentId ?? utterances[0]?.id ?? null;
    this.pump();
  }

  onUtteranceStart(id: string): void {
    this.currentId = id;
    this.pump();
  }

  onVisibilityChange(_hidden: boolean): void {
    this.pump();
  }

  abortAll(): void {
    this.generation++;
    for (const ctl of this.inFlight.values()) {
      ctl.abort();
    }
    this.inFlight.clear();
  }

  getRtf(): number | null {
    return this.rtfEma;
  }

  getEffectiveConcurrency(): number {
    return this.config?.maxConcurrency ?? 2;
  }

  dispose(): void {
    this.abortAll();
  }

  private pump(): void {
    if (!this.config || this.queue.length === 0) return;
    const maxConc = this.config.maxConcurrency ?? 2;
    const startIdx = Math.max(
      0,
      this.currentId ? this.queue.findIndex((u) => u.id === this.currentId) : 0,
    );

    for (let i = startIdx; i < Math.min(this.queue.length, startIdx + 6); i++) {
      if (this.inFlight.size >= maxConc) break;
      const u = this.queue[i]!;
      if (this.doneIds.has(u.id) || this.failedIds.has(u.id) || this.inFlight.has(u.id)) {
        continue;
      }
      this.fetchOne(u, this.config, this.generation);
    }
  }

  private fetchOne(u: Utterance, cfg: SynthSchedulerConfig, gen: number): void {
    const ctl = new AbortController();
    this.inFlight.set(u.id, ctl);
    void this.opts
      .synthesize(
        {
          engine: cfg.engine,
          voiceId: cfg.voiceId,
          ...(cfg.model !== undefined ? { model: cfg.model } : {}),
          ...(cfg.baseUrl !== undefined ? { baseUrl: cfg.baseUrl } : {}),
          text: u.text,
          lang: u.lang,
        },
        ctl.signal,
      )
      .then((res) => {
        if (gen !== this.generation) return;
        this.inFlight.delete(u.id);
        this.doneIds.add(u.id);
        this.opts.attachAudio(u.id, {
          ref: res.ref,
          ...(res.durationMs !== undefined ? { durationMs: res.durationMs } : {}),
          ...(res.marks !== undefined ? { marks: res.marks } : {}),
        });
        const dur = Math.max(200, res.durationMs ?? u.text.length * 65);
        const sample = res.synthMs / dur;
        this.rtfEma = this.rtfEma === null ? sample : this.rtfEma * 0.7 + sample * 0.3;
        if (this.rtfEma / this.getEffectiveConcurrency() >= 0.9) {
          this.opts.onEngineSlow?.({ rtf: this.rtfEma, engine: cfg.engine });
        }
        this.pump();
      })
      .catch((err: unknown) => {
        if (gen !== this.generation) return;
        this.inFlight.delete(u.id);
        this.failedIds.add(u.id);
        this.opts.onUtteranceFailed?.(u.id, MiniBookError.wrap(err, 'network'));
        this.pump();
      });
  }
}

export { fractionForLocator, locatorForFraction, reanchorLocator };
