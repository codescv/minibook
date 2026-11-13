import { describe, expect, it } from 'vitest';
import { memoryByteSource, type InspectedBook, type SpeechEvent, type TxtBookIndex } from '@minibook/core';
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
  keepScreenOnCalls: boolean[] = [];
  immersiveCalls: boolean[] = [];
  keyPolicyCalls: boolean[] = [];
  einkDevice = {
    eink: false,
    vendor: null as string | null,
    model: 'Pixel 9' as string | null,
    refresh: 'software' as 'vendor' | 'software',
  };
  journalCheckpoint: SpeechJournalCheckpoint | null = null;
  lastHttpHeaders: Record<string, string> = {};

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

  async importPick(_opts: { multiple: boolean }) {
    return { files: [...this.pickedFiles] };
  }

  async importAdopt(opts: { tempPath: string; bookId: string; ext: string }) {
    const src = this.normalize(opts.tempPath);
    const bytes = this.files.get(src);
    if (!bytes) throw new Error(`Missing staged file: ${src}`);
    const dest = `books/${opts.bookId}/book.${opts.ext}`;
    this.files.set(dest, bytes);
    this.files.delete(src);
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
    return {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
      bodyBase64: bytesToBase64(new Uint8Array([0xff, 0xfb, 0x90, 0x64])),
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

  async speechLoad() {}
  async speechEnqueue() {}
  async speechAttachAudio() {}
  async speechPlay() {}
  async speechPause() {}
  async speechStop() {}
  async speechSeekTo() {}
  async speechSetRate() {}
  async speechSetVoice() {}
  async speechSetSleepTimer() {}
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
});
