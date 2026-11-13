/**
 * Authoritative TypeScript contract for `@CapacitorPlugin(name = "MiniBook")`
 * (`ARCHITECTURE.md` §3.2, §3.3, §8.5–§8.6, §9).
 *
 * Shared 1-to-1 across:
 *   1. `@minibook/host-android` (`MiniBookPlugin.java`)
 *   2. iOS Google3 host (`//experimental/users/chii/ios/minibook` `MiniBookPlugin.swift`)
 *
 * Capacitor's native bridge dispatches flat method names (`MiniBookNativeBridge`: `fsRead`,
 * `fsWriteAtomic`, `speechEnqueue`, `deviceFullRefresh`, …) and resolves JSON objects (`JSObject` /
 * `[String: Any]`). `wrapNativeBridge()` adapts that flat Capacitor surface into the structured
 * `MiniBookPlugin` (`fs.*`, `import.*`, `http.*`, `socket.*`, `speech.*`, `device.*`, `secrets.*`)
 * described in `ARCHITECTURE.md` §3.2.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type {
  DeviceInfo,
  EpochMs,
  HardwareKey,
  KeyPolicy,
  SleepTimerConfig,
  SpeechSession,
  SpeechState,
  Utterance,
  Voice,
  VoiceRef,
  WordMark,
} from '@minibook/core';

// ---------------------------------------------------------------------------
// §1. Filesystem (`fs.*`) — bounded random access & atomic persistence
// ---------------------------------------------------------------------------

export interface NativeFsReadRequest {
  /** Path relative to `MiniBookData/` (e.g. `'books/b_123/book.epub'` or `'tmp/pick_1.azw3'`). */
  readonly path: string;
  /** Non-negative byte offset (`Number.longValue()` in Java, `UInt64` in Swift). */
  readonly offset: number;
  /** Bounded byte count (`0 < length <= 1_048_576` = 1 MiB). */
  readonly length: number;
}

export interface NativeFsReadResponse {
  readonly base64: string;
  readonly bytesRead: number;
}

export interface NativeFsWriteAtomicRequest {
  readonly path: string;
  /** Exactly one of `text` (UTF-8) or `base64` (raw bytes) must be supplied. */
  readonly text?: string;
  readonly base64?: string;
}

export interface NativeFsAppendRequest {
  readonly path: string;
  readonly base64: string;
}

export interface NativeFsEntry {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: EpochMs;
  readonly isDirectory: boolean;
}

export interface NativeFsStatResponse {
  readonly exists: boolean;
  readonly size?: number;
  readonly mtimeMs?: EpochMs;
  readonly isDirectory?: boolean;
}

// ---------------------------------------------------------------------------
// §2. Import (`import.*`) — SAF / UIDocumentPicker copy-on-import & Open-With
// ---------------------------------------------------------------------------

export interface NativePickedFile {
  /** Staged path inside `MiniBookData/tmp/` (content URI is already copied natively). */
  readonly tempPath: string;
  readonly name: string;
  readonly size: number;
}

export interface NativeAdoptRequest {
  readonly tempPath: string;
  readonly bookId: string;
  /** Canonical extension without leading dot (e.g. `'epub'`, `'azw3'`, `'mobi'`, `'fb2'`, `'txt'`, `'md'`). */
  readonly ext: string;
}

export interface NativeAdoptResponse {
  /** Adopted relative path, e.g. `'books/<bookId>/book.<ext>'`. */
  readonly path: string;
  readonly size: number;
}

// ---------------------------------------------------------------------------
// §3. Network (`http.*` & `socket.*`) — CORS-free speech transports + secrets
// ---------------------------------------------------------------------------

export interface NativeHttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  /** Header values may contain `{{secret:<name>}}`, substituted natively before send. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly bodyBase64?: string;
  readonly timeoutMs?: number;
}

export interface NativeHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyBase64: string;
}

export interface NativeSocketOpenRequest {
  readonly id: string;
  readonly url: string;
  /** Caller-supplied WebSocket handshake headers (e.g. `Origin`, `User-Agent` for Edge TTS). */
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface NativeSocketSendRequest {
  readonly id: string;
  readonly text?: string;
  readonly base64?: string;
}

export interface NativeSocketCloseRequest {
  readonly id: string;
  readonly code?: number;
}

// ---------------------------------------------------------------------------
// §4. Speech (`speech.*`) — Native queue, MediaSession / NowPlaying, Journal
// ---------------------------------------------------------------------------

export interface NativeSpeechEnqueueRequest {
  readonly items: readonly Utterance[];
  readonly replaceFromId?: string;
}

export interface NativeSpeechAttachAudioRequest {
  readonly id: string;
  /** Native file path returned by `speech.cachePut`. */
  readonly path: string;
  readonly durationMs?: number;
  readonly marks?: readonly WordMark[];
}

export interface SpeechJournalCheckpoint {
  readonly bookId: string;
  readonly section: number;
  readonly offset: number;
  readonly utteranceId?: string;
  readonly wallMs: EpochMs;
}

export interface NativeSpeechCachePutRequest {
  readonly key: string;
  readonly base64: string;
  /** File extension (`'mp3'` | `'wav'`), default `'mp3'`. */
  readonly ext?: string;
}

export interface NativeSpeechCachePutResponse {
  readonly path: string;
  readonly bytes: number;
}

// ---------------------------------------------------------------------------
// §5. Native Event Payloads (`MiniBookPluginEventMap`)
// ---------------------------------------------------------------------------

export interface MiniBookPluginEventMap {
  readonly 'incoming-file': {
    readonly files: readonly NativePickedFile[];
  };
  readonly 'socket-open': {
    readonly id: string;
  };
  readonly 'socket-message': {
    readonly id: string;
    readonly text?: string;
    readonly base64?: string;
  };
  readonly 'socket-close': {
    readonly id: string;
    readonly code: number;
    readonly reason?: string;
  };
  readonly 'socket-error': {
    readonly id: string;
    readonly message: string;
  };
  readonly 'speech-state': SpeechState;
  readonly 'utterance-start': {
    readonly id: string;
    readonly section: number;
    readonly start: number;
    readonly end: number;
    readonly usingFallback?: boolean;
  };
  readonly 'utterance-word': {
    readonly id: string;
    readonly start: number;
    readonly end: number;
    readonly timeMs?: number;
  };
  readonly 'utterance-done': {
    readonly id: string;
  };
  readonly 'queue-low': {
    readonly remaining: number;
  };
  readonly 'speech-fallback': {
    readonly reason: string;
    readonly utteranceId?: string;
  };
  readonly 'speech-ended': {
    readonly reason: 'completed' | 'end-of-buffer' | 'stopped' | 'sleep-timer';
  };
  readonly 'sleep-timer': {
    readonly mode: SleepTimerConfig['mode'];
    readonly remainingMs?: number;
    readonly expired?: boolean;
  };
  readonly 'hardware-key': {
    readonly key: HardwareKey;
  };
}

// ---------------------------------------------------------------------------
// §6. Structured `MiniBookPlugin` API (`ARCHITECTURE.md` §3.2)
// ---------------------------------------------------------------------------

export interface MiniBookPlugin {
  readonly fs: {
    read(opts: NativeFsReadRequest): Promise<NativeFsReadResponse>;
    writeAtomic(opts: NativeFsWriteAtomicRequest): Promise<void>;
    append(opts: NativeFsAppendRequest): Promise<void>;
    list(opts: { readonly path: string }): Promise<readonly NativeFsEntry[]>;
    remove(opts: { readonly path: string }): Promise<void>;
    stat(opts: { readonly path: string }): Promise<NativeFsStatResponse>;
    fileUrl(opts: { readonly path: string }): Promise<{ readonly url: string }>;
  };

  readonly import: {
    pick(opts?: { readonly multiple?: boolean }): Promise<readonly NativePickedFile[]>;
    adopt(opts: NativeAdoptRequest): Promise<NativeAdoptResponse>;
    consumePending(): Promise<readonly NativePickedFile[]>;
  };

  readonly http: {
    request(opts: NativeHttpRequest): Promise<NativeHttpResponse>;
  };

  readonly socket: {
    open(opts: NativeSocketOpenRequest): Promise<void>;
    send(opts: NativeSocketSendRequest): Promise<void>;
    close(opts: NativeSocketCloseRequest): Promise<void>;
  };

  readonly speech: {
    voices(): Promise<readonly Voice[]>;
    load(session: SpeechSession): Promise<void>;
    enqueue(opts: NativeSpeechEnqueueRequest): Promise<void>;
    attachAudio(opts: NativeSpeechAttachAudioRequest): Promise<void>;
    play(): Promise<void>;
    pause(): Promise<void>;
    stop(): Promise<void>;
    seekTo(opts: { readonly id: string }): Promise<void>;
    setRate(opts: { readonly rate: number }): Promise<void>;
    setVoice(opts: { readonly voice: VoiceRef }): Promise<void>;
    setSleepTimer(opts: SleepTimerConfig): Promise<void>;
    getState(): Promise<SpeechState>;
    readJournal(): Promise<SpeechJournalCheckpoint | null>;
    cachePut(opts: NativeSpeechCachePutRequest): Promise<NativeSpeechCachePutResponse>;
    cacheClear(): Promise<void>;
    cacheSize(): Promise<number>;
  };

  readonly device: {
    info(): Promise<DeviceInfo>;
    setImmersive(opts: { readonly enabled: boolean }): Promise<void>;
    setKeepScreenOn(opts: { readonly enabled: boolean }): Promise<void>;
    fullRefresh(): Promise<{ readonly done: boolean }>;
    setKeyPolicy(opts: KeyPolicy): Promise<void>;
  };

  readonly secrets: {
    set(opts: { readonly name: string; readonly value: string | null }): Promise<void>;
    has(opts: { readonly name: string }): Promise<boolean>;
    remove(opts: { readonly name: string }): Promise<void>;
  };

  openExternal(opts: { readonly url: string }): Promise<void>;

  addListener<K extends keyof MiniBookPluginEventMap>(
    eventName: K,
    listener: (payload: MiniBookPluginEventMap[K]) => void,
  ): Promise<PluginListenerHandle>;
}

// ---------------------------------------------------------------------------
// §7. Flat Capacitor Native Bridge (`@CapacitorPlugin(name = "MiniBook")`)
//     Exact method names implemented by `MiniBookPlugin.java` & `MiniBookPlugin.swift`
// ---------------------------------------------------------------------------

export interface MiniBookNativeBridge {
  // fs
  fsRead(opts: NativeFsReadRequest): Promise<NativeFsReadResponse>;
  fsWriteAtomic(opts: NativeFsWriteAtomicRequest): Promise<void>;
  fsAppend(opts: NativeFsAppendRequest): Promise<void>;
  fsList(opts: { path: string }): Promise<{ entries: NativeFsEntry[] }>;
  fsRemove(opts: { path: string }): Promise<void>;
  fsStat(opts: { path: string }): Promise<NativeFsStatResponse>;
  fsFileUrl(opts: { path: string }): Promise<{ url: string }>;

  // import
  importPick(opts: { multiple: boolean }): Promise<{ files: NativePickedFile[] }>;
  importAdopt(opts: NativeAdoptRequest): Promise<NativeAdoptResponse>;
  importConsumePending(): Promise<{ files: NativePickedFile[] }>;

  // http & socket
  httpRequest(opts: NativeHttpRequest): Promise<NativeHttpResponse>;
  socketOpen(opts: NativeSocketOpenRequest): Promise<void>;
  socketSend(opts: NativeSocketSendRequest): Promise<void>;
  socketClose(opts: NativeSocketCloseRequest): Promise<void>;

  // speech
  speechVoices(): Promise<{ voices: Voice[] }>;
  speechLoad(session: SpeechSession): Promise<void>;
  speechEnqueue(opts: NativeSpeechEnqueueRequest): Promise<void>;
  speechAttachAudio(opts: NativeSpeechAttachAudioRequest): Promise<void>;
  speechPlay(): Promise<void>;
  speechPause(): Promise<void>;
  speechStop(): Promise<void>;
  speechSeekTo(opts: { id: string }): Promise<void>;
  speechSetRate(opts: { rate: number }): Promise<void>;
  speechSetVoice(opts: { voice: VoiceRef }): Promise<void>;
  speechSetSleepTimer(opts: SleepTimerConfig): Promise<void>;
  speechGetState(): Promise<SpeechState>;
  speechReadJournal(): Promise<{ checkpoint: SpeechJournalCheckpoint | null }>;
  speechCachePut(opts: NativeSpeechCachePutRequest): Promise<NativeSpeechCachePutResponse>;
  speechCacheClear(): Promise<void>;
  speechCacheSize(): Promise<{ bytes: number }>;

  // device
  deviceInfo(): Promise<DeviceInfo>;
  deviceSetImmersive(opts: { enabled: boolean }): Promise<void>;
  deviceSetKeepScreenOn(opts: { enabled: boolean }): Promise<void>;
  deviceFullRefresh(): Promise<{ done: boolean }>;
  deviceSetKeyPolicy(opts: KeyPolicy): Promise<void>;

  // secrets
  secretsSet(opts: { name: string; value: string | null }): Promise<void>;
  secretsHas(opts: { name: string }): Promise<{ exists: boolean }>;
  secretsRemove(opts: { name: string }): Promise<void>;

  // external URL
  openExternal(opts: { url: string }): Promise<void>;

  // events
  addListener<K extends keyof MiniBookPluginEventMap>(
    eventName: K,
    listenerFunc: (payload: MiniBookPluginEventMap[K]) => void,
  ): Promise<PluginListenerHandle>;
}

const RawMiniBookBridge = registerPlugin<MiniBookNativeBridge>('MiniBook');

export function wrapNativeBridge(bridge: MiniBookNativeBridge): MiniBookPlugin {
  return {
    fs: {
      read: (opts) => bridge.fsRead(opts),
      writeAtomic: (opts) => bridge.fsWriteAtomic(opts),
      append: (opts) => bridge.fsAppend(opts),
      async list(opts) {
        const res = await bridge.fsList(opts);
        return Array.isArray(res?.entries) ? res.entries : [];
      },
      remove: (opts) => bridge.fsRemove(opts),
      stat: (opts) => bridge.fsStat(opts),
      fileUrl: (opts) => bridge.fsFileUrl(opts),
    },
    import: {
      async pick(opts) {
        const res = await bridge.importPick({ multiple: opts?.multiple ?? true });
        return Array.isArray(res?.files) ? res.files : [];
      },
      adopt: (opts) => bridge.importAdopt(opts),
      async consumePending() {
        const res = await bridge.importConsumePending();
        return Array.isArray(res?.files) ? res.files : [];
      },
    },
    http: {
      request: (opts) => bridge.httpRequest(opts),
    },
    socket: {
      open: (opts) => bridge.socketOpen(opts),
      send: (opts) => bridge.socketSend(opts),
      close: (opts) => bridge.socketClose(opts),
    },
    speech: {
      async voices() {
        const res = await bridge.speechVoices();
        return Array.isArray(res?.voices) ? res.voices : [];
      },
      load: (session) => bridge.speechLoad(session),
      enqueue: (opts) => bridge.speechEnqueue(opts),
      attachAudio: (opts) => bridge.speechAttachAudio(opts),
      play: () => bridge.speechPlay(),
      pause: () => bridge.speechPause(),
      stop: () => bridge.speechStop(),
      seekTo: (opts) => bridge.speechSeekTo(opts),
      setRate: (opts) => bridge.speechSetRate(opts),
      setVoice: (opts) => bridge.speechSetVoice(opts),
      setSleepTimer: (opts) => bridge.speechSetSleepTimer(opts),
      getState: () => bridge.speechGetState(),
      async readJournal() {
        const res = await bridge.speechReadJournal();
        return res?.checkpoint ?? null;
      },
      cachePut: (opts) => bridge.speechCachePut(opts),
      cacheClear: () => bridge.speechCacheClear(),
      async cacheSize() {
        const res = await bridge.speechCacheSize();
        return typeof res?.bytes === 'number' ? res.bytes : 0;
      },
    },
    device: {
      info: () => bridge.deviceInfo(),
      setImmersive: (opts) => bridge.deviceSetImmersive(opts),
      setKeepScreenOn: (opts) => bridge.deviceSetKeepScreenOn(opts),
      fullRefresh: () => bridge.deviceFullRefresh(),
      setKeyPolicy: (opts) => bridge.deviceSetKeyPolicy(opts),
    },
    secrets: {
      set: (opts) => bridge.secretsSet(opts),
      async has(opts) {
        const res = await bridge.secretsHas(opts);
        return Boolean(res?.exists);
      },
      remove: (opts) => bridge.secretsRemove(opts),
    },
    openExternal: (opts) => bridge.openExternal(opts),
    addListener: (eventName, listener) => bridge.addListener(eventName, listener),
  };
}

export function createDefaultMiniBookPlugin(): MiniBookPlugin {
  return wrapNativeBridge(RawMiniBookBridge);
}
