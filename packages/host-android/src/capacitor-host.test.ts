import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  KOKORO_MODEL_ID,
  WindowedByteSource,
  encodeMonoPcm16Wav,
  memoryByteSource,
  openBook,
  sanitizeReadableBookFileName,
  type HostEvent,
  type InspectedBook,
  type SpeechEvent,
  type TxtBookIndex,
  type UiLanguage,
} from '@minibook/core';
import { createCapacitorPlatformHost } from './capacitor-host.js';
import {
  wrapNativeBridge,
  type MiniBookNativeBridge,
  type MiniBookPluginEventMap,
  type NativeFsEntry,
  type NativePickedFile,
  type SpeechJournalCheckpoint,
} from './plugin-types.js';
import { NativeSpeechPlayer } from './speech/NativeSpeechPlayer.js';
import { createPluginHttpTransport, createPluginSocketTransport } from './speech/plugin-transports.js';
import { PLUGIN_MAX_READ_BYTES, PluginByteSource } from './storage/PluginByteSource.js';
import { base64ToBytes, bytesToBase64 } from './storage/base64.js';

class InMemoryNativeBridge implements MiniBookNativeBridge {
  readonly files = new Map<string, Uint8Array>();
  readonly mtimes = new Map<string, number>();
  readonly secrets = new Map<string, string>();
  readonly speechCache = new Map<string, Uint8Array>();
  readonly pendingImports: NativePickedFile[] = [];
  readonly pickedFiles: NativePickedFile[] = [];
  readonly fsReadCalls: Array<{ path: string; offset: number; length: number }> = [];
  readonly sharedFiles: Array<{ path: string; title?: string; mimeType?: string }> = [];
  readonly speechLog: string[] = [];
  keepScreenOnCalls: boolean[] = [];
  immersiveCalls: boolean[] = [];
  keyPolicyCalls: boolean[] = [];
  uiLanguageCalls: UiLanguage[] = [];
  einkDevice = {
    eink: false,
    vendor: null as string | null,
    model: 'Pixel 9' as string | null,
    refresh: 'software' as 'vendor' | 'software',
  };
  journalCheckpoint: SpeechJournalCheckpoint | null = null;
  lastHttpHeaders: Record<string, string> = {};
  lastHttpUrl = '';
  lastModelDownloadSources: readonly string[] = [];
  httpStatusOverride = 200;
  httpBodyOverride: Uint8Array | null = null;
  httpContentTypeOverride = 'audio/mpeg';

  private readonly eventListeners = new Map<string, Set<(payload: unknown) => void>>();

  emitEvent<K extends keyof MiniBookPluginEventMap>(
    name: K,
    payload: MiniBookPluginEventMap[K],
  ): void {
    const set = this.eventListeners.get(name);
    if (!set) return;
    for (const fn of set) {
      fn(payload);
    }
  }

  private normalize(p: string): string {
    return p.replace(/^\/+/, '').replace(/\/+$/, '');
  }

  async fsRead(opts: { path: string; offset: number; length: number }) {
    if (opts.length <= 0 || opts.length > PLUGIN_MAX_READ_BYTES || opts.offset < 0) {
      throw new Error(`Invalid bounded read: offset=${opts.offset} length=${opts.length}`);
    }
    const p = this.normalize(opts.path);
    this.fsReadCalls.push({ path: p, offset: opts.offset, length: opts.length });
    const data = this.files.get(p);
    if (!data) throw new Error(`File not found: ${p}`);
    if (opts.offset >= data.byteLength) {
      return { base64: '', bytesRead: 0 };
    }
    const slice = data.subarray(opts.offset, Math.min(data.byteLength, opts.offset + opts.length));
    return { base64: bytesToBase64(slice), bytesRead: slice.byteLength };
  }

  async fsWriteAtomic(opts: { path: string; text?: string; base64?: string }) {
    const p = this.normalize(opts.path);
    const bytes =
      opts.text !== undefined
        ? new TextEncoder().encode(opts.text)
        : base64ToBytes(opts.base64 ?? '');
    this.files.set(p, bytes);
    this.mtimes.set(p, Date.now());
  }

  async fsAppend(opts: { path: string; base64: string }) {
    const p = this.normalize(opts.path);
    const chunk = base64ToBytes(opts.base64);
    const prev = this.files.get(p);
    if (!prev) {
      this.files.set(p, chunk);
    } else {
      const combined = new Uint8Array(prev.byteLength + chunk.byteLength);
      combined.set(prev, 0);
      combined.set(chunk, prev.byteLength);
      this.files.set(p, combined);
    }
    this.mtimes.set(p, Date.now());
  }

  async fsList(opts: { path: string }): Promise<{ entries: NativeFsEntry[] }> {
    const prefix = this.normalize(opts.path);
    const dirPrefix = prefix ? `${prefix}/` : '';
    const seenDirs = new Set<string>();
    const entries: NativeFsEntry[] = [];

    for (const [fullPath, bytes] of this.files.entries()) {
      if (dirPrefix && !fullPath.startsWith(dirPrefix)) continue;
      const rest = dirPrefix ? fullPath.slice(dirPrefix.length) : fullPath;
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({
          name: rest,
          path: fullPath,
          size: bytes.byteLength,
          mtimeMs: this.mtimes.get(fullPath) ?? 0,
          isDirectory: false,
        });
      } else {
        const dirName = rest.slice(0, slash);
        if (!seenDirs.has(dirName)) {
          seenDirs.add(dirName);
          entries.push({
            name: dirName,
            path: dirPrefix ? `${dirPrefix}${dirName}` : dirName,
            size: 0,
            mtimeMs: 0,
            isDirectory: true,
          });
        }
      }
    }
    return { entries };
  }

  async fsRemove(opts: { path: string }) {
    const p = this.normalize(opts.path);
    this.files.delete(p);
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(`${p}/`)) {
        this.files.delete(key);
      }
    }
  }

  async fsStat(opts: { path: string }) {
    const p = this.normalize(opts.path);
    const exact = this.files.get(p);
    if (exact) {
      return {
        exists: true,
        size: exact.byteLength,
        mtimeMs: this.mtimes.get(p) ?? 0,
        isDirectory: false,
      };
    }
    for (const k of this.files.keys()) {
      if (k.startsWith(`${p}/`)) {
        return { exists: true, size: 0, mtimeMs: 0, isDirectory: true };
      }
    }
    return { exists: false };
  }

  async fsFileUrl(opts: { path: string }) {
    return { url: `https://localhost/_capacitor_file_/MiniBookData/${this.normalize(opts.path)}` };
  }

  async fsShare(opts: { path: string; title?: string; mimeType?: string }) {
    const p = this.normalize(opts.path);
    if (!this.files.has(p)) throw new Error(`File not found: ${p}`);
    this.sharedFiles.push({
      path: p,
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.mimeType !== undefined ? { mimeType: opts.mimeType } : {}),
    });
  }

  async importPick(_opts: { multiple: boolean }) {
    return { files: [...this.pickedFiles] };
  }

  async importAdopt(opts: {
    tempPath: string;
    bookId: string;
    ext: string;
    preferredName?: string;
  }) {
    const src = this.normalize(opts.tempPath);
    const bytes = this.files.get(src);
    if (!bytes) throw new Error(`Missing staged file: ${src}`);
    if (src.startsWith('userbooks/')) {
      return { path: src, size: bytes.byteLength };
    }
    const baseName = sanitizeReadableBookFileName(opts.preferredName || opts.bookId, opts.ext);
    const suffix = `.${opts.ext}`;
    const stem = baseName.endsWith(suffix)
      ? baseName.slice(0, baseName.length - suffix.length)
      : baseName;
    let dest = `userbooks/${baseName}`;
    let counter = 2;
    while (this.files.has(dest) && dest !== src) {
      const existing = this.files.get(dest)!;
      if (
        existing.byteLength === bytes.byteLength &&
        existing.every((b, idx) => b === bytes[idx])
      ) {
        break;
      }
      dest = `userbooks/${stem} (${counter})${suffix}`;
      counter += 1;
    }
    this.files.set(dest, bytes);
    if (dest !== src) {
      this.files.delete(src);
    }
    return { path: dest, size: bytes.byteLength };
  }

  async importConsumePending() {
    const out = this.pendingImports.splice(0, this.pendingImports.length);
    return { files: out };
  }

  async httpRequest(opts: {
    url: string;
    method: 'GET' | 'POST';
    headers?: Readonly<Record<string, string>>;
    bodyBase64?: string;
  }) {
    const resolvedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      resolvedHeaders[k] = v.replace(/\{\{secret:([^}]+)\}\}/g, (_m, sName: string) => {
        return this.secrets.get(sName) ?? '';
      });
    }
    this.lastHttpHeaders = resolvedHeaders;
    this.lastHttpUrl = opts.url;
    return {
      status: this.httpStatusOverride,
      headers: { 'content-type': this.httpContentTypeOverride },
      bodyBase64: bytesToBase64(this.httpBodyOverride ?? new Uint8Array([0xff, 0xfb, 0x90, 0x64])),
    };
  }

  async socketOpen(opts: { id: string; url: string }) {
    queueMicrotask(() => {
      this.emitEvent('socket-open', { id: opts.id });
    });
  }

  async socketSend(opts: { id: string; text?: string; base64?: string }) {
    queueMicrotask(() => {
      if (opts.text) {
        this.emitEvent('socket-message', { id: opts.id, text: `echo:${opts.text}` });
      } else if (opts.base64) {
        this.emitEvent('socket-message', { id: opts.id, base64: opts.base64 });
      }
    });
  }

  async socketClose(opts: { id: string; code?: number }) {
    queueMicrotask(() => {
      this.emitEvent('socket-close', { id: opts.id, code: opts.code ?? 1000 });
    });
  }

  async speechVoices() {
    return {
      voices: [
        {
          id: 'zh-cn-kokoro',
          engine: 'com.k2fsa.sherpa.onnx',
          provider: 'system' as const,
          name: 'Kokoro Chinese',
          lang: 'zh-CN',
          quality: 'neural' as const,
          local: true,
        },
      ],
    };
  }

  async speechLoad() {
    this.speechLog.push('load');
  }
  async speechEnqueue() {
    this.speechLog.push('enqueue');
  }
  async speechAttachAudio(opts: { id: string }) {
    this.speechLog.push(`attachAudio:${opts.id}`);
  }
  async speechPlay() {
    this.speechLog.push('play');
  }
  async speechPause() {
    this.speechLog.push('pause');
  }
  async speechStop() {
    this.speechLog.push('stop');
  }
  async speechSeekTo(opts: { id: string }) {
    this.speechLog.push(`seekTo:${opts.id}`);
  }
  async speechSetRate(opts: { rate: number }) {
    this.speechLog.push(`setRate:${opts.rate}`);
  }
  async speechSetVoice() {
    this.speechLog.push('setVoice');
  }
  async speechSetSleepTimer() {
    this.speechLog.push('setSleepTimer');
  }
  async speechGetState() {
    return {
      status: 'idle' as const,
      bookId: null,
      currentUtteranceId: null,
      section: null,
      offset: null,
      rate: 1.0,
      voice: null,
      usingFallback: false,
      sleepTimer: { mode: 'off' as const },
    };
  }
  async speechReadJournal() {
    return { checkpoint: this.journalCheckpoint };
  }
  async speechCachePut(opts: { key: string; base64: string; ext?: string }) {
    const bytes = base64ToBytes(opts.base64);
    const path = `/cache/speech/${opts.key}.${opts.ext ?? 'mp3'}`;
    this.speechCache.set(path, bytes);
    return { path, bytes: bytes.byteLength };
  }
  async speechCacheClear() {
    this.speechCache.clear();
  }
  async speechCacheSize() {
    let total = 0;
    for (const b of this.speechCache.values()) total += b.byteLength;
    return { bytes: total };
  }

  async modelStatus(opts: { id: 'kokoro-v1.1-zh' }) {
    return {
      id: opts.id,
      state: 'absent' as const,
      variant: 'onnx-q8' as const,
      bytesDone: 0,
      bytesTotal: 129_967_797,
      installedBytes: 0,
      installedVoices: [] as string[],
    };
  }
  async modelDownload(opts: {
    id: 'kokoro-v1.1-zh';
    variant: 'onnx-fp32' | 'onnx-q8' | 'coreml';
    files: readonly { size: number }[];
    sources?: readonly string[];
  }) {
    this.lastModelDownloadSources = opts.sources ?? [];
    return {
      id: opts.id,
      state: 'downloading' as const,
      variant: opts.variant,
      bytesDone: 0,
      bytesTotal: opts.files.reduce((s, f) => s + f.size, 0),
      installedBytes: 0,
      installedVoices: [] as string[],
    };
  }
  async modelPause(opts: { id: 'kokoro-v1.1-zh' }) {
    return {
      id: opts.id,
      state: 'paused' as const,
      variant: 'onnx-q8' as const,
      bytesDone: 0,
      bytesTotal: 129_967_797,
      installedBytes: 0,
      installedVoices: [] as string[],
    };
  }
  async modelRemove(_opts: { id: 'kokoro-v1.1-zh' }) {}

  async deviceInfo() {
    return this.einkDevice;
  }
  async deviceSetImmersive(opts: { enabled: boolean }) {
    this.immersiveCalls.push(opts.enabled);
  }
  async deviceSetKeepScreenOn(opts: { enabled: boolean }) {
    this.keepScreenOnCalls.push(opts.enabled);
  }
  async deviceFullRefresh() {
    return { done: this.einkDevice.refresh === 'vendor' };
  }
  async deviceSetKeyPolicy(opts: { volumePaging: boolean }) {
    this.keyPolicyCalls.push(opts.volumePaging);
  }

  async secretsSet(opts: { name: string; value: string | null }) {
    if (opts.value) this.secrets.set(opts.name, opts.value);
    else this.secrets.delete(opts.name);
  }
  async secretsHas(opts: { name: string }) {
    return { exists: this.secrets.has(opts.name) };
  }
  async secretsRemove(opts: { name: string }) {
    this.secrets.delete(opts.name);
  }
  async openExternal() {}
  async setUiLanguage(opts: { lang: UiLanguage }) {
    this.uiLanguageCalls.push(opts.lang);
  }

  async addListener<K extends keyof MiniBookPluginEventMap>(
    eventName: K,
    listenerFunc: (payload: MiniBookPluginEventMap[K]) => void,
  ) {
    let set = this.eventListeners.get(eventName);
    if (!set) {
      set = new Set();
      this.eventListeners.set(eventName, set);
    }
    const fn = listenerFunc as (payload: unknown) => void;
    set.add(fn);
    return {
      async remove() {
        set!.delete(fn);
      },
    };
  }
}

function makeSampleInspected(): InspectedBook {
  const meta = {
    title: 'Snow Country',
    authors: ['Yasunari Kawabata'],
    language: 'ja',
    identifier: 'id-snow',
    format: 'txt' as const,
    direction: 'ltr' as const,
    fixedLayout: false,
  };
  const index: TxtBookIndex = {
    kind: 'txt',
    encoding: 'utf-8',
    usesDerivedText: true,
    meta,
    toc: [{ title: 'Ch 1', locator: { section: 0, offset: 0 }, children: [] }],
    spine: [{ index: 0, linear: true, sizeHint: 2048 }],
    chapters: [
      { index: 0, title: 'Ch 1', byteStart: 0, byteEnd: 300, charCount: 100, hasHeadingLine: true },
    ],
  };
  return {
    meta,
    cover: { mime: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]) },
    index,
  };
}

describe('@minibook/host-android PluginByteSource, FileLibraryStore & CapacitorPlatformHost', () => {
  it('coalesces 64 KiB windows, enforces 2 MiB LRU eviction, and splits > 1 MiB reads into <= 1 MiB chunks', async () => {
    const bridge = new InMemoryNativeBridge();
    const plugin = wrapNativeBridge(bridge);

    // 2.5 MiB synthetic file
    const size = Math.floor(2.5 * 1024 * 1024);
    const payload = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      payload[i] = (i * 13) & 0xff;
    }
    bridge.files.set('books/b_1/book.azw3', payload);

    const src = new PluginByteSource({
      plugin,
      path: 'books/b_1/book.azw3',
      size,
      fetchImpl: null,
    });

    // 6 random reads inside the same 64 KiB window -> exactly 1 native fsRead call!
    for (const off of [0, 64, 512, 4096, 32000, 65000]) {
      const slice = await src.read(off, 16);
      expect(slice).toEqual(payload.subarray(off, off + 16));
    }
    expect(bridge.fsReadCalls.length).toBe(1);
    expect(bridge.fsReadCalls[0]).toEqual({
      path: 'books/b_1/book.azw3',
      offset: 0,
      length: 65536,
    });

    // Large 2.2 MiB read splits into sequential <= 1 MiB calls and never exceeds 1_048_576 bytes
    bridge.fsReadCalls.length = 0;
    const bigLen = Math.floor(2.2 * 1024 * 1024);
    const bigSlice = await src.read(1024, bigLen);
    expect(bigSlice.byteLength).toBe(bigLen);
    expect(Buffer.compare(bigSlice, payload.subarray(1024, 1024 + bigLen))).toBe(0);
    expect(bridge.fsReadCalls.length).toBe(3);
    for (const c of bridge.fsReadCalls) {
      expect(c.length).toBeLessThanOrEqual(PLUGIN_MAX_READ_BYTES);
    }

    // Touch 36 distinct 64 KiB windows (> 2 MiB = 32 windows) -> window 0 is evicted from LRU
    bridge.fsReadCalls.length = 0;
    for (let w = 0; w < 36; w++) {
      await src.read(w * 65536 + 10, 8);
    }
    const callsAfterSweep = bridge.fsReadCalls.length;
    // Window 35 is still hot in LRU -> 0 new calls
    await src.read(35 * 65536 + 10, 8);
    expect(bridge.fsReadCalls.length).toBe(callsAfterSweep);
    // Window 0 was evicted -> triggers 1 fresh read
    await src.read(10, 8);
    expect(bridge.fsReadCalls.length).toBe(callsAfterSweep + 1);
  });

  it('rebuilds corrupt library.json from books/*/index.json, reconciles SpeechJournal, and suppresses KEEP_SCREEN_ON on E-Ink', async () => {
    const bridge = new InMemoryNativeBridge();
    bridge.einkDevice = {
      eink: true,
      vendor: 'onyx',
      model: 'BOOX Page',
      refresh: 'vendor',
    };
    const plugin = wrapNativeBridge(bridge);
    const host = createCapacitorPlatformHost({
      plugin,
      platform: 'android',
      fetchImpl: null,
    });

    // Wait for async deviceInfo probe
    await new Promise((r) => setTimeout(r, 10));
    expect(host.info.capabilities.einkDetected).toBe(true);
    expect(host.info.capabilities.vendorRefresh).toBe(true);
    expect(host.info.capabilities.volumeKeyPaging).toBe(true);

    // On detected E-Ink devices, setKeepScreenOn(true) MUST pass enabled: false to native!
    await host.device.setKeepScreenOn(true);
    expect(bridge.keepScreenOnCalls).toEqual([false]);

    // Import book + derived text.bin
    const rawBook = new Uint8Array(1024).fill(0x41);
    const ticket = await host.library.beginImport({
      name: 'snow.txt',
      size: rawBook.byteLength,
      bytes: memoryByteSource(rawBook),
    });
    await ticket.putDerived('text.bin', new Uint8Array(300).fill(0x42));
    const book = await host.library.commitImport(ticket, makeSampleInspected());
    expect(book.title).toBe('Snow Country');

    // Corrupt library.json -> host.library.list() automatically rebuilds from books/*/index.json!
    bridge.files.set('library.json', new TextEncoder().encode('{corrupt json!!!'));
    const rebuilt = await host.library.list();
    expect(rebuilt.length).toBe(1);
    expect(rebuilt[0]?.id).toBe(book.id);

    // Reconcile native SpeechJournal checkpoint on state.getPosition
    bridge.journalCheckpoint = {
      bookId: book.id,
      section: 0,
      offset: 777,
      utteranceId: '0:777-810',
      wallMs: Date.now() + 5000,
    };
    const pos = await host.state.getPosition(book.id);
    expect(pos?.offset).toBe(777);
  });

  it('forwards NativeSpeechPlayer events and plugin HTTP/WebSocket transports cleanly', async () => {
    const bridge = new InMemoryNativeBridge();
    const plugin = wrapNativeBridge(bridge);

    await bridge.secretsSet({ name: 'custom-speech-key', value: 'sk-android-999' });
    const http = createPluginHttpTransport(plugin);
    const resp = await http({
      url: 'http://192.168.1.10:8000/v1/audio/speech',
      method: 'POST',
      headers: { Authorization: 'Bearer {{secret:custom-speech-key}}' },
      body: '{"input":"test"}',
    });
    expect(resp.status).toBe(200);
    expect(bridge.lastHttpHeaders['Authorization']).toBe('Bearer sk-android-999');

    // WebSocket transport round-trip
    const wsTransport = createPluginSocketTransport(plugin);
    const receivedMessages: string[] = [];
    const conn = await wsTransport(
      { url: 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1' },
      {
        onMessage(msg) {
          if (msg.kind === 'text') receivedMessages.push(msg.text);
        },
        onClose() {},
      },
    );
    conn.sendText('hello-edge');
    await new Promise((r) => setTimeout(r, 10));
    expect(receivedMessages).toEqual(['echo:hello-edge']);
    conn.close();

    // NativeSpeechPlayer event parity
    const player = new NativeSpeechPlayer(plugin);
    const events: SpeechEvent[] = [];
    const unsub = player.subscribe((e) => events.push(e));
    await new Promise((r) => setTimeout(r, 10));

    bridge.emitEvent('utterance-start', {
      id: '0:0-20',
      section: 0,
      start: 0,
      end: 20,
      usingFallback: false,
    });
    bridge.emitEvent('speech-fallback', {
      reason: 'network timeout',
      utteranceId: '0:20-40',
    });

    expect(events).toEqual([
      { type: 'utterance-start', id: '0:0-20', section: 0, start: 0, end: 20, usingFallback: false },
      { type: 'speech-fallback', reason: 'network timeout', utteranceId: '0:20-40' },
    ]);
    unsub();
  });

  it('preserves strict FIFO command order in NativeSpeechPlayer, dedupes incoming-file, and persists speech cache index', async () => {
    const bridge = new InMemoryNativeBridge();
    bridge.pendingImports.push({
      tempPath: 'tmp/incoming_cold_1.epub',
      name: 'ColdLaunch.epub',
      size: 4096,
    });
    const plugin = wrapNativeBridge(bridge);

    // 1. Cold NativeSpeechPlayer (before listeners attached): synchronous burst must NOT reorder!
    const player = new NativeSpeechPlayer(plugin);
    player.enqueue([
      {
        id: '0:0-12',
        section: 0,
        start: 0,
        end: 12,
        blockIndex: 0,
        text: 'Hello world.',
        lang: 'en',
        pauseAfterMs: 200,
      },
    ]);
    player.seekTo('0:0-12');
    player.play();
    player.pause();
    await player.getState();

    expect(bridge.speechLog).toEqual(['enqueue', 'seekTo:0:0-12', 'play', 'pause']);

    // 2. Cold-launch incoming-file deduplication + cold byteSource not-found guard
    let synthCalls = 0;
    const host1 = createCapacitorPlatformHost({
      plugin,
      platform: 'android',
      fetchImpl: null,
      edgeProvider: {
        async synthesize() {
          synthCalls += 1;
          return {
            audio: new Uint8Array([1, 2, 3, 4]),
            mime: 'audio/mpeg',
            durationMs: 900,
            marks: [{ start: 0, end: 5, timeMs: 0 }],
          };
        },
        async listVoices() {
          return [];
        },
      },
    });

    expect(() => host1.files.byteSource('b_cold_unloaded')).toThrow(/not loaded/);

    const incomingSeen: Array<readonly { tempPath?: string; name: string; size: number }[]> = [];
    const unsubHost = host1.subscribe((ev) => {
      if (ev.type === 'incoming-file') {
        incomingSeen.push([...ev.files]);
      }
    });
    await new Promise((r) => setTimeout(r, 15));
    // Re-emitting the same tempPath is deduplicated so it is never imported twice!
    bridge.emitEvent('incoming-file', {
      files: [{ tempPath: 'tmp/incoming_cold_1.epub', name: 'ColdLaunch.epub', size: 4096 }],
    });
    expect(incomingSeen.length).toBe(1);
    expect(incomingSeen[0]?.length).toBe(1);
    unsubHost();

    // 3. Persistent speech-cache-index.json survives relaunch (new host instance)
    const r1 = await host1.speech.synthesize({
      engine: 'edge',
      voiceId: 'en-US-AvaMultilingualNeural',
      text: 'Persistent sentence.',
      lang: 'en',
    });
    expect(r1.cached).toBe(false);
    expect(synthCalls).toBe(1);

    const host2 = createCapacitorPlatformHost({
      plugin,
      platform: 'android',
      fetchImpl: null,
      edgeProvider: {
        async synthesize() {
          synthCalls += 1;
          throw new Error('Should not re-synthesize on cache hit');
        },
        async listVoices() {
          return [];
        },
      },
    });
    const r2 = await host2.speech.synthesize({
      engine: 'edge',
      voiceId: 'en-US-AvaMultilingualNeural',
      text: 'Persistent sentence.',
      lang: 'en',
    });
    expect(r2.cached).toBe(true);
    expect(r2.ref).toBe(r1.ref);
    expect(synthCalls).toBe(1);
  });

  it('auto-imports real EPUB and KF8 (.azw3) fixtures on incoming-file and serves sections via PluginByteSource', async () => {
    const fixturesDir = resolve(fileURLToPath(new URL('../../../fixtures', import.meta.url)));
    const epubBytes = new Uint8Array(readFileSync(resolve(fixturesDir, 'epub3-modern.epub')));
    const kf8Bytes = new Uint8Array(readFileSync(resolve(fixturesDir, 'kf8-sample.azw3')));

    const bridge = new InMemoryNativeBridge();
    bridge.files.set('tmp/open_with_1.epub', epubBytes);
    bridge.files.set('tmp/open_with_2.azw3', kf8Bytes);

    const plugin = wrapNativeBridge(bridge);
    const host = createCapacitorPlatformHost({
      plugin,
      platform: 'android',
      fetchImpl: null,
    });

    const changedBookIds: string[] = [];
    const unsub = host.subscribe((ev) => {
      if (ev.type === 'library-changed' && ev.bookId) {
        changedBookIds.push(ev.bookId);
      }
    });
    await new Promise((r) => setTimeout(r, 10));

    bridge.emitEvent('incoming-file', {
      files: [
        { tempPath: 'tmp/open_with_1.epub', name: 'epub3-modern.epub', size: epubBytes.byteLength },
        { tempPath: 'tmp/open_with_2.azw3', name: 'kf8-sample.azw3', size: kf8Bytes.byteLength },
      ],
    });

    await expect.poll(() => changedBookIds.length, { timeout: 5000 }).toBe(2);
    unsub();

    const list = await host.library.list();
    expect(list.length).toBe(2);

    for (const book of list) {
      const detail = await host.library.get(book.id);
      expect(detail).not.toBeNull();
      const session = await openBook(
        new WindowedByteSource(host.files.byteSource(book.id, 'book')),
        {
          fileName: detail!.fileName,
          getDerived: (name) => {
            if (name !== 'text.bin') return null;
            const d = host.files.byteSource(book.id, 'text');
            return d.size > 0 ? new WindowedByteSource(d) : null;
          },
        },
        detail!.index,
      );
      const sec0 = await session.loadSection(0, 0);
      expect(sec0.xhtml.length).toBeGreaterThan(0);
      session.close();
    }
  });

  it('forwards speech-model and engine-slow events and synthesizes qwen via plugin HTTP transport', async () => {
    const bridge = new InMemoryNativeBridge();
    const wav = encodeMonoPcm16Wav(new Float32Array(2400).fill(0.2), 24_000).wav;
    bridge.httpContentTypeOverride = 'audio/wav';
    bridge.httpBodyOverride = wav;

    const plugin = wrapNativeBridge(bridge);
    const host = createCapacitorPlatformHost({
      plugin,
      platform: 'android',
      fetchImpl: null,
    });

    await host.settings.update({
      qwenServer: {
        baseUrl: 'http://192.168.1.20:8000',
        protocol: 'mlx-audio',
        model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16',
        voice: 'Vivian',
      },
    });
    await host.settings.setSecret('qwen-api-key', 'sk-qwen-android');

    const hostEvents: HostEvent[] = [];
    const unsubHost = host.subscribe((e) => hostEvents.push(e));
    const player = new NativeSpeechPlayer(plugin);
    const playerEvents: SpeechEvent[] = [];
    const unsubPlayer = player.subscribe((e) => playerEvents.push(e));
    await new Promise((r) => setTimeout(r, 15));

    bridge.emitEvent('speech-model', {
      id: KOKORO_MODEL_ID,
      state: 'downloading',
      variant: 'onnx-q8',
      bytesDone: 50_000,
      bytesTotal: 100_000,
      installedBytes: 0,
      installedVoices: [],
    });
    bridge.emitEvent('engine-slow', { rtf: 1.15, engine: 'kokoro' });

    expect(hostEvents.some((e) => e.type === 'speech-model' && e.status.bytesDone === 50_000)).toBe(true);
    expect(playerEvents.some((e) => e.type === 'engine-slow' && e.rtf === 1.15 && e.engine === 'kokoro')).toBe(true);

    const voices = await host.speech.listRemoteVoices('qwen');
    expect(voices.some((v) => v.id === 'Vivian' && v.provider === 'qwen')).toBe(true);

    const res = await host.speech.synthesize({
      engine: 'qwen',
      voiceId: 'Vivian',
      text: '你好，世界。',
      lang: 'zh-CN',
    });
    expect(bridge.lastHttpUrl).toBe('http://192.168.1.20:8000/v1/audio/speech');
    expect(bridge.lastHttpHeaders['Authorization']).toBe('Bearer sk-qwen-android');
    expect(res.mime).toBe('audio/wav');
    expect(res.cached).toBe(false);

    const cached = await host.speech.synthesize({
      engine: 'qwen',
      voiceId: 'Vivian',
      text: '你好，世界。',
      lang: 'zh-CN',
    });
    expect(cached.cached).toBe(true);

    const dlStatus = await host.speech.models!.download(KOKORO_MODEL_ID, { voices: ['zf_001'] });
    expect(dlStatus.variant).toBe('onnx-q8');
    expect(dlStatus.state).toBe('downloading');

    await host.settings.update({ modelDownloadSource: 'hf-mirror' });
    await host.speech.models!.download(KOKORO_MODEL_ID, {
      voices: ['zf_001'],
      source: 'huggingface',
      mirrorBaseUrl: null,
    });
    expect(bridge.lastModelDownloadSources).toEqual(['https://huggingface.co']);

    unsubHost();
    unsubPlayer();
  });

  it('[v0.2.3] adopts human-readable CJK userbooks/<Title>.<ext>, auto-migrates legacy books/<id>/book.<ext>, shares via fsShare, and removes both userbooks + metadata', async () => {
    const bridge = new InMemoryNativeBridge();
    // Seed a legacy v0.2.2 book (`books/b_legacy_luxun/book.txt` without `bookPath`)
    const legacyBytes = new TextEncoder().encode('我冒了严寒，回到相隔二千余里，别了二十余年的故乡去。');
    bridge.files.set('books/b_legacy_luxun/book.txt', legacyBytes);
    const legacyInspected: InspectedBook = {
      ...makeSampleInspected(),
      meta: {
        ...makeSampleInspected().meta,
        title: '呐喊',
        authors: ['鲁迅'],
        language: 'zh-CN',
        format: 'txt',
      },
      cover: null,
    };
    bridge.files.set(
      'books/b_legacy_luxun/index.json',
      new TextEncoder().encode(
        JSON.stringify({
          id: 'b_legacy_luxun',
          meta: legacyInspected.meta,
          index: legacyInspected.index,
          fileName: 'nahan.txt',
          fileExt: 'txt',
          size: legacyBytes.byteLength,
          derivedTextSize: 0,
          hasCover: false,
          coverExt: null,
          coverMime: null,
          addedAt: 1_760_000_000_000,
          openedAt: null,
          finished: false,
        }),
      ),
    );
    bridge.files.set(
      'books/b_legacy_luxun/state.json',
      new TextEncoder().encode(JSON.stringify({ position: null, bookmarks: [] })),
    );

    const plugin = wrapNativeBridge(bridge);
    const host = createCapacitorPlatformHost({
      plugin,
      platform: 'ios',
      fetchImpl: null,
    });

    // Startup `library.list()` automatically migrates legacy `books/b_legacy_luxun/book.txt` -> `userbooks/呐喊.txt`!
    const initialBooks = await host.library.list();
    expect(initialBooks.some((b) => b.id === 'b_legacy_luxun' && b.title === '呐喊')).toBe(true);
    expect(bridge.files.has('userbooks/呐喊.txt')).toBe(true);
    expect(bridge.files.has('books/b_legacy_luxun/book.txt')).toBe(false);

    // Import two distinct CJK books with the same title `三体` -> `userbooks/三体.txt` and `userbooks/三体 (2).txt`
    const raw1 = new TextEncoder().encode('叶文洁仰望红岸基地的天线。');
    const t1 = await host.library.beginImport({
      name: '三体.txt',
      size: raw1.byteLength,
      bytes: memoryByteSource(raw1),
    });
    const inspectedSanti: InspectedBook = {
      ...makeSampleInspected(),
      meta: {
        ...makeSampleInspected().meta,
        title: '三体',
        authors: ['刘慈欣'],
        language: 'zh-CN',
        format: 'txt',
      },
    };
    const b1 = await host.library.commitImport(t1, inspectedSanti);
    expect(bridge.files.has('userbooks/三体.txt')).toBe(true);

    const raw2 = new TextEncoder().encode('罗辑面向黑暗森林。');
    const t2 = await host.library.beginImport({
      name: '三体2.txt',
      size: raw2.byteLength,
      bytes: memoryByteSource(raw2),
    });
    const b2 = await host.library.commitImport(t2, inspectedSanti);
    expect(bridge.files.has('userbooks/三体 (2).txt')).toBe(true);

    // Share file invokes native `fsShare` with exact `userbooks/` path & title
    await host.library.shareFile!(b1.id);
    expect(bridge.sharedFiles).toEqual([
      {
        path: 'userbooks/三体.txt',
        title: '三体',
        mimeType: 'text/plain; charset=utf-8',
      },
    ]);

    // Storage usage counts both `books/` metadata and `userbooks/` book files
    const usage = await host.settings.storageUsage!();
    expect(usage.booksBytes).toBeGreaterThan(raw1.byteLength + raw2.byteLength);

    // Removing b1 deletes BOTH `userbooks/三体.txt` AND `books/<b1.id>/index.json` while keeping `三体 (2).txt`
    await host.library.remove(b1.id);
    expect(bridge.files.has('userbooks/三体.txt')).toBe(false);
    expect(bridge.files.has(`books/${b1.id}/index.json`)).toBe(false);
    expect(bridge.files.has('userbooks/三体 (2).txt')).toBe(true);
    expect(b2.id).not.toBe(b1.id);
  });

  it('[v0.2.3] adopts Files-app drop-ins in place when filename != title, heals renamed files without losing state, tracks duplicate aliasPaths, and deletes cleanly', async () => {
    const bridge = new InMemoryNativeBridge();
    const plugin = wrapNativeBridge(bridge);
    const host = createCapacitorPlatformHost({
      plugin,
      platform: 'ios',
      fetchImpl: null,
    });

    // 1. User drops `santi.txt` (filename != metadata title `三体`) into `Files -> Books`
    const dropBytes = new TextEncoder().encode('汪淼觉得自己最近遇到的事情有些奇怪。');
    bridge.files.set('userbooks/santi.txt', dropBytes);

    const dropTicket = await host.library.beginImport({
      name: 'santi.txt',
      size: dropBytes.byteLength,
      bytes: memoryByteSource(dropBytes),
      sourceRef: 'userbooks/santi.txt',
    });
    const inspectedSanti: InspectedBook = {
      ...makeSampleInspected(),
      meta: {
        ...makeSampleInspected().meta,
        title: '三体',
        authors: ['刘慈欣'],
        language: 'zh-CN',
        format: 'txt',
      },
    };
    const imported = await host.library.commitImport(dropTicket, inspectedSanti);
    expect(imported.title).toBe('三体');
    expect(imported.openedAt).toBeNull();
    // Adopted IN PLACE: `userbooks/santi.txt` exists, ZERO duplicate `userbooks/三体.txt`!
    expect(bridge.files.has('userbooks/santi.txt')).toBe(true);
    expect(bridge.files.has('userbooks/三体.txt')).toBe(false);

    // Save reading progress at offset 12
    await host.state.savePosition(imported.id, {
      section: 0,
      offset: 12,
      fraction: 0.5,
      snippet: '有些奇怪',
      updatedAt: 1_770_000_000_000,
    });

    // 2. User renames `userbooks/santi.txt` -> `userbooks/刘慈欣-三体.txt` in system Files app!
    bridge.files.delete('userbooks/santi.txt');
    bridge.files.set('userbooks/刘慈欣-三体.txt', dropBytes);

    // Even BEFORE a background drop-in scan runs, `library.get` + `byteSource` + `shareFile` heal `bookPath` immediately!
    const healedDetail = await host.library.get(imported.id);
    expect(healedDetail?.fileName).toBe('刘慈欣-三体.txt');
    const chunk = await host.files.byteSource(imported.id, 'book').read(0, dropBytes.byteLength);
    expect(new TextDecoder().decode(chunk)).toContain('汪淼');
    expect((await host.state.getPosition(imported.id))?.offset).toBe(12);

    // Also test cold-relaunch scan path when renamed again (`刘慈欣-三体.txt` -> `三体精校版.txt`)
    bridge.files.delete('userbooks/刘慈欣-三体.txt');
    bridge.files.set('userbooks/三体精校版.txt', dropBytes);
    const rescanTicket = await host.library.beginImport({
      name: '三体精校版.txt',
      size: dropBytes.byteLength,
      bytes: memoryByteSource(dropBytes),
      sourceRef: 'userbooks/三体精校版.txt',
    });
    const healedViaScan = await host.library.commitImport(rescanTicket, inspectedSanti);
    expect(healedViaScan.fileName).toBe('三体精校版.txt');
    expect(healedViaScan.openedAt).toBe(1_770_000_000_000); // openedAt NOT bumped by passive scan!
    expect(bridge.files.has('userbooks/三体精校版.txt')).toBe(true);

    // 3. User ALSO drops an identical copy `userbooks/santi-backup.txt` alongside `三体精校版.txt`
    bridge.files.set('userbooks/santi-backup.txt', dropBytes);
    const dupTicket = await host.library.beginImport({
      name: 'santi-backup.txt',
      size: dropBytes.byteLength,
      bytes: memoryByteSource(dropBytes),
      sourceRef: 'userbooks/santi-backup.txt',
    });
    await host.library.commitImport(dupTicket, inspectedSanti);
    // Neither file is deleted on import, and `aliasPaths` is recorded in `index.json` + `library.json`
    expect(bridge.files.has('userbooks/三体精校版.txt')).toBe(true);
    expect(bridge.files.has('userbooks/santi-backup.txt')).toBe(true);
    const idxJson = JSON.parse(
      new TextDecoder().decode(bridge.files.get(`books/${imported.id}/index.json`)!),
    ) as { bookPath: string; aliasPaths?: string[] };
    expect(idxJson.bookPath).toBe('userbooks/三体精校版.txt');
    expect(idxJson.aliasPaths).toEqual(['userbooks/santi-backup.txt']);

    // 4. Deleting the book in the app removes BOTH primary `bookPath` AND `aliasPaths` so nothing resurrects on relaunch!
    await host.library.remove(imported.id);
    expect(bridge.files.has('userbooks/三体精校版.txt')).toBe(false);
    expect(bridge.files.has('userbooks/santi-backup.txt')).toBe(false);
    expect(bridge.files.has(`books/${imported.id}/index.json`)).toBe(false);
  });

  it('forwards device.setUiLanguage to native MiniBookPlugin.setUiLanguage on Android and iOS', async () => {
    const bridge = new InMemoryNativeBridge();
    const host = createCapacitorPlatformHost({
      plugin: wrapNativeBridge(bridge),
      platform: 'android',
    });
    await host.device.setUiLanguage?.('zh-CN');
    await host.device.setUiLanguage?.('ja');
    await host.device.setUiLanguage?.('system');
    expect(bridge.uiLanguageCalls).toEqual(['zh-CN', 'ja', 'system']);
  });
});
