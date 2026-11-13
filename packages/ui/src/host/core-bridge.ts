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
  type Locator,
  type PlatformHost,
  type SearchHit,
  type SectionDoc,
  type SectionRef,
  type SectionText,
  type SegmentOptions,
  type SynthSchedulerConfig,
  type SynthSchedulerOptions,
  type TocItem,
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
  if (isMockHost(host)) {
    return host.openMockSession(bookId);
  }
  const rawBytes = new WindowedByteSource(host.files.byteSource(bookId, 'book'));
  return openBook(
    rawBytes,
    {
      fileName: detail?.fileName ?? `${bookId}.epub`,
      getDerived: (name) => {
        if (name !== 'text.bin') return null;
        const derived = host.files.byteSource(bookId, 'text');
        return derived.size > 0 ? new WindowedByteSource(derived) : null;
      },
    },
    detail?.index,
  );
}

export async function inspectBookWithHost(
  host: PlatformHost,
  src: ImportSource,
  hint: BookInspectHint,
): Promise<InspectedBook> {
  if (isMockHost(host)) {
    return host.inspectMockSource(src, hint);
  }
  return inspectBook(src.bytes, hint);
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

      // First-utterance rule (`ARCHITECTURE.md` §8.1 #6): split >80-char initial mid-book utterance once at a clause mark
      if (out.length === 0 && options?.splitFirstLongUtterance && text.length > 80) {
        const mid = Math.floor(text.length / 2);
        let splitRel = -1;
        let bestDist = Infinity;
        for (let k = 16; k < text.length - 16; k++) {
          if (/^[，、；：,;:—]$/.test(text[k]!)) {
            const d = Math.abs(k - mid);
            if (d < bestDist) {
              bestDist = d;
              splitRel = k + 1;
            }
          }
        }
        if (splitRel > 0) {
          let leftEnd = s + splitRel;
          while (leftEnd > s && /\s/.test(full[leftEnd - 1]!)) leftEnd--;
          let rightStart = s + splitRel;
          while (rightStart < e && /\s/.test(full[rightStart]!)) rightStart++;
          if (leftEnd > s && e > rightStart) {
            const leftText = full.slice(s, leftEnd);
            const rightText = full.slice(rightStart, e);
            out.push({
              id: `${sectionIndex}:${s}-${leftEnd}`,
              section: sectionIndex,
              start: s,
              end: leftEnd,
              blockIndex,
              text: leftText,
              lang: detectLang(leftText, block.lang, options?.bookLang ?? null),
              pauseAfterMs: 150,
            });
            out.push({
              id: `${sectionIndex}:${rightStart}-${e}`,
              section: sectionIndex,
              start: rightStart,
              end: e,
              blockIndex,
              text: rightText,
              lang: detectLang(rightText, block.lang, options?.bookLang ?? null),
              pauseAfterMs,
            });
            continue;
          }
        }
      }

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

// ---------------------------------------------------------------------------
// Section Character-Length & Book-% Share Resolution (`[P1-F1]` / ARCH §5.4)
// ---------------------------------------------------------------------------

const sessionCharLengths = new WeakMap<BookSession, Map<number, number>>();
const sessionCharLengthRevisions = new WeakMap<BookSession, number>();
const sessionPendingLengthLoads = new WeakMap<BookSession, Map<number, Promise<number>>>();

function getCharLenMap(session: BookSession): Map<number, number> {
  let map = sessionCharLengths.get(session);
  if (!map) {
    map = new Map<number, number>();
    sessionCharLengths.set(session, map);
  }
  return map;
}

export function getSessionCharLengthRevision(session: BookSession | null): number {
  if (!session) return 0;
  return sessionCharLengthRevisions.get(session) ?? 0;
}

export function fullSectionLengthFromDoc(doc: SectionDoc): number {
  if (doc.units && doc.units.length > 0) {
    const last = doc.units[doc.units.length - 1]!;
    return Math.max(last.end, doc.unit.end, doc.text.text.length);
  }
  return Math.max(doc.unit.end, doc.text.text.length);
}

export function recordSectionCharLength(
  session: BookSession,
  sectionIndex: number,
  charLength: number,
): number {
  const clean = Math.max(0, Math.floor(charLength));
  const map = getCharLenMap(session);
  if (map.get(sectionIndex) !== clean) {
    map.set(sectionIndex, clean);
    sessionCharLengthRevisions.set(session, (sessionCharLengthRevisions.get(session) ?? 0) + 1);
  }
  return clean;
}

export function recordSectionDocLength(session: BookSession, doc: SectionDoc): number {
  return recordSectionCharLength(session, doc.index, fullSectionLengthFromDoc(doc));
}

export function getKnownSectionCharLength(
  session: BookSession,
  sectionIndex: number,
): number | undefined {
  const cached = getCharLenMap(session).get(sectionIndex);
  if (cached !== undefined) return cached;
  const ref = session.spine.find((s) => s.index === sectionIndex) as
    | (SectionRef & { readonly charCount?: number; readonly charLength?: number })
    | undefined;
  const persisted = ref?.charCount ?? ref?.charLength;
  if (typeof persisted === 'number' && Number.isFinite(persisted) && persisted >= 0) {
    getCharLenMap(session).set(sectionIndex, persisted);
    return persisted;
  }
  return undefined;
}

function collectMaxTocOffsetForSection(
  items: readonly TocItem[],
  sectionIndex: number,
  curMax = 0,
): number {
  let maxOff = curMax;
  for (const item of items) {
    if (item.locator.section === sectionIndex && item.locator.offset > maxOff) {
      maxOff = item.locator.offset;
    }
    if (item.children.length > 0) {
      maxOff = collectMaxTocOffsetForSection(item.children, sectionIndex, maxOff);
    }
  }
  return maxOff;
}

export function estimateSectionCharLength(session: BookSession, sectionIndex: number): number {
  const known = getKnownSectionCharLength(session, sectionIndex);
  if (known !== undefined) return known;

  const map = getCharLenMap(session);
  let sumChars = 0;
  let sumBytes = 0;
  for (const s of session.spine) {
    const c = map.get(s.index);
    if (c !== undefined && c > 0 && s.sizeHint > 0) {
      sumChars += c;
      sumBytes += s.sizeHint;
    }
  }
  const ratio = sumBytes > 0 ? sumChars / sumBytes : 1;
  const ref = session.spine.find((s) => s.index === sectionIndex);
  const rawEstimate = Math.round(Math.max(1, ref?.sizeHint ?? 1) * ratio);
  const minFromToc = collectMaxTocOffsetForSection(session.toc, sectionIndex);
  return Math.max(1, rawEstimate, minFromToc + 1);
}

export async function loadFullSectionText(
  session: BookSession,
  sectionIndex: number,
): Promise<SectionText> {
  if (session.loadSectionText) {
    const txt = await session.loadSectionText(sectionIndex);
    recordSectionCharLength(session, sectionIndex, txt.text.length);
    return txt;
  }
  if (session.loadSectionUnits) {
    const units = await session.loadSectionUnits(sectionIndex);
    if (units.length === 1) {
      const only = units[0]!;
      recordSectionDocLength(session, only);
      return only.text;
    }
    let fullStr = '';
    const blocks: Array<{
      start: number;
      end: number;
      kind: SectionText['blocks'][number]['kind'];
      lang: string | null;
    }> = [];
    for (const u of units) {
      const base = fullStr.length;
      fullStr += u.text.text;
      for (const b of u.text.blocks) {
        blocks.push({
          start: base + b.start,
          end: base + b.end,
          kind: b.kind,
          lang: b.lang,
        });
      }
    }
    recordSectionCharLength(session, sectionIndex, fullStr.length);
    return { text: fullStr, blocks };
  }
  const doc = await session.loadSection(sectionIndex, 0);
  recordSectionDocLength(session, doc);
  return doc.text;
}

export async function ensureSectionCharLength(
  session: BookSession,
  sectionIndex: number,
): Promise<number> {
  const known = getKnownSectionCharLength(session, sectionIndex);
  if (known !== undefined) return known;

  let pendingMap = sessionPendingLengthLoads.get(session);
  if (!pendingMap) {
    pendingMap = new Map<number, Promise<number>>();
    sessionPendingLengthLoads.set(session, pendingMap);
  }
  const existing = pendingMap.get(sectionIndex);
  if (existing) return existing;

  const task = (async (): Promise<number> => {
    try {
      const txt = await loadFullSectionText(session, sectionIndex);
      return recordSectionCharLength(session, sectionIndex, txt.text.length);
    } finally {
      pendingMap.delete(sectionIndex);
    }
  })();

  pendingMap.set(sectionIndex, task);
  return task;
}

export function fractionForSessionLocator(
  session: BookSession,
  locator: Locator,
  explicitSectionCharLength?: number,
): number {
  const charLen =
    explicitSectionCharLength ?? estimateSectionCharLength(session, locator.section);
  return fractionForLocator(session.spine, locator, Math.max(1, charLen));
}

export function sectionShareForFraction(
  spine: readonly SectionRef[],
  fraction: number,
): { readonly section: number; readonly share: number } {
  const clamped = Math.max(0, Math.min(1, fraction));
  const linear = spine.filter((s) => s.linear);
  const items = linear.length > 0 ? linear : spine;
  if (items.length === 0) return { section: 0, share: 0 };

  for (let i = 0; i < items.length; i++) {
    const s = items[i]!;
    const fStart = fractionForLocator(spine, { section: s.index, offset: 0 }, 1);
    const fEnd = fractionForLocator(spine, { section: s.index, offset: 1 }, 1);
    if (clamped <= fEnd + 1e-12 || i === items.length - 1) {
      const span = fEnd - fStart;
      const share = span > 1e-9 ? Math.max(0, Math.min(1, (clamped - fStart) / span)) : 0;
      return { section: s.index, share };
    }
  }
  const last = items[items.length - 1]!;
  return { section: last.index, share: 1 };
}

export async function resolveLocatorForFraction(
  session: BookSession,
  fraction: number,
): Promise<Locator> {
  const { section, share } = sectionShareForFraction(session.spine, fraction);
  const charLen = await ensureSectionCharLength(session, section);
  const offset = charLen > 0 ? Math.min(charLen, Math.round(share * charLen)) : 0;
  return { section, offset };
}

export { fractionForLocator, reanchorLocator };
