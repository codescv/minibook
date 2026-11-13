/**
 * @minibook/core — shared types and cross-package contracts.
 *
 * THIS FILE IS THE AUTHORITATIVE CONTRACT across `@minibook/{core,ui,host-node,host-android}`
 * and the iOS native bridge (`//experimental/users/chii/ios/minibook`).
 *
 * Rules (`ARCHITECTURE.md` §0):
 *   - Zero `node:*`, zero DOM-only interfaces, zero Capacitor imports.
 *   - Allowed Web-standard types: `Uint8Array`, `AbortSignal`, `URL`.
 *   - Compatible with `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
 *     and `verbatimModuleSyntax`.
 */

// ---------------------------------------------------------------------------
// §1. Primitives & Error Shapes (ARCHITECTURE.md §0, §7.1)
// ---------------------------------------------------------------------------

/** Stable deduplication key: `"b_" + sha1Hex(size + first256KiB + last256KiB)`. */
export type BookId = string;

/** Unix epoch milliseconds. */
export type EpochMs = number;

export type Unsubscribe = () => void;

export type BookFormat = 'epub' | 'kf8' | 'mobi' | 'fb2' | 'txt' | 'md';

export type ReadingDirection = 'ltr' | 'rtl';

export type MiniBookErrorCode =
  | 'unsupported-format'
  | 'drm-protected'
  | 'corrupt-book'
  | 'too-large'
  | 'not-found'
  | 'invalid-argument'
  | 'network'
  | 'speech-unavailable'
  | 'speech-auth'
  | 'cancelled'
  | 'unsupported';

export interface MiniBookErrorShape {
  readonly code: MiniBookErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// §2. Bounded Random-Access ByteSource (ARCHITECTURE.md §3, §3.3)
// ---------------------------------------------------------------------------

/**
 * Random-access bytes; the ONLY way `@minibook/core` touches a book or derived file.
 * Every host MUST transfer at most `length` bytes on `read(offset, length)`.
 */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Optional fast path for whole-file consumers at import time only. */
  readAll?(): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// §3. Book Metadata, Persisted BookIndex, Content Model & Locator (§4, §5)
// ---------------------------------------------------------------------------

export interface BookMeta {
  readonly title: string;
  readonly authors: readonly string[];
  readonly language: string | null;
  readonly identifier: string | null;
  readonly format: BookFormat;
  readonly direction: ReadingDirection;
  readonly fixedLayout: boolean;
  readonly description?: string;
  readonly publisher?: string;
  readonly publishedAt?: string;
}

/**
 * Single device-independent position coordinate (`ARCHITECTURE.md` §5.4):
 * UTF-16 code-unit offset into `SectionText.text` of `section`.
 */
export interface Locator {
  readonly section: number;
  readonly offset: number;
}

export interface SavedPosition extends Locator {
  readonly fraction: number;
  /** Up to 32 counted characters starting at `offset` for edition re-anchoring. */
  readonly snippet: string;
  readonly updatedAt: EpochMs;
}

export interface Bookmark extends Locator {
  readonly id: string;
  readonly bookId: BookId;
  readonly fraction: number;
  readonly label: string;
  readonly createdAt: EpochMs;
}

export interface BookmarkInput {
  readonly section: number;
  readonly offset: number;
  readonly fraction: number;
  readonly label: string;
}

export interface TocItem {
  readonly title: string;
  readonly locator: Locator;
  readonly href?: string;
  readonly children: readonly TocItem[];
}

export interface SectionRef {
  readonly index: number;
  readonly id?: string;
  readonly href?: string;
  readonly title?: string;
  readonly linear: boolean;
  /** Bytes/chars weight of counted text; used for whole-book `%` (`fraction`) math. */
  readonly sizeHint: number;
}

export type TextBlockKind = 'p' | 'h' | 'li' | 'cell' | 'quote' | 'pre' | 'other';

export interface TextBlock {
  readonly start: number;
  readonly end: number;
  readonly kind: TextBlockKind;
  readonly lang: string | null;
}

/**
 * Canonical counted text model (`ARCHITECTURE.md` §5.3).
 * Excludes `[data-mb-skip]` subtrees (`rt`, `rp`, noterefs, pagebreaks, `aria-hidden`).
 */
export interface SectionText {
  readonly text: string;
  readonly blocks: readonly TextBlock[];
}

export interface RenderUnitRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Sanitized render unit produced by `BookSession.loadSection` (`ARCHITECTURE.md` §4.8, §5.1).
 * For sections <= 40,000 chars, `unit` is `{ start: 0, end: text.text.length }` and `units` has length 1.
 * For sections > 40,000 chars, `units` lists all virtual render-unit ranges `[start, end)` in section coordinates.
 */
export interface SectionDoc {
  readonly index: number;
  readonly unit: RenderUnitRange;
  readonly unitIndex?: number;
  readonly units?: readonly RenderUnitRange[];
  /** Well-formed sanitized XHTML fragment (`<body>` content), resource URLs rewritten to `mb-res:<path>`. */
  readonly xhtml: string;
  /** Sanitized publisher CSS (linked + inline `<style>`), `url()` rewritten to `mb-res:<path>`. */
  readonly css: string;
  readonly lang: string | null;
  readonly dir: ReadingDirection;
  /** Counted text model of this render unit (`text.text` matches `xhtml` 1-to-1 per I-TEXT). */
  readonly text: SectionText;
  /** Archive paths referenced via `mb-res:<path>` inside `xhtml` or `css`. */
  readonly resources: readonly string[];
  /** True when the unit contains only a single image/SVG and zero counted text (`§6.3`). */
  readonly isCoverLike?: boolean;
}

export interface BookResource {
  readonly bytes: Uint8Array;
  readonly mime: string;
}

export type CoverImage = BookResource;

export type ResolvedHref = Locator | { readonly external: string } | null;

export interface SearchHit {
  readonly locator: Locator;
  readonly length: number;
  readonly snippet: string;
  readonly chapterTitle?: string;
}

// --- Persisted format-specific acceleration structures (`BookIndex`, §4) ---

export interface ZipEntryIndex {
  readonly name: string;
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly crc32: number;
  readonly flags: number;
}

export interface EpubManifestItem {
  readonly id: string;
  readonly href: string;
  readonly mediaType: string;
  readonly properties?: readonly string[];
}

export interface EpubFontObfuscationRule {
  readonly algorithm: 'idpf' | 'adobe';
  readonly keyHex: string;
}

export interface EpubBookIndex {
  readonly kind: 'epub';
  readonly opfPath: string;
  readonly entries: readonly ZipEntryIndex[];
  readonly meta: BookMeta;
  readonly toc: readonly TocItem[];
  readonly spine: readonly SectionRef[];
  readonly manifest: Readonly<Record<string, EpubManifestItem>>;
  readonly coverHref: string | null;
  readonly obfuscatedFonts?: Readonly<Record<string, EpubFontObfuscationRule>>;
}

export interface Kf8FragEntry {
  readonly insertPos: number;
  readonly length: number;
  readonly selector?: string;
}

export interface Kf8AnchorTarget {
  readonly id: string;
  /** Byte offset in flow-0 coordinates (`frag[row].insertPos + off`). */
  readonly pos: number;
}

export interface Kf8SectionIndex {
  readonly index: number;
  readonly name: string;
  readonly skelStart: number;
  readonly skelLen: number;
  readonly totalLen: number;
  readonly frags: readonly Kf8FragEntry[];
  readonly linear: boolean;
  readonly targets: readonly Kf8AnchorTarget[];
}

export interface Kf8BookIndex {
  readonly kind: 'kf8';
  readonly meta: BookMeta;
  readonly toc: readonly TocItem[];
  readonly spine: readonly SectionRef[];
  readonly pdbRecordOffsets: readonly number[];
  readonly record0Index: number;
  readonly firstImageRecord: number;
  readonly flows: readonly { readonly start: number; readonly end: number }[];
  readonly sections: readonly Kf8SectionIndex[];
  /** `"fid:off"` (decimal `"row:off"`) -> `{ section, id, approxCharOffset }`. */
  readonly posMap: Readonly<Record<string, { readonly section: number; readonly id: string; readonly approxOffset?: number }>>;
  readonly coverRecordIndex: number | null;
  readonly guide?: readonly { readonly type: string; readonly title: string; readonly posFid?: number; readonly posOff?: number }[];
}

export interface Mobi6SectionIndex {
  readonly index: number;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly anchors: readonly number[];
}

export interface Mobi6BookIndex {
  readonly kind: 'mobi6';
  readonly meta: BookMeta;
  readonly toc: readonly TocItem[];
  readonly spine: readonly SectionRef[];
  readonly encoding: 'utf-8' | 'windows-1252';
  readonly pdbRecordOffsets: readonly number[];
  readonly record0Index: number;
  readonly firstImageRecord: number;
  readonly sections: readonly Mobi6SectionIndex[];
  readonly coverRecordIndex: number | null;
}

export interface Fb2BinaryRange {
  readonly id: string;
  readonly mime: string;
  readonly byteStart: number;
  readonly byteEnd: number;
}

export interface Fb2SectionRange {
  readonly index: number;
  readonly id?: string;
  readonly title?: string;
  readonly linear: boolean;
  readonly isNotes?: boolean;
  readonly sizeHint: number;
}

export interface Fb2BookIndex {
  readonly kind: 'fb2';
  readonly zipped: boolean;
  readonly zipEntry?: ZipEntryIndex;
  readonly encoding: string;
  readonly meta: BookMeta;
  readonly toc: readonly TocItem[];
  readonly spine: readonly SectionRef[];
  readonly sections: readonly Fb2SectionRange[];
  readonly coverBinaryId: string | null;
  readonly binaries: Readonly<Record<string, Fb2BinaryRange>>;
}

export interface TxtChapterIndexEntry {
  readonly index: number;
  readonly title: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly charCount: number;
  readonly hasHeadingLine: boolean;
}

export interface TxtBookIndex {
  readonly kind: 'txt' | 'md';
  readonly encoding: string;
  /** True when UTF-16 or PalmDOC (`TEXtREAd`) was transcoded/decompressed into `text.bin` at import. */
  readonly usesDerivedText?: boolean;
  readonly meta: BookMeta;
  readonly toc: readonly TocItem[];
  readonly spine: readonly SectionRef[];
  readonly chapters: readonly TxtChapterIndexEntry[];
}

export type BookIndex =
  | EpubBookIndex
  | Kf8BookIndex
  | Mobi6BookIndex
  | Fb2BookIndex
  | TxtBookIndex;

export interface BookOpenHint {
  readonly fileName: string;
  /** Optional reader for derived files persisted at import time (`'text.bin'` for MOBI/KF8 or UTF-16/PalmDOC TXT). */
  readonly getDerived?: (name: string) => ByteSource | null;
}

export interface BookInspectHint {
  readonly fileName: string;
  /** Optional streaming writer for derived files (`'text.bin'`, <= 1 MiB chunks). */
  readonly putDerived?: (name: string, chunk: Uint8Array) => Promise<void>;
}

export interface InspectedBook {
  readonly meta: BookMeta;
  readonly cover: CoverImage | null;
  readonly index: BookIndex;
}

export interface BookSession {
  readonly meta: BookMeta;
  readonly toc: readonly TocItem[];
  readonly spine: readonly SectionRef[];
  /**
   * Loads a sanitized section (or a specific virtual render unit `unitIndex` when a section exceeds
   * 40,000 counted characters per `ARCHITECTURE.md` §4.8). Defaults to `unitIndex = 0`.
   */
  loadSection(index: number, unitIndex?: number): Promise<SectionDoc>;
  /** Loads all virtual render units `[0..unitCount-1]` for `index` (1 unit for normal chapters). */
  loadSectionUnits?(index: number): Promise<readonly SectionDoc[]>;
  /** Loads the complete un-split `SectionText` for `index` (for Read Aloud / full-section search). */
  loadSectionText?(index: number): Promise<SectionText>;
  loadResource(href: string): Promise<BookResource>;
  resolveHref(fromSection: number, href: string): ResolvedHref;
  cover(): Promise<CoverImage | null>;
  close(): void;
}

// ---------------------------------------------------------------------------
// §4. Read Aloud (TTS) Contracts: Utterances, SpeechPlayer, Transports (§8)
// ---------------------------------------------------------------------------

export type VoiceQuality = 'compact' | 'enhanced' | 'neural' | 'remote';

export interface Voice {
  readonly id: string;
  /** Android TTS engine package name (e.g. `'com.k2fsa.sherpa.onnx'`, `'org.nobody.multitts'`). */
  readonly engine?: string;
  readonly provider?: 'system' | 'edge' | 'openai';
  readonly name: string;
  readonly lang: string;
  readonly quality: VoiceQuality;
  readonly local: boolean;
}

export interface SystemVoiceRef {
  readonly kind: 'system';
  /** `null` = OS default voice for the utterance's BCP-47 language. */
  readonly voiceId: string | null;
  /** Android TTS engine package name when non-default. */
  readonly engine?: string;
}

export type VoiceRef =
  | SystemVoiceRef
  | { readonly kind: 'edge'; readonly voiceId: string }
  | { readonly kind: 'openai'; readonly voiceId: string; readonly model: string };

export interface WordMark {
  /** UTF-16 code-unit start relative to `Utterance.text` (add `u.start` for section offset). */
  readonly start: number;
  /** UTF-16 code-unit end relative to `Utterance.text`. */
  readonly end: number;
  /** Milliseconds from start of the utterance audio. */
  readonly timeMs: number;
  readonly durationMs?: number;
  readonly word?: string;
}

/**
 * Deterministic sentence unit produced by `segmentSection` (`ARCHITECTURE.md` §8.1).
 * Strict invariant: `u.text === sectionText.text.slice(u.start, u.end)`.
 */
export interface Utterance {
  /** `"<section>:<start>-<end>"` */
  readonly id: string;
  readonly section: number;
  readonly start: number;
  readonly end: number;
  /** Index into `SectionText.blocks` for paragraph-sticky fallback & prev/next paragraph jumps. */
  readonly blockIndex: number;
  readonly text: string;
  readonly lang: string;
  readonly pauseAfterMs: number;
}

export interface SpeechSession {
  readonly bookId: BookId;
  readonly title: string;
  readonly author: string;
  readonly chapterTitle: string;
  readonly coverUrl?: string | null;
  readonly voice: VoiceRef;
  readonly systemFallback: SystemVoiceRef | null;
  readonly rate: number;
}

export type SleepTimerMode = 'off' | 'minutes' | 'endOfSection';

export interface SleepTimerConfig {
  readonly mode: SleepTimerMode;
  readonly minutes?: number;
}

export type SpeechStatus = 'idle' | 'playing' | 'paused' | 'buffering' | 'ended-of-buffer';

export interface SpeechState {
  readonly status: SpeechStatus;
  readonly bookId: BookId | null;
  readonly currentUtteranceId: string | null;
  readonly section: number | null;
  readonly offset: number | null;
  readonly rate: number;
  readonly voice: VoiceRef | null;
  readonly usingFallback: boolean;
  readonly sleepTimer: {
    readonly mode: SleepTimerMode;
    readonly remainingMs?: number;
  };
}

export interface AttachedAudio {
  readonly ref: string;
  readonly durationMs?: number;
  readonly marks?: readonly WordMark[];
}

export type SpeechEvent =
  | { readonly type: 'speech-state'; readonly state: SpeechState }
  | {
      readonly type: 'utterance-start';
      readonly id: string;
      readonly section: number;
      readonly start: number;
      readonly end: number;
      readonly usingFallback?: boolean;
    }
  | {
      readonly type: 'utterance-word';
      readonly id: string;
      readonly start: number;
      readonly end: number;
      readonly timeMs?: number;
    }
  | { readonly type: 'utterance-done'; readonly id: string }
  | { readonly type: 'queue-low'; readonly remaining: number }
  | { readonly type: 'speech-fallback'; readonly reason: string; readonly utteranceId?: string }
  | { readonly type: 'speech-ended'; readonly reason: 'completed' | 'end-of-buffer' | 'stopped' | 'sleep-timer' }
  | { readonly type: 'sleep-timer'; readonly mode: SleepTimerMode; readonly remainingMs?: number; readonly expired?: boolean }
  | { readonly type: 'speech-error'; readonly error: MiniBookErrorShape };

export interface SpeechPlayer {
  readonly capabilities: {
    readonly nativeQueue: boolean;
    readonly wordEvents: boolean;
  };
  listVoices(): Promise<Voice[]>;
  load(session: SpeechSession): Promise<void>;
  enqueue(items: readonly Utterance[], opts?: { readonly replaceFromId?: string }): void;
  attachAudio(id: string, audio: AttachedAudio): void;
  play(): void;
  pause(): void;
  stop(): void;
  seekTo(id: string): void;
  setRate(rate: number): void;
  setVoice(voice: VoiceRef): void;
  setSleepTimer(timer: SleepTimerConfig): void;
  getState(): Promise<SpeechState>;
  subscribe(listener: (event: SpeechEvent) => void): Unsubscribe;
}

export interface SynthRequest {
  readonly engine: 'edge' | 'openai';
  readonly voiceId: string;
  readonly model?: string;
  readonly text: string;
  readonly lang: string;
  readonly baseUrl?: string;
}

export interface SynthResult {
  readonly ref: string;
  readonly mime: string;
  readonly durationMs?: number;
  readonly marks?: readonly WordMark[];
  readonly synthMs: number;
  readonly bytes: number;
  readonly cached?: boolean;
}

// --- Injected Transports for platform-neutral speech providers (§8.4) ---

export interface TransportHttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface TransportHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export type HttpTransport = (req: TransportHttpRequest) => Promise<TransportHttpResponse>;

export type SocketMessage =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'binary'; readonly bytes: Uint8Array };

export interface SocketConnection {
  sendText(text: string): void;
  sendBinary(bytes: Uint8Array): void;
  close(code?: number): void;
}

export interface SocketHandlers {
  onOpen?(): void;
  onMessage(msg: SocketMessage): void;
  onClose(info: { readonly code: number; readonly reason?: string }): void;
  onError?(err: unknown): void;
}

export interface SocketOpenOptions {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type SocketTransport = (opts: SocketOpenOptions, handlers: SocketHandlers) => Promise<SocketConnection>;

// ---------------------------------------------------------------------------
// §5. AppSettings, PlatformHost & Host Sub-APIs (§3, §7, §8, §9, UI_SPEC.md)
// ---------------------------------------------------------------------------

/** Four canonical Apple Books reading themes (`UI_SPEC.md` §2.1). */
export type ReadingTheme = 'original' | 'paper' | 'calm' | 'quiet';

export type BookFontFamily = 'original' | 'serif' | 'sans';

export type LineSpacingPreset = 'tight' | 'normal' | 'loose';

export type MarginPreset = 'narrow' | 'medium' | 'wide';

export type EinkModeSetting = 'auto' | 'on' | 'off';

export type FullRefreshCadence = 0 | 5 | 10 | 20;

export type TextBoldnessStep = 0 | 1 | 2 | 3;

export type BarePageCaptionMode = 'pages-left' | 'percent' | 'hidden';

/** 12 discrete text-size steps from 80% to 200% (`UI_SPEC.md` §3.3). */
export const FONT_SCALE_STEPS = [80, 90, 95, 100, 105, 110, 120, 135, 150, 165, 180, 200] as const;

export type FontScalePercent = (typeof FONT_SCALE_STEPS)[number];

export interface CustomSpeechServerConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly voice: string;
}

export interface AppSettings {
  // Appearance (`UI_SPEC.md` §4.4)
  readonly theme: ReadingTheme;
  readonly matchSystemTheme: boolean;
  readonly fontFamily: BookFontFamily;
  readonly fontScale: number;
  readonly lineSpacing: LineSpacingPreset;
  readonly margins: MarginPreset;
  readonly justify: boolean;
  readonly captionMode: BarePageCaptionMode;

  // Reading & E-Ink (`PRODUCT_DESIGN.md` §4.7, §8)
  readonly einkMode: EinkModeSetting;
  readonly einkAutoNoticeShown?: boolean;
  /** Explicit user choice for Android volume-key paging; when `null`, defaults to `true` in E-Ink mode and `false` otherwise (`§8.5`). */
  readonly volumeKeyPaging: boolean | null;
  readonly fullRefreshEvery: FullRefreshCadence;
  readonly textBoldness: TextBoldnessStep;
  readonly keepScreenOn: boolean;

  // Read Aloud (`PRODUCT_DESIGN.md` §4.7)
  readonly speechRate: number;
  /** Per-language voice preference keyed by primary subtag (`'en'`, `'zh'`, `'ja'`, `'default'`). */
  readonly preferredVoices: Readonly<Record<string, VoiceRef>>;
  readonly edgeVoicesEnabled: boolean;
  readonly customSpeechServer: CustomSpeechServerConfig | null;
  readonly fallbackToSystemVoice: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'original',
  matchSystemTheme: true,
  fontFamily: 'serif',
  fontScale: 100,
  lineSpacing: 'normal',
  margins: 'medium',
  justify: true,
  captionMode: 'pages-left',
  einkMode: 'auto',
  einkAutoNoticeShown: false,
  volumeKeyPaging: null,
  fullRefreshEvery: 10,
  textBoldness: 1,
  keepScreenOn: true,
  speechRate: 1.0,
  preferredVoices: {},
  edgeVoicesEnabled: false,
  customSpeechServer: null,
  fallbackToSystemVoice: true,
};

export type HostPlatform = 'desktop' | 'android' | 'ios';

export interface HostCapabilities {
  readonly nativeSpeechQueue: boolean;
  readonly volumeKeyPaging: boolean;
  readonly vendorRefresh: boolean;
  readonly einkDetected: boolean;
  readonly filePicker: boolean;
  readonly openWith: boolean;
}

export interface DeviceInfo {
  readonly eink: boolean;
  readonly vendor: string | null;
  readonly model: string | null;
  readonly refresh: 'vendor' | 'software';
}

export interface HostInfo {
  readonly platform: HostPlatform;
  readonly appVersion: string;
  readonly capabilities: HostCapabilities;
  readonly device: DeviceInfo;
}

export interface LibraryBook {
  readonly id: BookId;
  readonly title: string;
  readonly authors: readonly string[];
  readonly language: string | null;
  readonly format: BookFormat;
  readonly fileName: string;
  readonly size: number;
  readonly hasCover: boolean;
  readonly coverMime?: string | null;
  readonly addedAt: EpochMs;
  readonly openedAt: EpochMs | null;
  readonly finished: boolean;
  readonly fraction: number;
}

export interface LibraryBookDetail extends LibraryBook {
  readonly index: BookIndex;
}

export interface ImportSource {
  readonly name: string;
  readonly size: number;
  readonly bytes: ByteSource;
  readonly sourceRef?: string;
}

export interface ImportTicket {
  readonly ticketId: string;
  readonly bookId?: BookId;
  putDerived(name: string, chunk: Uint8Array): Promise<void>;
  abort(): Promise<void>;
}

export interface LibraryApi {
  list(): Promise<LibraryBook[]>;
  get(id: BookId): Promise<LibraryBookDetail | null>;
  beginImport(src: ImportSource): Promise<ImportTicket>;
  commitImport(ticket: ImportTicket, inspected: InspectedBook): Promise<LibraryBook>;
  remove(id: BookId): Promise<void>;
  setFinished(id: BookId, finished: boolean): Promise<void>;
  markOpened?(id: BookId, openedAt?: EpochMs): Promise<void>;
  coverUrl(id: BookId): string | null;
}

export interface FilesApi {
  pickBooks(): Promise<ImportSource[]>;
  /** Returns bounded `ByteSource` for `'book'` (default) or derived `'text'` (`text.bin` for MOBI/KF8). */
  byteSource(bookId: BookId, part?: 'book' | 'text'): ByteSource;
  openExternal(url: string): Promise<void>;
}

export interface StateApi {
  getPosition(bookId: BookId): Promise<SavedPosition | null>;
  savePosition(bookId: BookId, pos: SavedPosition): Promise<void>;
  listBookmarks(bookId: BookId): Promise<Bookmark[]>;
  addBookmark(bookId: BookId, bookmark: BookmarkInput): Promise<Bookmark>;
  removeBookmark(bookId: BookId, bookmarkId: string): Promise<void>;
}

export interface StorageUsage {
  readonly booksBytes: number;
  readonly speechCacheBytes: number;
}

export interface SettingsApi {
  get(): Promise<AppSettings>;
  update(patch: Partial<AppSettings>): Promise<AppSettings>;
  setSecret(name: string, value: string | null): Promise<void>;
  hasSecret(name: string): Promise<boolean>;
  storageUsage?(): Promise<StorageUsage>;
}

export interface SpeechHostApi {
  synthesize(req: SynthRequest, signal?: AbortSignal): Promise<SynthResult>;
  listRemoteVoices(engine: 'edge' | 'openai'): Promise<Voice[]>;
  clearCache(): Promise<void>;
  cacheSize(): Promise<number>;
}

export interface KeyPolicy {
  readonly volumePaging: boolean;
}

export type HardwareKey = 'volume-up' | 'volume-down' | 'page-up' | 'page-down';

export interface DeviceApi {
  setImmersive(enabled: boolean): Promise<void>;
  setKeepScreenOn(enabled: boolean): Promise<void>;
  fullRefresh(): Promise<boolean>;
  setKeyPolicy(policy: KeyPolicy): Promise<void>;
}

export interface IncomingFileDescriptor {
  readonly tempPath?: string;
  readonly name: string;
  readonly size: number;
}

export type HostEvent =
  | { readonly type: 'library-changed'; readonly bookId?: BookId }
  | { readonly type: 'import-progress'; readonly completed: number; readonly total: number; readonly currentName?: string }
  | { readonly type: 'hardware-key'; readonly key: HardwareKey }
  | { readonly type: 'incoming-file'; readonly files: readonly IncomingFileDescriptor[] }
  | { readonly type: 'device-changed'; readonly device: DeviceInfo };

export interface PlatformHost {
  readonly info: HostInfo;
  readonly library: LibraryApi;
  readonly files: FilesApi;
  readonly state: StateApi;
  readonly settings: SettingsApi;
  readonly speech: SpeechHostApi;
  readonly device: DeviceApi;
  subscribe(listener: (event: HostEvent) => void): Unsubscribe;
}
