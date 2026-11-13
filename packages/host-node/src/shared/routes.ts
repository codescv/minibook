/**
 * Exhaustive typed REST route table shared between `@minibook/host-node` server and browser client
 * (`ARCHITECTURE.md` §3.1, §12, §14).
 */
import type {
  AppSettings,
  BookId,
  BookIndex,
  BookMeta,
  Bookmark,
  BookmarkInput,
  HostInfo,
  LibraryBook,
  LibraryBookDetail,
  RemoteSpeechEngineId,
  SavedPosition,
  SpeechModelId,
  SpeechModelStatus,
  SpeechModelVariant,
  StorageUsage,
  SynthRequest,
  SynthResult,
  Voice,
  WordMark,
} from '@minibook/core';

export type RouteHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteSpec<TReq = void, TRes = void> {
  readonly method: RouteHttpMethod;
  readonly path: string;
  readonly kind: 'json' | 'binary' | 'sse';
  readonly _req?: TReq;
  readonly _res?: TRes;
}

function jsonRoute<TReq = void, TRes = void>(
  method: RouteHttpMethod,
  path: string,
): RouteSpec<TReq, TRes> {
  return { method, path, kind: 'json' };
}

function binaryRoute<TReq = void, TRes = void>(
  method: RouteHttpMethod,
  path: string,
): RouteSpec<TReq, TRes> {
  return { method, path, kind: 'binary' };
}

export interface BeginImportResponseWire {
  readonly ticketId: string;
  readonly bookId: BookId;
  readonly size: number;
}

export interface CommitImportRequestWire {
  readonly bookId?: BookId;
  readonly meta: BookMeta;
  readonly index: BookIndex;
  readonly cover: {
    readonly mime: string;
    readonly base64: string;
  } | null;
}

export interface LibraryBookDetailWire extends LibraryBookDetail {
  readonly derivedTextSize?: number;
}

export const ROUTES = {
  info: jsonRoute<void, HostInfo>('GET', '/api/info'),

  // Library
  libraryList: jsonRoute<void, readonly LibraryBook[]>('GET', '/api/library'),
  libraryGet: jsonRoute<{ readonly id: BookId }, LibraryBookDetailWire | null>(
    'GET',
    '/api/library/:id',
  ),
  libraryRemove: jsonRoute<{ readonly id: BookId }, null>('DELETE', '/api/library/:id'),
  librarySetFinished: jsonRoute<{ readonly finished: boolean }, null>(
    'POST',
    '/api/library/:id/finished',
  ),
  libraryMarkOpened: jsonRoute<{ readonly openedAt?: number }, null>(
    'POST',
    '/api/library/:id/opened',
  ),

  // Book binary upload, derived streams, commit, Range serving & cover
  booksUpload: binaryRoute<Uint8Array, BeginImportResponseWire>('POST', '/api/books'),
  booksTicketDerived: binaryRoute<Uint8Array, { readonly bytes: number }>(
    'POST',
    '/api/books/tickets/:ticketId/derived',
  ),
  booksTicketCommit: jsonRoute<CommitImportRequestWire, LibraryBook>(
    'POST',
    '/api/books/tickets/:ticketId/commit',
  ),
  booksTicketAbort: jsonRoute<void, null>('DELETE', '/api/books/tickets/:ticketId'),
  booksFile: binaryRoute<void, Uint8Array>('GET', '/api/books/:id/file'),
  booksCover: binaryRoute<void, Uint8Array>('GET', '/api/books/:id/cover'),

  // Reading state (position + bookmarks)
  stateGetPosition: jsonRoute<void, SavedPosition | null>('GET', '/api/books/:id/position'),
  stateSavePosition: jsonRoute<SavedPosition, null>('PUT', '/api/books/:id/position'),
  stateListBookmarks: jsonRoute<void, readonly Bookmark[]>('GET', '/api/books/:id/bookmarks'),
  stateAddBookmark: jsonRoute<BookmarkInput, Bookmark>('POST', '/api/books/:id/bookmarks'),
  stateRemoveBookmark: jsonRoute<void, null>('DELETE', '/api/books/:id/bookmarks/:bookmarkId'),

  // Settings, secrets & storage
  settingsGet: jsonRoute<void, AppSettings>('GET', '/api/settings'),
  settingsUpdate: jsonRoute<Partial<AppSettings>, AppSettings>('PATCH', '/api/settings'),
  secretsSet: jsonRoute<{ readonly value: string | null }, null>('PUT', '/api/secrets/:name'),
  secretsHas: jsonRoute<void, { readonly exists: boolean }>('GET', '/api/secrets/:name'),
  storageUsage: jsonRoute<void, StorageUsage>('GET', '/api/storage/usage'),

  // External links
  filesOpenExternal: jsonRoute<{ readonly url: string }, null>('POST', '/api/files/open-external'),

  // Speech synthesis proxy & disk cache
  speechSynthesize: jsonRoute<SynthRequest, SynthResult>('POST', '/api/speech/synthesize'),
  speechVoices: jsonRoute<{ readonly engine: RemoteSpeechEngineId }, readonly Voice[]>(
    'GET',
    '/api/speech/voices',
  ),
  speechAudio: binaryRoute<void, Uint8Array>('GET', '/api/speech/audio/:key'),
  speechCachePut: jsonRoute<
    {
      readonly key: string;
      readonly mime: string;
      readonly durationMs?: number;
      readonly marks?: readonly WordMark[];
      readonly audioBase64: string;
    },
    SynthResult
  >('POST', '/api/speech/cache'),
  speechCacheClear: jsonRoute<void, null>('DELETE', '/api/speech/cache'),
  speechCacheSize: jsonRoute<void, { readonly bytes: number }>('GET', '/api/speech/cache/size'),

  // On-device neural speech models
  modelStatus: jsonRoute<void, SpeechModelStatus>('GET', '/api/models/:id'),
  modelDownload: jsonRoute<
    { readonly variant?: SpeechModelVariant; readonly voices?: readonly string[] },
    SpeechModelStatus
  >('POST', '/api/models/:id/download'),
  modelPause: jsonRoute<void, SpeechModelStatus>('POST', '/api/models/:id/pause'),
  modelRemove: jsonRoute<void, null>('DELETE', '/api/models/:id'),
  modelFile: binaryRoute<void, Uint8Array>('GET', '/api/models/:id/file/*'),

  // SSE event stream
  events: { method: 'GET', path: '/api/events', kind: 'sse' } as RouteSpec<void, void>,
} as const;

export type RouteName = keyof typeof ROUTES;
