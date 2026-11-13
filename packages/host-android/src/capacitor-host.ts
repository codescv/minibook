/**
 * Capacitor `PlatformHost` implementation shared by Android (`dev.minibook.app`) and
 * iOS (`com.google.experimental.chii.minibook`) (`ARCHITECTURE.md` §3, §3.2, §3.3, §7.2, §8.4, §9, §10).
 */
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import {
  EdgeSpeechProvider,
  MiniBookError,
  OpenAiSpeechProvider,
  computeBookId,
  computeSpeechCacheKey,
  type AppSettings,
  type BookId,
  type Bookmark,
  type BookmarkInput,
  type ByteSource,
  type DeviceInfo,
  type EdgeSynthOutput,
  type HostEvent,
  type HostInfo,
  type HostPlatform,
  type ImportSource,
  type ImportTicket,
  type InspectedBook,
  type KeyPolicy,
  type LibraryBook,
  type LibraryBookDetail,
  type OpenAiSynthOutput,
  type PlatformHost,
  type SavedPosition,
  type StorageUsage,
  type SynthRequest,
  type SynthResult,
  type Unsubscribe,
  type Voice,
  type WordMark,
} from '@minibook/core';
import {
  createDefaultMiniBookPlugin,
  type MiniBookPlugin,
  type NativePickedFile,
} from './plugin-types.js';
import {
  createPluginHttpTransport,
  createPluginSocketTransport,
} from './speech/plugin-transports.js';
import { FileLibraryStore } from './storage/FileLibraryStore.js';
import { PluginByteSource } from './storage/PluginByteSource.js';
import { base64ToBytes, bytesToBase64 } from './storage/base64.js';

export const CAPACITOR_HOST_VERSION = '0.1.0';

const SPEECH_CACHE_INDEX_PATH = 'speech-cache-index.json';
const SPEECH_CACHE_SOFT_CAP_BYTES = 180 * 1024 * 1024; // < 200 MB native cap

const SECRET_CANDIDATES = [
  'custom-speech-key',
  'custom-speech-api-key',
  'openai-api-key',
  'openai',
  'customSpeechKey',
  'customSpeechApiKey',
  'speech-api-key',
] as const;

export interface CapacitorHostOptions {
  readonly plugin?: MiniBookPlugin;
  readonly platform?: 'android' | 'ios';
  readonly appVersion?: string;
  readonly fetchImpl?: typeof fetch | null;
  readonly edgeProvider?: {
    synthesize(
      req: { readonly voiceId: string; readonly text: string; readonly lang?: string },
      signal?: AbortSignal,
    ): Promise<EdgeSynthOutput>;
    listVoices(signal?: AbortSignal): Promise<Voice[]>;
  };
  readonly openAiProvider?: {
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
  };
}

interface InternalTicket extends ImportTicket {
  readonly tempPath: string;
  readonly fileName: string;
  readonly stagedDerivedPath: string;
  derivedBytes: number;
}

interface CachedAudioMeta {
  readonly path: string;
  readonly mime: string;
  readonly bytes: number;
  readonly durationMs?: number;
  readonly marks?: readonly WordMark[];
  readonly lastUsed: number;
}

function detectCapacitorPlatform(explicit?: 'android' | 'ios'): HostPlatform {
  if (explicit) return explicit;
  try {
    const p = Capacitor.getPlatform();
    if (p === 'ios') return 'ios';
  } catch {
    // default to android
  }
  return 'android';
}

async function computeFallbackSha1BookId(src: ByteSource): Promise<BookId> {
  try {
    return await computeBookId(src);
  } catch {
    const sample = 256 * 1024;
    const headLen = Math.min(src.size, sample);
    const tailStart = Math.max(0, src.size - sample);
    const tailLen = src.size - tailStart;
    const head = headLen > 0 ? await src.read(0, headLen) : new Uint8Array(0);
    const tail = tailLen > 0 ? await src.read(tailStart, tailLen) : new Uint8Array(0);
    const sizeBytes = new Uint8Array(8);
    const dv = new DataView(sizeBytes.buffer);
    dv.setUint32(0, Math.floor(src.size / 0x100000000), false);
    dv.setUint32(4, src.size >>> 0, false);
    const combined = new Uint8Array(8 + head.byteLength + tail.byteLength);
    combined.set(sizeBytes, 0);
    combined.set(head, 8);
    combined.set(tail, 8 + head.byteLength);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', combined));
    let hex = '';
    for (let i = 0; i < digest.length; i++) {
      hex += digest[i]!.toString(16).padStart(2, '0');
    }
    return `b_${hex}`;
  }
}

export function createCapacitorPlatformHost(options?: CapacitorHostOptions): PlatformHost {
  const plugin = options?.plugin ?? createDefaultMiniBookPlugin();
  const platform = detectCapacitorPlatform(options?.platform);
  const store = new FileLibraryStore(plugin);

  let deviceInfo: DeviceInfo = {
    eink: false,
    vendor: null,
    model: null,
    refresh: 'software',
  };

  let hostInfo: HostInfo = {
    platform,
    appVersion: options?.appVersion ?? CAPACITOR_HOST_VERSION,
    capabilities: {
      nativeSpeechQueue: true,
      volumeKeyPaging: platform === 'android',
      vendorRefresh: false,
      einkDetected: false,
      filePicker: true,
      openWith: true,
    },
    device: deviceInfo,
  };

  const listeners = new Set<(event: HostEvent) => void>();
  const tickets = new Map<string, InternalTicket>();
  const audioCacheIndex = new Map<string, CachedAudioMeta>();
  const synthFlights = new Map<string, Promise<SynthResult>>();
  const seenIncomingTempPaths = new Set<string>();
  let cacheIndexLoaded: Promise<void> | null = null;
  let ticketCounter = 0;
  let lastSecretName: string | null = null;
  let nativeListenersAttached = false;
  const nativeHandles: PluginListenerHandle[] = [];

  const httpTransport = createPluginHttpTransport(plugin);
  const socketTransport = createPluginSocketTransport(plugin);
  const edgeProvider =
    options?.edgeProvider ?? new EdgeSpeechProvider({ socket: socketTransport, http: httpTransport });
  const openAiProvider = options?.openAiProvider ?? new OpenAiSpeechProvider({ http: httpTransport });

  function emit(event: HostEvent): void {
    for (const l of listeners) {
      try {
        l(event);
      } catch {
        // isolate subscriber errors
      }
    }
  }

  function emitDedupedIncomingFiles(files: readonly NativePickedFile[]): void {
    const fresh: NativePickedFile[] = [];
    for (const f of files) {
      if (!f.tempPath) continue;
      if (seenIncomingTempPaths.has(f.tempPath)) continue;
      seenIncomingTempPaths.add(f.tempPath);
      fresh.push(f);
    }
    if (fresh.length > 0) {
      emit({ type: 'incoming-file', files: fresh });
    }
  }

  async function ensureSpeechCacheIndexLoaded(): Promise<void> {
    if (cacheIndexLoaded) return cacheIndexLoaded;
    cacheIndexLoaded = (async () => {
      try {
        const diskBytes = await plugin.speech.cacheSize();
        if (diskBytes <= 0) {
          // OS purged <caches>/speech/ or cache is empty -> reset sidecar
          await plugin.fs.remove({ path: SPEECH_CACHE_INDEX_PATH }).catch(() => undefined);
          return;
        }
        const st = await plugin.fs.stat({ path: SPEECH_CACHE_INDEX_PATH });
        if (!st.exists || !st.size || st.size <= 0 || st.size > 1024 * 1024) return;
        const res = await plugin.fs.read({
          path: SPEECH_CACHE_INDEX_PATH,
          offset: 0,
          length: st.size,
        });
        const parsed = JSON.parse(
          new TextDecoder().decode(base64ToBytes(res.base64)),
        ) as Record<string, CachedAudioMeta>;
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed)) {
            if (v && typeof v.path === 'string' && typeof v.bytes === 'number') {
              audioCacheIndex.set(k, v);
            }
          }
        }
      } catch {
        // ignore missing or corrupt cache index sidecar
      }
    })();
    return cacheIndexLoaded;
  }

  async function persistSpeechCacheIndex(): Promise<void> {
    let total = 0;
    for (const entry of audioCacheIndex.values()) {
      total += entry.bytes;
    }
    if (total > SPEECH_CACHE_SOFT_CAP_BYTES) {
      const sorted = [...audioCacheIndex.entries()].sort(
        (a, b) => a[1].lastUsed - b[1].lastUsed,
      );
      for (const [k, v] of sorted) {
        if (total <= SPEECH_CACHE_SOFT_CAP_BYTES) break;
        audioCacheIndex.delete(k);
        total -= v.bytes;
      }
    }
    const obj: Record<string, CachedAudioMeta> = {};
    for (const [k, v] of audioCacheIndex.entries()) {
      obj[k] = v;
    }
    await plugin.fs
      .writeAtomic({
        path: SPEECH_CACHE_INDEX_PATH,
        text: JSON.stringify(obj),
      })
      .catch(() => undefined);
  }

  // Probe native device info asynchronously at startup (`EinkDetector` on Android)
  void plugin.device
    .info()
    .then((fetched) => {
      deviceInfo = fetched;
      hostInfo = {
        ...hostInfo,
        capabilities: {
          ...hostInfo.capabilities,
          einkDetected: fetched.eink,
          vendorRefresh: fetched.refresh === 'vendor',
        },
        device: fetched,
      };
      emit({ type: 'device-changed', device: fetched });
    })
    .catch(() => undefined);

  async function attachNativeEventsIfNeeded(): Promise<void> {
    if (nativeListenersAttached) return;
    nativeListenersAttached = true;
    try {
      nativeHandles.push(
        await plugin.addListener('hardware-key', (ev) => {
          emit({ type: 'hardware-key', key: ev.key });
        }),
      );
      nativeHandles.push(
        await plugin.addListener('incoming-file', (ev) => {
          if (ev.files && ev.files.length > 0) {
            emitDedupedIncomingFiles(ev.files);
          }
        }),
      );
      const pending = await plugin.import.consumePending().catch(() => []);
      if (pending.length > 0) {
        emitDedupedIncomingFiles(pending);
      }
    } catch {
      nativeListenersAttached = false;
    }
  }

  function pickedFileToImportSource(picked: NativePickedFile): ImportSource {
    return {
      name: picked.name,
      size: picked.size,
      sourceRef: picked.tempPath,
      bytes: new PluginByteSource({
        plugin,
        path: picked.tempPath,
        size: picked.size,
        ...(options?.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      }),
    };
  }

  async function resolveSpeechSecretHeader(): Promise<string | undefined> {
    if (lastSecretName && (await plugin.secrets.has({ name: lastSecretName }))) {
      return `Bearer {{secret:${lastSecretName}}}`;
    }
    for (const candidate of SECRET_CANDIDATES) {
      if (await plugin.secrets.has({ name: candidate })) {
        return `Bearer {{secret:${candidate}}}`;
      }
    }
    return undefined;
  }

  async function reconcileNativeJournal(bookId: BookId): Promise<void> {
    try {
      const checkpoint = await plugin.speech.readJournal();
      if (!checkpoint || checkpoint.bookId !== bookId) return;
      const existing = await store.getPosition(bookId);
      if (!existing || checkpoint.wallMs > existing.updatedAt) {
        await store.savePosition(bookId, {
          section: checkpoint.section,
          offset: checkpoint.offset,
          fraction: existing?.fraction ?? 0,
          snippet: existing?.snippet ?? '',
          updatedAt: checkpoint.wallMs,
        });
      }
    } catch {
      // ignore journal read error
    }
  }

  return {
    get info(): HostInfo {
      return hostInfo;
    },

    library: {
      list(): Promise<LibraryBook[]> {
        return store.list();
      },

      get(id: BookId): Promise<LibraryBookDetail | null> {
        return store.get(id);
      },

      async beginImport(src: ImportSource): Promise<ImportTicket> {
        const ticketId = `cap_ticket_${++ticketCounter}_${Date.now()}`;
        let tempPath = src.sourceRef;

        if (!tempPath) {
          tempPath = `tmp/stage_${ticketId}.bin`;
          let pos = 0;
          while (pos < src.size) {
            const ask = Math.min(1024 * 1024, src.size - pos);
            const chunk = await src.bytes.read(pos, ask);
            if (chunk.byteLength === 0) break;
            await plugin.fs.append({ path: tempPath, base64: bytesToBase64(chunk) });
            pos += chunk.byteLength;
          }
        }

        const bookId = await computeFallbackSha1BookId(src.bytes);
        const stagedDerivedPath = `tmp/derived_${ticketId}_text.bin`;

        const ticket: InternalTicket = {
          ticketId,
          bookId,
          tempPath,
          fileName: src.name,
          stagedDerivedPath,
          derivedBytes: 0,
          async putDerived(name: string, chunk: Uint8Array): Promise<void> {
            if (name !== 'text.bin') {
              throw new MiniBookError('invalid-argument', `Unsupported derived file: ${name}`);
            }
            if (chunk.byteLength === 0) return;
            await plugin.fs.append({
              path: stagedDerivedPath,
              base64: bytesToBase64(chunk),
            });
            ticket.derivedBytes += chunk.byteLength;
          },
          async abort(): Promise<void> {
            tickets.delete(ticketId);
            await plugin.fs.remove({ path: tempPath! }).catch(() => undefined);
            await plugin.fs.remove({ path: stagedDerivedPath }).catch(() => undefined);
          },
        };

        tickets.set(ticketId, ticket);
        return ticket;
      },

      async commitImport(ticket: ImportTicket, inspected: InspectedBook): Promise<LibraryBook> {
        const internal = tickets.get(ticket.ticketId);
        if (!internal) {
          throw new MiniBookError('not-found', `Import ticket not found: ${ticket.ticketId}`);
        }
        tickets.delete(ticket.ticketId);

        const book = await store.commitImport({
          bookId:
            internal.bookId ??
            (await computeFallbackSha1BookId(
              new PluginByteSource({
                plugin,
                path: internal.tempPath,
                size: 0,
                ...(options?.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
              }),
            )),
          tempPath: internal.tempPath,
          fileName: internal.fileName,
          stagedDerivedPath: internal.derivedBytes > 0 ? internal.stagedDerivedPath : null,
          derivedTextSize: internal.derivedBytes,
          inspected,
        });

        emit({ type: 'library-changed', bookId: book.id });
        return book;
      },

      async remove(id: BookId): Promise<void> {
        await store.remove(id);
        emit({ type: 'library-changed', bookId: id });
      },

      async setFinished(id: BookId, finished: boolean): Promise<void> {
        await store.setFinished(id, finished);
        emit({ type: 'library-changed', bookId: id });
      },

      async markOpened(id: BookId, openedAt?: number): Promise<void> {
        await store.markOpened(id, openedAt);
      },

      coverUrl(id: BookId): string | null {
        return store.coverUrl(id);
      },
    },

    files: {
      async pickBooks(): Promise<ImportSource[]> {
        const picked = await plugin.import.pick({ multiple: true });
        return picked.map(pickedFileToImportSource);
      },

      byteSource(bookId: BookId, part: 'book' | 'text' = 'book'): ByteSource {
        const cached = store.getCachedPaths(bookId);
        if (!cached) {
          throw new MiniBookError(
            'not-found',
            `Book paths not loaded for ${bookId} (call library.get or library.list first)`,
          );
        }
        const path = part === 'text' ? cached.derivedPath : cached.bookPath;
        const size = part === 'text' ? cached.derivedSize : cached.size;
        return new PluginByteSource({
          plugin,
          path,
          size,
          ...(options?.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
        });
      },

      async openExternal(url: string): Promise<void> {
        await plugin.openExternal({ url });
      },
    },

    state: {
      async getPosition(bookId: BookId): Promise<SavedPosition | null> {
        await reconcileNativeJournal(bookId);
        return store.getPosition(bookId);
      },

      savePosition(bookId: BookId, pos: SavedPosition): Promise<void> {
        return store.savePosition(bookId, pos);
      },

      listBookmarks(bookId: BookId): Promise<Bookmark[]> {
        return store.listBookmarks(bookId);
      },

      addBookmark(bookId: BookId, bookmark: BookmarkInput): Promise<Bookmark> {
        return store.addBookmark(bookId, bookmark);
      },

      removeBookmark(bookId: BookId, bookmarkId: string): Promise<void> {
        return store.removeBookmark(bookId, bookmarkId);
      },
    },

    settings: {
      get(): Promise<AppSettings> {
        return store.getSettings();
      },

      update(patch: Partial<AppSettings>): Promise<AppSettings> {
        return store.updateSettings(patch);
      },

      async setSecret(name: string, value: string | null): Promise<void> {
        if (value === null || value.length === 0) {
          await plugin.secrets.remove({ name });
          if (lastSecretName === name) lastSecretName = null;
        } else {
          await plugin.secrets.set({ name, value });
          lastSecretName = name;
        }
      },

      hasSecret(name: string): Promise<boolean> {
        return plugin.secrets.has({ name });
      },

      async storageUsage(): Promise<StorageUsage> {
        const [booksBytes, speechCacheBytes] = await Promise.all([
          store.booksStorageBytes(),
          plugin.speech.cacheSize(),
        ]);
        return { booksBytes, speechCacheBytes };
      },
    },

    speech: {
      async synthesize(req: SynthRequest, signal?: AbortSignal): Promise<SynthResult> {
        await ensureSpeechCacheIndexLoaded();
        const settings = await store.getSettings();
        const effectiveModel =
          req.engine === 'openai'
            ? (req.model ?? settings.customSpeechServer?.model ?? 'tts-1')
            : req.model;
        const key = await computeSpeechCacheKey({
          engine: req.engine,
          voiceId: req.voiceId,
          ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
          text: req.text,
        });

        const hit = audioCacheIndex.get(key);
        if (hit && (await plugin.speech.cacheSize()) > 0) {
          audioCacheIndex.set(key, { ...hit, lastUsed: Date.now() });
          return {
            ref: hit.path,
            mime: hit.mime,
            ...(hit.durationMs !== undefined ? { durationMs: hit.durationMs } : {}),
            ...(hit.marks !== undefined ? { marks: hit.marks } : {}),
            synthMs: 0,
            bytes: hit.bytes,
            cached: true,
          };
        }

        const existingFlight = synthFlights.get(key);
        if (existingFlight) {
          return existingFlight;
        }

        const flight = (async (): Promise<SynthResult> => {
          const t0 = Date.now();
          if (req.engine === 'edge') {
            const out = await edgeProvider.synthesize(
              {
                voiceId: req.voiceId,
                text: req.text,
                ...(req.lang ? { lang: req.lang } : {}),
              },
              signal,
            );
            const synthMs = Math.max(1, Date.now() - t0);
            const saved = await plugin.speech.cachePut({
              key,
              base64: bytesToBase64(out.audio),
              ext: 'mp3',
            });
            const entry: CachedAudioMeta = {
              path: saved.path,
              mime: out.mime,
              bytes: saved.bytes,
              ...(out.durationMs !== undefined ? { durationMs: out.durationMs } : {}),
              marks: out.marks,
              lastUsed: Date.now(),
            };
            audioCacheIndex.set(key, entry);
            await persistSpeechCacheIndex();
            return {
              ref: saved.path,
              mime: out.mime,
              ...(out.durationMs !== undefined ? { durationMs: out.durationMs } : {}),
              marks: out.marks,
              synthMs,
              bytes: saved.bytes,
              cached: false,
            };
          }

          const baseUrl = req.baseUrl ?? settings.customSpeechServer?.baseUrl;
          if (!baseUrl || !baseUrl.trim()) {
            throw new MiniBookError(
              'speech-unavailable',
              'Custom speech server URL is not configured',
            );
          }
          const apiKeyHeader = await resolveSpeechSecretHeader();
          const out = await openAiProvider.synthesize(
            {
              baseUrl: baseUrl.trim(),
              model: effectiveModel ?? 'tts-1',
              voiceId: req.voiceId,
              text: req.text,
              ...(apiKeyHeader !== undefined ? { apiKeyHeader } : {}),
              timeoutMs: 30_000,
            },
            signal,
          );
          const synthMs = Math.max(1, Date.now() - t0);
          const ext = out.mime === 'audio/wav' ? 'wav' : 'mp3';
          const saved = await plugin.speech.cachePut({
            key,
            base64: bytesToBase64(out.audio),
            ext,
          });
          const entry: CachedAudioMeta = {
            path: saved.path,
            mime: out.mime,
            bytes: saved.bytes,
            ...(out.durationMs !== undefined ? { durationMs: out.durationMs } : {}),
            lastUsed: Date.now(),
          };
          audioCacheIndex.set(key, entry);
          await persistSpeechCacheIndex();
          return {
            ref: saved.path,
            mime: out.mime,
            ...(out.durationMs !== undefined ? { durationMs: out.durationMs } : {}),
            synthMs,
            bytes: saved.bytes,
            cached: false,
          };
        })().finally(() => {
          synthFlights.delete(key);
        });

        synthFlights.set(key, flight);
        return flight;
      },

      async listRemoteVoices(engine: 'edge' | 'openai'): Promise<Voice[]> {
        if (engine === 'edge') {
          return edgeProvider.listVoices();
        }
        const settings = await store.getSettings();
        const baseUrl = settings.customSpeechServer?.baseUrl?.trim();
        if (!baseUrl) return [];
        const apiKeyHeader = await resolveSpeechSecretHeader();
        return openAiProvider.listVoices({
          baseUrl,
          ...(apiKeyHeader !== undefined ? { apiKeyHeader } : {}),
        });
      },

      async clearCache(): Promise<void> {
        audioCacheIndex.clear();
        await Promise.all([
          plugin.speech.cacheClear(),
          plugin.fs.remove({ path: SPEECH_CACHE_INDEX_PATH }).catch(() => undefined),
        ]);
      },

      cacheSize(): Promise<number> {
        return plugin.speech.cacheSize();
      },
    },

    device: {
      setImmersive(enabled: boolean): Promise<void> {
        return plugin.device.setImmersive({ enabled });
      },

      setKeepScreenOn(enabled: boolean): Promise<void> {
        const effective = deviceInfo.eink ? false : enabled;
        return plugin.device.setKeepScreenOn({ enabled: effective });
      },

      async fullRefresh(): Promise<boolean> {
        const res = await plugin.device.fullRefresh();
        return Boolean(res?.done);
      },

      setKeyPolicy(policy: KeyPolicy): Promise<void> {
        if (platform !== 'android') return Promise.resolve();
        return plugin.device.setKeyPolicy(policy);
      },
    },

    subscribe(listener: (event: HostEvent) => void): Unsubscribe {
      listeners.add(listener);
      void attachNativeEventsIfNeeded();
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
