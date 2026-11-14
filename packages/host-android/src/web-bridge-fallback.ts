/**
 * Non-native browser fallback for `MiniBookNativeBridge` used ONLY when `packages/host-android/www`
 * is opened outside a native Capacitor host (`!Capacitor.isNativePlatform()`, e.g. `vite preview`
 * or Playwright WebKit/Chromium bundle verification).
 *
 * On real iOS (`WKWebView`) and Android (`WebView`), `Capacitor.isNativePlatform()` is `true` and
 * this module is bypassed completely in favor of the native `MiniBook` plugin.
 */
import {
  MiniBookError,
  mimeFromPath,
  sanitizeReadableBookFileName,
  type DeviceInfo,
  type KeyPolicy,
  type SleepTimerConfig,
  type SpeechModelId,
  type SpeechModelStatus,
  type SpeechSession,
  type SpeechState,
  type Voice,
  type VoiceRef,
} from '@minibook/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type {
  MiniBookNativeBridge,
  MiniBookPluginEventMap,
  NativeAdoptRequest,
  NativeAdoptResponse,
  NativeFsAppendRequest,
  NativeFsEntry,
  NativeFsReadRequest,
  NativeFsReadResponse,
  NativeFsStatResponse,
  NativeFsWriteAtomicRequest,
  NativeHttpRequest,
  NativeHttpResponse,
  NativeModelDownloadRequest,
  NativePickedFile,
  NativeSocketCloseRequest,
  NativeSocketOpenRequest,
  NativeSocketSendRequest,
  NativeSpeechAttachAudioRequest,
  NativeSpeechCachePutRequest,
  NativeSpeechCachePutResponse,
  NativeSpeechEnqueueRequest,
  SpeechJournalCheckpoint,
} from './plugin-types.js';
import { base64ToBytes, bytesToBase64 } from './storage/base64.js';

const LS_PREFIX = 'minibook.fs:';

function normalizeRelPath(raw: string): string {
  return raw.replace(/^\/+/, '').replace(/\/+$/, '');
}

function sourceLabelFromUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    return new URL(rawUrl).host;
  } catch {
    return rawUrl;
  }
}

export function createWebFallbackMiniBookBridge(): MiniBookNativeBridge {
  const files = new Map<string, Uint8Array>();
  const mtimes = new Map<string, number>();
  const blobUrls = new Map<string, string>();
  const secrets = new Map<string, string>();
  const speechCache = new Map<string, Uint8Array>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let pickSeq = 0;

  // Hydrate small JSON files (`settings.json`, `library.json`, `books/*/index.json`, `books/*/state.json`) from localStorage if pre-populated
  try {
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(LS_PREFIX)) {
          const rel = k.slice(LS_PREFIX.length);
          const val = localStorage.getItem(k);
          if (rel && val !== null) {
            files.set(rel, new TextEncoder().encode(val));
            mtimes.set(rel, Date.now());
          }
        }
      }
    }
  } catch {
    // ignore storage access errors
  }

  let speechState: SpeechState = {
    status: 'idle',
    bookId: null,
    currentUtteranceId: null,
    section: null,
    offset: null,
    rate: 1.0,
    voice: null,
    usingFallback: false,
    sleepTimer: { mode: 'off' },
  };

  let modelStatusState: SpeechModelStatus = {
    id: 'kokoro-v1.1-zh',
    state: 'absent',
    variant: 'onnx-q8',
    bytesDone: 0,
    bytesTotal: 129_967_797,
    installedBytes: 0,
    installedVoices: [],
  };

  function emit<K extends keyof MiniBookPluginEventMap>(
    event: K,
    payload: MiniBookPluginEventMap[K],
  ): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch {
        // isolate subscriber errors
      }
    }
  }

  function persistIfSmallJson(path: string, bytes: Uint8Array): void {
    if (!path.endsWith('.json') || bytes.byteLength > 256 * 1024) return;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LS_PREFIX + path, new TextDecoder().decode(bytes));
      }
    } catch {
      // ignore quota errors
    }
  }

  function revokeBlobFor(path: string): void {
    const prev = blobUrls.get(path);
    if (prev && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(prev);
    }
    blobUrls.delete(path);
  }

  return {
    async fsRead(opts: NativeFsReadRequest): Promise<NativeFsReadResponse> {
      const p = normalizeRelPath(opts.path);
      const data = files.get(p);
      if (!data) {
        throw new MiniBookError('not-found', `File not found: ${p}`);
      }
      if (opts.offset >= data.byteLength || opts.length <= 0) {
        return { base64: '', bytesRead: 0 };
      }
      const end = Math.min(data.byteLength, opts.offset + opts.length);
      const slice = data.subarray(opts.offset, end);
      return { base64: bytesToBase64(slice), bytesRead: slice.byteLength };
    },

    async fsWriteAtomic(opts: NativeFsWriteAtomicRequest): Promise<void> {
      const p = normalizeRelPath(opts.path);
      const bytes =
        opts.text !== undefined
          ? new TextEncoder().encode(opts.text)
          : base64ToBytes(opts.base64 ?? '');
      revokeBlobFor(p);
      files.set(p, bytes);
      mtimes.set(p, Date.now());
      persistIfSmallJson(p, bytes);
    },

    async fsAppend(opts: NativeFsAppendRequest): Promise<void> {
      const p = normalizeRelPath(opts.path);
      const chunk = base64ToBytes(opts.base64);
      const existing = files.get(p);
      let next: Uint8Array;
      if (!existing) {
        next = chunk;
      } else {
        next = new Uint8Array(existing.byteLength + chunk.byteLength);
        next.set(existing, 0);
        next.set(chunk, existing.byteLength);
      }
      revokeBlobFor(p);
      files.set(p, next);
      mtimes.set(p, Date.now());
    },

    async fsList(opts: { path: string }): Promise<{ entries: NativeFsEntry[] }> {
      const prefix = normalizeRelPath(opts.path);
      const dirPrefix = prefix ? `${prefix}/` : '';
      const seenDirs = new Set<string>();
      const entries: NativeFsEntry[] = [];

      for (const [fullPath, data] of files.entries()) {
        if (dirPrefix && !fullPath.startsWith(dirPrefix)) continue;
        const rest = dirPrefix ? fullPath.slice(dirPrefix.length) : fullPath;
        if (!rest) continue;
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({
            name: rest,
            path: fullPath,
            size: data.byteLength,
            mtimeMs: mtimes.get(fullPath) ?? 0,
            isDirectory: false,
          });
        } else {
          const dirName = rest.slice(0, slash);
          if (!seenDirs.has(dirName)) {
            seenDirs.add(dirName);
            const subPath = dirPrefix ? `${prefix}/${dirName}` : dirName;
            entries.push({
              name: dirName,
              path: subPath,
              size: 0,
              mtimeMs: 0,
              isDirectory: true,
            });
          }
        }
      }
      return { entries };
    },

    async fsRemove(opts: { path: string }): Promise<void> {
      const p = normalizeRelPath(opts.path);
      const dirPrefix = `${p}/`;
      for (const key of [...files.keys()]) {
        if (key === p || key.startsWith(dirPrefix)) {
          revokeBlobFor(key);
          files.delete(key);
          mtimes.delete(key);
          try {
            if (typeof localStorage !== 'undefined') {
              localStorage.removeItem(LS_PREFIX + key);
            }
          } catch {
            // ignore
          }
        }
      }
    },

    async fsStat(opts: { path: string }): Promise<NativeFsStatResponse> {
      const p = normalizeRelPath(opts.path);
      const exact = files.get(p);
      if (exact) {
        return {
          exists: true,
          size: exact.byteLength,
          mtimeMs: mtimes.get(p) ?? 0,
          isDirectory: false,
        };
      }
      const dirPrefix = `${p}/`;
      for (const key of files.keys()) {
        if (key.startsWith(dirPrefix)) {
          return { exists: true, size: 0, mtimeMs: 0, isDirectory: true };
        }
      }
      return { exists: false };
    },

    async fsFileUrl(opts: { path: string }): Promise<{ url: string }> {
      const p = normalizeRelPath(opts.path);
      const existingUrl = blobUrls.get(p);
      if (existingUrl) return { url: existingUrl };
      const data = files.get(p);
      if (!data) {
        throw new MiniBookError('not-found', `File not found: ${p}`);
      }
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      const blob = new Blob([copy.buffer], { type: mimeFromPath(p) });
      const url = URL.createObjectURL(blob);
      blobUrls.set(p, url);
      return { url };
    },

    async fsShare(opts: { path: string; title?: string; mimeType?: string }): Promise<void> {
      const p = normalizeRelPath(opts.path);
      const data = files.get(p);
      if (!data) {
        throw new MiniBookError('not-found', `File not found: ${p}`);
      }
      if (typeof document !== 'undefined' && typeof URL !== 'undefined') {
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        const blob = new Blob([copy.buffer], { type: opts.mimeType ?? mimeFromPath(p) });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = p.split('/').pop() || opts.title || 'book';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    },

    async importPick(opts: { multiple: boolean }): Promise<{ files: NativePickedFile[] }> {
      if (typeof document === 'undefined') return { files: [] };
      return new Promise<{ files: NativePickedFile[] }>((resolvePick) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = opts.multiple;
        input.accept = '.epub,.azw3,.azw,.mobi,.prc,.fb2,.zip,.txt,.md';
        input.style.display = 'none';
        document.body.appendChild(input);

        let settled = false;
        const finish = async (fileList: FileList | null): Promise<void> => {
          if (settled) return;
          settled = true;
          input.remove();
          if (!fileList || fileList.length === 0) {
            resolvePick({ files: [] });
            return;
          }
          const picked: NativePickedFile[] = [];
          for (const f of Array.from(fileList)) {
            const bytes = new Uint8Array(await f.arrayBuffer());
            const tempPath = `tmp/web_pick_${++pickSeq}_${Date.now()}`;
            files.set(tempPath, bytes);
            mtimes.set(tempPath, Date.now());
            picked.push({ tempPath, name: f.name, size: bytes.byteLength });
          }
          resolvePick({ files: picked });
        };

        input.addEventListener('change', () => {
          void finish(input.files);
        });
        input.addEventListener('cancel', () => {
          void finish(null);
        });
        input.click();
      });
    },

    async importAdopt(opts: NativeAdoptRequest): Promise<NativeAdoptResponse> {
      const srcPath = normalizeRelPath(opts.tempPath);
      const data = files.get(srcPath);
      if (!data) {
        throw new MiniBookError('not-found', `Staged file not found: ${srcPath}`);
      }
      if (srcPath.startsWith('userbooks/')) {
        return { path: srcPath, size: data.byteLength };
      }
      const baseName = sanitizeReadableBookFileName(opts.preferredName || opts.bookId, opts.ext);
      const suffix = `.${opts.ext.toLowerCase() === 'fb2.zip' ? 'fb2.zip' : opts.ext.toLowerCase()}`;
      const stem = baseName.endsWith(suffix)
        ? baseName.slice(0, baseName.length - suffix.length)
        : baseName;
      let candidate = `userbooks/${baseName}`;
      let counter = 2;
      while (files.has(candidate) && candidate !== srcPath) {
        const existing = files.get(candidate)!;
        if (
          existing.byteLength === data.byteLength &&
          existing.every((b, idx) => b === data[idx])
        ) {
          break;
        }
        candidate = `userbooks/${stem} (${counter})${suffix}`;
        counter += 1;
      }
      revokeBlobFor(srcPath);
      revokeBlobFor(candidate);
      files.set(candidate, data);
      if (srcPath !== candidate) {
        files.delete(srcPath);
      }
      mtimes.set(candidate, Date.now());
      return { path: candidate, size: data.byteLength };
    },

    async importConsumePending(): Promise<{ files: NativePickedFile[] }> {
      return { files: [] };
    },

    async httpRequest(opts: NativeHttpRequest): Promise<NativeHttpResponse> {
      const headers: Record<string, string> = {};
      if (opts.headers) {
        for (const [k, v] of Object.entries(opts.headers)) {
          headers[k] = v.replace(/\{\{secret:([^}]+)\}\}/g, (_m, name: string) => secrets.get(name) ?? '');
        }
      }
      const bodyBytes = opts.bodyBase64 ? base64ToBytes(opts.bodyBase64) : undefined;
      let reqBody: ArrayBuffer | undefined;
      if (bodyBytes) {
        const copy = new Uint8Array(bodyBytes.byteLength);
        copy.set(bodyBytes);
        reqBody = copy.buffer;
      }
      const res = await fetch(opts.url, {
        method: opts.method,
        headers,
        ...(reqBody ? { body: reqBody } : {}),
      });
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((val, key) => {
        respHeaders[key] = val;
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      return {
        status: res.status,
        headers: respHeaders,
        bodyBase64: bytesToBase64(buf),
      };
    },

    async socketOpen(_opts: NativeSocketOpenRequest): Promise<void> {
      throw new MiniBookError('speech-unavailable', 'Native WebSocket bridge requires iOS or Android host');
    },

    async socketSend(_opts: NativeSocketSendRequest): Promise<void> {},

    async socketClose(_opts: NativeSocketCloseRequest): Promise<void> {},

    async speechVoices(): Promise<{ voices: Voice[] }> {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        return { voices: [] };
      }
      try {
        const raw = window.speechSynthesis.getVoices();
        return {
          voices: raw.map((v) => ({
            id: v.voiceURI || v.name,
            provider: 'system' as const,
            name: v.name,
            lang: v.lang || 'en-US',
            quality: v.localService ? ('enhanced' as const) : ('remote' as const),
            local: v.localService,
          })),
        };
      } catch {
        return { voices: [] };
      }
    },

    async speechLoad(session: SpeechSession): Promise<void> {
      speechState = {
        ...speechState,
        status: 'paused',
        bookId: session.bookId,
        rate: session.rate,
        voice: session.voice,
        usingFallback: false,
      };
      emit('speech-state', speechState);
    },

    async speechEnqueue(opts: NativeSpeechEnqueueRequest): Promise<void> {
      const first = opts.items[0];
      if (first && speechState.currentUtteranceId === null) {
        speechState = {
          ...speechState,
          currentUtteranceId: first.id,
          section: first.section,
          offset: first.start,
        };
      }
    },

    async speechAttachAudio(_opts: NativeSpeechAttachAudioRequest): Promise<void> {},

    async speechPlay(): Promise<void> {
      speechState = { ...speechState, status: 'playing' };
      emit('speech-state', speechState);
    },

    async speechPause(): Promise<void> {
      speechState = { ...speechState, status: 'paused' };
      emit('speech-state', speechState);
    },

    async speechStop(): Promise<void> {
      speechState = {
        ...speechState,
        status: 'idle',
        currentUtteranceId: null,
      };
      emit('speech-state', speechState);
      emit('speech-ended', { reason: 'stopped' });
    },

    async speechSeekTo(opts: { id: string }): Promise<void> {
      speechState = { ...speechState, currentUtteranceId: opts.id };
      emit('speech-state', speechState);
    },

    async speechSetRate(opts: { rate: number }): Promise<void> {
      speechState = { ...speechState, rate: opts.rate };
      emit('speech-state', speechState);
    },

    async speechSetVoice(opts: { voice: VoiceRef }): Promise<void> {
      speechState = { ...speechState, voice: opts.voice };
      emit('speech-state', speechState);
    },

    async speechSetSleepTimer(opts: SleepTimerConfig): Promise<void> {
      speechState = {
        ...speechState,
        sleepTimer: {
          mode: opts.mode,
          ...(opts.minutes !== undefined ? { remainingMs: opts.minutes * 60_000 } : {}),
        },
      };
      emit('sleep-timer', {
        mode: opts.mode,
        ...(opts.minutes !== undefined ? { remainingMs: opts.minutes * 60_000 } : {}),
      });
    },

    async speechGetState(): Promise<SpeechState> {
      return speechState;
    },

    async speechReadJournal(): Promise<{ checkpoint: SpeechJournalCheckpoint | null }> {
      return { checkpoint: null };
    },

    async speechCachePut(opts: NativeSpeechCachePutRequest): Promise<NativeSpeechCachePutResponse> {
      const bytes = base64ToBytes(opts.base64);
      const path = `speech-cache/${opts.key}.${opts.ext ?? 'mp3'}`;
      speechCache.set(path, bytes);
      return { path, bytes: bytes.byteLength };
    },

    async speechCacheClear(): Promise<void> {
      speechCache.clear();
    },

    async speechCacheSize(): Promise<{ bytes: number }> {
      let total = 0;
      for (const b of speechCache.values()) total += b.byteLength;
      return { bytes: total };
    },

    async modelStatus(_opts: { id: SpeechModelId }): Promise<SpeechModelStatus> {
      return modelStatusState;
    },

    async modelDownload(opts: NativeModelDownloadRequest): Promise<SpeechModelStatus> {
      const source = sourceLabelFromUrl(opts.sources[0]);
      const total = opts.files.reduce((sum, f) => sum + f.size, 0) || modelStatusState.bytesTotal;
      modelStatusState = {
        id: opts.id,
        state: 'downloading',
        variant: opts.variant,
        bytesDone: modelStatusState.bytesDone,
        bytesTotal: total,
        installedBytes: modelStatusState.installedBytes,
        installedVoices: modelStatusState.installedVoices,
        ...(source ? { source } : {}),
      };
      emit('speech-model', modelStatusState);
      return modelStatusState;
    },

    async modelPause(_opts: { id: SpeechModelId }): Promise<SpeechModelStatus> {
      if (modelStatusState.state === 'downloading' || modelStatusState.state === 'verifying') {
        modelStatusState = { ...modelStatusState, state: 'paused' };
        emit('speech-model', modelStatusState);
      }
      return modelStatusState;
    },

    async modelRemove(opts: { id: SpeechModelId }): Promise<void> {
      modelStatusState = {
        id: opts.id,
        state: 'absent',
        variant: modelStatusState.variant,
        bytesDone: 0,
        bytesTotal: modelStatusState.bytesTotal,
        installedBytes: 0,
        installedVoices: [],
      };
      emit('speech-model', modelStatusState);
    },

    async deviceInfo(): Promise<DeviceInfo> {
      return {
        eink: false,
        vendor: null,
        model: 'Web Preview',
        refresh: 'software',
        onDeviceNeuralSpeech: true,
      };
    },

    async deviceSetImmersive(_opts: { enabled: boolean }): Promise<void> {},

    async deviceSetKeepScreenOn(_opts: { enabled: boolean }): Promise<void> {},

    async deviceFullRefresh(): Promise<{ done: boolean }> {
      return { done: false };
    },

    async deviceSetKeyPolicy(_opts: KeyPolicy): Promise<void> {},

    async secretsSet(opts: { name: string; value: string | null }): Promise<void> {
      if (!opts.value) secrets.delete(opts.name);
      else secrets.set(opts.name, opts.value);
    },

    async secretsHas(opts: { name: string }): Promise<{ exists: boolean }> {
      return { exists: secrets.has(opts.name) };
    },

    async secretsRemove(opts: { name: string }): Promise<void> {
      secrets.delete(opts.name);
    },

    async openExternal(opts: { url: string }): Promise<void> {
      if (typeof window !== 'undefined' && typeof window.open === 'function') {
        window.open(opts.url, '_blank', 'noopener,noreferrer');
      }
    },

    async addListener<K extends keyof MiniBookPluginEventMap>(
      eventName: K,
      listenerFunc: (payload: MiniBookPluginEventMap[K]) => void,
    ): Promise<PluginListenerHandle> {
      let set = listeners.get(eventName);
      if (!set) {
        set = new Set();
        listeners.set(eventName, set);
      }
      const wrapped = listenerFunc as (payload: unknown) => void;
      set.add(wrapped);
      return {
        async remove(): Promise<void> {
          set?.delete(wrapped);
        },
      };
    },
  };
}
