/**
 * Browser `PlatformHost` client speaking REST + HTTP 206 Range + SSE (`/api/*`)
 * to the `@minibook/host-node` loopback server (`ARCHITECTURE.md` §3.1, §3.3, §12).
 */
import {
  MiniBookError,
  computeSpeechCacheKey,
  type AppSettings,
  type BookId,
  type Bookmark,
  type BookmarkInput,
  type ByteSource,
  type HostEvent,
  type HostInfo,
  type ImportSource,
  type ImportTicket,
  type InspectedBook,
  type KeyPolicy,
  type LibraryBook,
  type LibraryBookDetail,
  type ModelDownloadSource,
  type PlatformHost,
  type RemoteSpeechEngineId,
  type SavedPosition,
  type SpeechModelBackend,
  type SpeechModelStatus,
  type StorageUsage,
  type SynthRequest,
  type SynthResult,
  type Unsubscribe,
  type Voice,
} from '@minibook/core';
import {
  ROUTES,
  type BeginImportResponseWire,
  type CommitImportRequestWire,
  type LibraryBookDetailWire,
} from '../shared/routes.js';
import { bytesToBase64 } from './base64.js';
import {
  createBrowserFileByteSource,
  createHttpRangeByteSource,
  inferDerivedTextSizeFromIndex,
} from './byte-source.js';
import { HostEventStream } from './events.js';
import { RestJsonClient, type RestClientConfig } from './http.js';
import { KokoroWebEngine, type KokoroWorkerLike } from './kokoro/kokoro-web-engine.js';

const UPLOAD_CHUNK_BYTES = 1024 * 1024;

export interface CreateRestPlatformHostOptions extends RestClientConfig {
  readonly initialInfo?: HostInfo;
  readonly enableSse?: boolean;
  readonly kokoroWorkerFactory?: () => KokoroWorkerLike;
}

async function readAllFromByteSource(src: ByteSource): Promise<Uint8Array> {
  if (src.readAll) {
    return src.readAll();
  }
  const total = src.size;
  if (total <= 0) return new Uint8Array(0);
  const out = new Uint8Array(total);
  let offset = 0;
  while (offset < total) {
    const ask = Math.min(UPLOAD_CHUNK_BYTES, total - offset);
    const chunk = await src.read(offset, ask);
    if (chunk.byteLength === 0) break;
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return offset === out.byteLength ? out : out.subarray(0, offset);
}

export function createRestPlatformHost(options?: CreateRestPlatformHostOptions): PlatformHost {
  const client = new RestJsonClient(options);
  const events = new HostEventStream({
    url: client.resolveUrl(ROUTES.events.path),
    ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    enabled: options?.enableSse ?? true,
  });

  const bookSizes = new Map<BookId, number>();
  const bookHasCover = new Map<BookId, boolean>();
  const derivedTextSizes = new Map<BookId, number>();

  let currentInfo: HostInfo = options?.initialInfo ?? {
    platform: 'desktop',
    appVersion: '0.2.4',
    capabilities: {
      nativeSpeechQueue: false,
      volumeKeyPaging: false,
      vendorRefresh: false,
      einkDetected: false,
      filePicker: true,
      openWith: true,
      onDeviceNeuralSpeech: true,
    },
    device: {
      eink: false,
      vendor: null,
      model: null,
      refresh: 'software',
    },
  };

  let lastKnownBackend: SpeechModelBackend | undefined;
  let lastKnownRtf: number | undefined;
  let lastSelfTestError: MiniBookError | null = null;
  let activeModelVariant: 'onnx-fp32' | 'onnx-q8' | null = null;
  let lastKnownPrecision: 'q8' | 'fp32' | undefined;
  const localModelListeners = new Set<(event: HostEvent) => void>();

  const kokoroEngine = new KokoroWebEngine({
    baseUrl: client.baseUrl,
    ...(options?.kokoroWorkerFactory ? { workerFactory: options.kokoroWorkerFactory } : {}),
    onTelemetry: ({ backend, rtf }) => {
      lastKnownBackend = backend;
      if (rtf !== undefined) lastKnownRtf = rtf;
      void modelsApi
        .status('kokoro-v1.1-zh')
        .then((s) => {
          for (const l of localModelListeners) {
            try {
              l({ type: 'speech-model', status: s });
            } catch {
              // ignore
            }
          }
        })
        .catch(() => undefined);
    },
    onSelfTestError: (err) => {
      lastSelfTestError = err;
      void modelsApi
        .status('kokoro-v1.1-zh')
        .then((s) => {
          for (const l of localModelListeners) {
            try {
              l({ type: 'speech-model', status: s });
            } catch {
              // ignore
            }
          }
        })
        .catch(() => undefined);
    },
  });

  function enrichModelStatus(status: SpeechModelStatus): SpeechModelStatus {
    if (
      status.state === 'ready' &&
      (status.variant === 'onnx-q8' || status.variant === 'onnx-fp32')
    ) {
      activeModelVariant = status.variant;
    }
    return {
      ...status,
      ...(lastKnownBackend !== undefined && !status.backend ? { backend: lastKnownBackend } : {}),
      ...(lastKnownRtf !== undefined && status.rtf === undefined ? { rtf: lastKnownRtf } : {}),
      ...(lastSelfTestError && status.state === 'ready'
        ? { state: 'error' as const, error: lastSelfTestError.toShape() }
        : {}),
    };
  }

  if (!options?.initialInfo) {
    void client
      .request<HostInfo>(ROUTES.info.method, ROUTES.info.path)
      .then((fetched) => {
        currentInfo = fetched;
      })
      .catch(() => undefined);
  }

  function rememberBook(book: LibraryBook, derivedSize?: number): void {
    bookSizes.set(book.id, book.size);
    bookHasCover.set(book.id, book.hasCover);
    if (derivedSize !== undefined && derivedSize > 0) {
      derivedTextSizes.set(book.id, derivedSize);
    }
  }

  const modelsApi = {
    async status(id: 'kokoro-v1.1-zh') {
      const s = await client.request<SpeechModelStatus>('GET', `/api/models/${encodeURIComponent(id)}`);
      return enrichModelStatus(s);
    },
    async download(
      id: 'kokoro-v1.1-zh',
      opts?: {
        readonly voices?: readonly string[];
        readonly variant?: 'onnx-fp32' | 'onnx-q8' | 'coreml';
        readonly source?: ModelDownloadSource;
        readonly mirrorBaseUrl?: string | null;
      },
    ) {
      lastSelfTestError = null;
      const effectiveVariant: 'onnx-fp32' | 'onnx-q8' =
        opts?.variant === 'onnx-q8'
          ? 'onnx-q8'
          : opts?.variant === 'onnx-fp32'
            ? 'onnx-fp32'
            : lastKnownPrecision === 'q8'
              ? 'onnx-q8'
              : 'onnx-fp32';
      const s = await client.request<SpeechModelStatus>(
        'POST',
        `/api/models/${encodeURIComponent(id)}/download`,
        {
          body: {
            variant: effectiveVariant,
            ...(opts?.voices ? { voices: opts.voices } : {}),
            ...(opts?.source !== undefined ? { source: opts.source } : {}),
            ...(opts?.mirrorBaseUrl !== undefined ? { mirrorBaseUrl: opts.mirrorBaseUrl } : {}),
          },
        },
      );
      return enrichModelStatus(s);
    },
    async pause(id: 'kokoro-v1.1-zh') {
      const s = await client.request<SpeechModelStatus>(
        'POST',
        `/api/models/${encodeURIComponent(id)}/pause`,
      );
      return enrichModelStatus(s);
    },
    async remove(id: 'kokoro-v1.1-zh') {
      kokoroEngine.dispose();
      activeModelVariant = null;
      lastKnownBackend = undefined;
      lastKnownRtf = undefined;
      lastSelfTestError = null;
      await client.request<null>('DELETE', `/api/models/${encodeURIComponent(id)}`);
    },
  };

  return {
    get info(): HostInfo {
      return currentInfo;
    },
    models: modelsApi,

    library: {
      async list(): Promise<LibraryBook[]> {
        const list = await client.request<LibraryBook[]>(
          ROUTES.libraryList.method,
          ROUTES.libraryList.path,
        );
        for (const b of list) {
          rememberBook(b);
        }
        return list;
      },

      async get(id: BookId): Promise<LibraryBookDetail | null> {
        const detail = await client.request<LibraryBookDetailWire | null>(
          ROUTES.libraryGet.method,
          `/api/library/${encodeURIComponent(id)}`,
        );
        if (!detail) return null;
        const derivedSize =
          detail.derivedTextSize && detail.derivedTextSize > 0
            ? detail.derivedTextSize
            : inferDerivedTextSizeFromIndex(detail.index);
        rememberBook(detail, derivedSize);
        return detail;
      },

      async beginImport(src: ImportSource): Promise<ImportTicket> {
        const rawBytes = await readAllFromByteSource(src.bytes);
        const res = await client.request<BeginImportResponseWire>(
          ROUTES.booksUpload.method,
          ROUTES.booksUpload.path,
          {
            query: { name: src.name },
            rawBody: rawBytes,
            contentType: 'application/octet-stream',
          },
        );

        let derivedAccum = 0;
        return {
          ticketId: res.ticketId,
          bookId: res.bookId,
          async putDerived(name: string, chunk: Uint8Array): Promise<void> {
            const out = await client.request<{ readonly bytes: number }>(
              ROUTES.booksTicketDerived.method,
              `/api/books/tickets/${encodeURIComponent(res.ticketId)}/derived`,
              {
                query: { name },
                rawBody: chunk,
                contentType: 'application/octet-stream',
              },
            );
            derivedAccum = out.bytes;
            if (res.bookId) {
              derivedTextSizes.set(res.bookId, derivedAccum);
            }
          },
          async abort(): Promise<void> {
            await client
              .request<null>(
                ROUTES.booksTicketAbort.method,
                `/api/books/tickets/${encodeURIComponent(res.ticketId)}`,
              )
              .catch(() => undefined);
          },
        };
      },

      async commitImport(ticket: ImportTicket, inspected: InspectedBook): Promise<LibraryBook> {
        const payload: CommitImportRequestWire = {
          ...(ticket.bookId ? { bookId: ticket.bookId } : {}),
          meta: inspected.meta,
          index: inspected.index,
          cover: inspected.cover
            ? {
                mime: inspected.cover.mime,
                base64: bytesToBase64(inspected.cover.bytes),
              }
            : null,
        };
        const book = await client.request<LibraryBook>(
          ROUTES.booksTicketCommit.method,
          `/api/books/tickets/${encodeURIComponent(ticket.ticketId)}/commit`,
          { body: payload },
        );
        const derivedSize =
          derivedTextSizes.get(book.id) ?? inferDerivedTextSizeFromIndex(inspected.index);
        rememberBook(book, derivedSize);
        return book;
      },

      async remove(id: BookId): Promise<void> {
        await client.request<null>(
          ROUTES.libraryRemove.method,
          `/api/library/${encodeURIComponent(id)}`,
        );
        bookSizes.delete(id);
        bookHasCover.delete(id);
        derivedTextSizes.delete(id);
      },

      async setFinished(id: BookId, finished: boolean): Promise<void> {
        await client.request<null>(
          ROUTES.librarySetFinished.method,
          `/api/library/${encodeURIComponent(id)}/finished`,
          { body: { finished } },
        );
      },

      async markOpened(id: BookId, openedAt?: number): Promise<void> {
        await client.request<null>(
          ROUTES.libraryMarkOpened.method,
          `/api/library/${encodeURIComponent(id)}/opened`,
          { body: openedAt !== undefined ? { openedAt } : {} },
        );
      },

      async shareFile(id: BookId): Promise<void> {
        const downloadUrl = client.resolveUrl(`/api/books/${encodeURIComponent(id)}/download`);
        if (typeof document !== 'undefined') {
          const a = document.createElement('a');
          a.href = downloadUrl;
          a.download = '';
          a.rel = 'noopener';
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          a.remove();
          return;
        }
        const fetchFn = options?.fetchImpl ?? fetch;
        const res = await fetchFn(downloadUrl, { method: 'HEAD' });
        if (!res.ok) {
          throw new MiniBookError('not-found', `Download failed (${res.status}) for ${id}`);
        }
      },

      coverUrl(id: BookId): string | null {
        if (bookHasCover.get(id) === false) return null;
        return client.resolveUrl(`/api/books/${encodeURIComponent(id)}/cover`);
      },
    },

    files: {
      async pickBooks(): Promise<ImportSource[]> {
        if (typeof document === 'undefined') {
          throw new MiniBookError('unsupported', 'File picker requires a browser document');
        }
        return new Promise<ImportSource[]>((resolvePromise) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.multiple = true;
          input.accept = '.epub,.azw3,.azw,.mobi,.prc,.fb2,.zip,.txt,.md,.markdown';
          input.style.display = 'none';
          document.body.appendChild(input);

          let settled = false;
          const finish = (files: FileList | null) => {
            if (settled) return;
            settled = true;
            input.remove();
            if (!files || files.length === 0) {
              resolvePromise([]);
              return;
            }
            const sources: ImportSource[] = [];
            for (let i = 0; i < files.length; i++) {
              const file = files.item(i);
              if (!file) continue;
              sources.push({
                name: file.name,
                size: file.size,
                bytes: createBrowserFileByteSource(file),
              });
            }
            resolvePromise(sources);
          };

          input.addEventListener('change', () => finish(input.files), { once: true });
          input.addEventListener('cancel', () => finish(null), { once: true });
          input.click();
        });
      },

      byteSource(bookId: BookId, part: 'book' | 'text' = 'book'): ByteSource {
        const size =
          part === 'text' ? (derivedTextSizes.get(bookId) ?? 0) : (bookSizes.get(bookId) ?? 0);
        const url = client.resolveUrl(
          `/api/books/${encodeURIComponent(bookId)}/file`,
          part === 'text' ? { part: 'text' } : undefined,
        );
        return createHttpRangeByteSource({
          url,
          size,
          fetchImpl: client.fetchImpl,
        });
      },

      async openExternal(url: string): Promise<void> {
        await client.request<null>(ROUTES.filesOpenExternal.method, ROUTES.filesOpenExternal.path, {
          body: { url },
        });
      },
    },

    state: {
      getPosition(bookId: BookId): Promise<SavedPosition | null> {
        return client.request<SavedPosition | null>(
          ROUTES.stateGetPosition.method,
          `/api/books/${encodeURIComponent(bookId)}/position`,
        );
      },

      async savePosition(bookId: BookId, pos: SavedPosition): Promise<void> {
        await client.request<null>(
          ROUTES.stateSavePosition.method,
          `/api/books/${encodeURIComponent(bookId)}/position`,
          { body: pos },
        );
      },

      listBookmarks(bookId: BookId): Promise<Bookmark[]> {
        return client.request<Bookmark[]>(
          ROUTES.stateListBookmarks.method,
          `/api/books/${encodeURIComponent(bookId)}/bookmarks`,
        );
      },

      addBookmark(bookId: BookId, bookmark: BookmarkInput): Promise<Bookmark> {
        return client.request<Bookmark>(
          ROUTES.stateAddBookmark.method,
          `/api/books/${encodeURIComponent(bookId)}/bookmarks`,
          { body: bookmark },
        );
      },

      async removeBookmark(bookId: BookId, bookmarkId: string): Promise<void> {
        await client.request<null>(
          ROUTES.stateRemoveBookmark.method,
          `/api/books/${encodeURIComponent(bookId)}/bookmarks/${encodeURIComponent(bookmarkId)}`,
        );
      },
    },

    settings: {
      async get(): Promise<AppSettings> {
        const s = await client.request<AppSettings>(ROUTES.settingsGet.method, ROUTES.settingsGet.path);
        lastKnownPrecision = s.kokoroPrecision;
        return s;
      },

      async update(patch: Partial<AppSettings>): Promise<AppSettings> {
        const s = await client.request<AppSettings>(
          ROUTES.settingsUpdate.method,
          ROUTES.settingsUpdate.path,
          { body: patch },
        );
        lastKnownPrecision = s.kokoroPrecision;
        if (patch && 'kokoroPrecision' in patch) {
          await modelsApi.status('kokoro-v1.1-zh').catch(() => undefined);
        }
        return s;
      },

      async setSecret(name: string, value: string | null): Promise<void> {
        await client.request<null>(
          ROUTES.secretsSet.method,
          `/api/secrets/${encodeURIComponent(name)}`,
          { body: { value } },
        );
      },

      async hasSecret(name: string): Promise<boolean> {
        const res = await client.request<{ readonly exists: boolean }>(
          ROUTES.secretsHas.method,
          `/api/secrets/${encodeURIComponent(name)}`,
        );
        return Boolean(res.exists);
      },

      storageUsage(): Promise<StorageUsage> {
        return client.request<StorageUsage>(ROUTES.storageUsage.method, ROUTES.storageUsage.path);
      },
    },

    speech: {
      async synthesize(req: SynthRequest, signal?: AbortSignal): Promise<SynthResult> {
        if (req.engine === 'kokoro') {
          if (!req.phonemeIds || req.phonemeIds.length === 0) {
            throw new MiniBookError('invalid-argument', 'Kokoro synthesis requires phonemeIds');
          }
          const desiredVariant =
            lastKnownPrecision === 'q8'
              ? 'onnx-q8'
              : lastKnownPrecision === 'fp32'
                ? 'onnx-fp32'
                : null;
          if (
            activeModelVariant === null ||
            (desiredVariant !== null && activeModelVariant !== desiredVariant)
          ) {
            await modelsApi.status('kokoro-v1.1-zh').catch(() => undefined);
          }
          const variant: 'onnx-fp32' | 'onnx-q8' = activeModelVariant ?? 'onnx-fp32';
          const key = await computeSpeechCacheKey({
            engine: 'kokoro',
            voiceId: req.voiceId,
            variant,
            text: req.text,
          });
          const audioPath = `/api/speech/audio/${key}`;
          const audioUrl = client.resolveUrl(audioPath);
          try {
            const headResp = await client.fetchImpl(audioUrl, {
              method: 'HEAD',
              ...(signal ? { signal } : {}),
            });
            if (headResp.ok) {
              const len = Number.parseInt(headResp.headers.get('content-length') ?? '0', 10);
              return {
                ref: audioUrl,
                mime: headResp.headers.get('content-type') || 'audio/wav',
                synthMs: 0,
                bytes: Number.isFinite(len) ? len : 0,
                cached: true,
              };
            }
          } catch (err) {
            if (signal?.aborted) {
              throw MiniBookError.wrap(err, 'cancelled');
            }
          }

          const out = await kokoroEngine.synthesize(
            {
              voiceId: req.voiceId,
              variant,
              text: req.text,
              phonemeIds: req.phonemeIds,
              ...(req.phonemeSpeeds !== undefined ? { phonemeSpeeds: req.phonemeSpeeds } : {}),
              ...(req.phonemeSpans !== undefined ? { phonemeSpans: req.phonemeSpans } : {}),
            },
            signal,
          );

          const cached = await client.request<SynthResult>(
            ROUTES.speechCachePut.method,
            ROUTES.speechCachePut.path,
            {
              body: {
                key,
                mime: 'audio/wav',
                durationMs: out.durationMs,
                ...(out.marks.length > 0 ? { marks: out.marks } : {}),
                audioBase64: bytesToBase64(out.wav),
              },
              ...(signal ? { signal } : {}),
            },
          );
          const resolvedRef =
            cached.ref.startsWith('/') && client.baseUrl
              ? `${client.baseUrl}${cached.ref}`
              : cached.ref;
          return {
            ...cached,
            ref: resolvedRef,
            synthMs: out.synthMs,
            cached: false,
          };
        }

        const res = await client.request<SynthResult>(
          ROUTES.speechSynthesize.method,
          ROUTES.speechSynthesize.path,
          {
            body: req,
            ...(signal ? { signal } : {}),
          },
        );
        const resolvedRef =
          res.ref.startsWith('/') && client.baseUrl ? `${client.baseUrl}${res.ref}` : res.ref;
        return { ...res, ref: resolvedRef };
      },

      listRemoteVoices(engine: RemoteSpeechEngineId): Promise<Voice[]> {
        return client.request<Voice[]>(ROUTES.speechVoices.method, ROUTES.speechVoices.path, {
          query: { engine },
        });
      },

      async clearCache(): Promise<void> {
        await client.request<null>(ROUTES.speechCacheClear.method, ROUTES.speechCacheClear.path);
      },

      async cacheSize(): Promise<number> {
        const res = await client.request<{ readonly bytes: number }>(
          ROUTES.speechCacheSize.method,
          ROUTES.speechCacheSize.path,
        );
        return res.bytes;
      },

      models: modelsApi,
    },

    device: {
      async setImmersive(_enabled: boolean): Promise<void> {
        // Desktop browser does not hide OS status bars
      },
      async setKeepScreenOn(_enabled: boolean): Promise<void> {
        // Handled cleanly; WakeLock API optional on desktop
      },
      async fullRefresh(): Promise<boolean> {
        // Desktop uses software flash overlay
        return false;
      },
      async setKeyPolicy(_policy: KeyPolicy): Promise<void> {
        // Volume keys are Android-only
      },
    },

    subscribe(listener: (event: HostEvent) => void): Unsubscribe {
      localModelListeners.add(listener);
      const unsubSse = events.subscribe((ev) => {
        if (ev.type === 'speech-model') {
          listener({ type: 'speech-model', status: enrichModelStatus(ev.status) });
        } else {
          listener(ev);
        }
      });
      return () => {
        localModelListeners.delete(listener);
        unsubSse();
      };
    },
  };
}
