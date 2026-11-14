/**
 * Node desktop host context assembling `node:sqlite`, atomic book file storage,
 * secret store, speech synthesis proxy, SSE event broadcaster, and CLI book importer.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  MiniBookError,
  computeBookId,
  inspectBook,
  type HostEvent,
  type HostInfo,
  type InspectedBook,
  type LibraryBook,
  type Unsubscribe,
} from '@minibook/core';
import { BooksRepository, SettingsRepository, StateRepository } from '../db/repositories/index.js';
import { openDatabase, type Database } from '../db/sqlite.js';
import { ModelStore, type ModelStoreOptions } from '../models/model-store.js';
import { FileSecretStore } from '../settings/secrets.js';
import { SpeechAudioCache } from '../speech/audio-cache.js';
import { SynthService, type EdgeProviderLike, type OpenAiProviderLike } from '../speech/synth-service.js';
import {
  BookFileStorage,
  canonicalBookExtension,
  createNodeFileByteSource,
} from './storage.js';

export interface NodeHostOptions {
  readonly dataDir?: string;
  readonly dbPath?: string;
  readonly appVersion?: string;
  readonly edgeProvider?: EdgeProviderLike;
  readonly openAiProvider?: OpenAiProviderLike;
  readonly fetchImpl?: typeof fetch;
  readonly openExternalImpl?: (url: string) => Promise<void>;
  readonly modelStoreOptions?: Partial<Omit<ModelStoreOptions, 'dataDir' | 'getSettings' | 'emit'>>;
}

export interface NodeHostContext {
  readonly info: HostInfo;
  readonly dataDir: string;
  readonly db: Database;
  readonly booksRepo: BooksRepository;
  readonly stateRepo: StateRepository;
  readonly settingsRepo: SettingsRepository;
  readonly secrets: FileSecretStore;
  readonly storage: BookFileStorage;
  readonly synth: SynthService;
  readonly models: ModelStore;
  emit(event: HostEvent): void;
  subscribe(listener: (event: HostEvent) => void): Unsubscribe;
  recordSecretName(name: string, hasValue: boolean): void;
  openExternal(url: string): Promise<void>;
  importLocalFile(
    filePath: string,
    options?: {
      readonly displayName?: string;
      readonly inspectImpl?: typeof inspectBook;
    },
  ): Promise<LibraryBook>;
  commitStagedBook(
    ticketId: string,
    inspected: InspectedBook,
    overrideBookId?: string,
  ): LibraryBook;
  dispose(): Promise<void>;
}

export function defaultDataDir(): string {
  const envDir = process.env['MINIBOOK_DATA_DIR'];
  if (envDir && envDir.trim()) {
    return resolve(envDir.trim());
  }
  return join(homedir(), '.minibook');
}

async function defaultOpenExternal(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new MiniBookError('invalid-argument', `Invalid external URL: ${rawUrl}`);
  }
  if (
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'https:' &&
    parsed.protocol !== 'mailto:'
  ) {
    throw new MiniBookError('invalid-argument', `Disallowed external URL scheme: ${parsed.protocol}`);
  }

  const href = parsed.toString();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const platform = process.platform;
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = platform === 'win32' ? ['/c', 'start', '', href] : [href];
    execFile(cmd, args, (err) => {
      if (err) {
        rejectPromise(new MiniBookError('unsupported', `Failed to open external URL: ${err.message}`));
      } else {
        resolvePromise();
      }
    });
  });
}

export function createNodeHostContext(options?: NodeHostOptions): NodeHostContext {
  const dataDir = options?.dataDir ? resolve(options.dataDir) : defaultDataDir();
  const dbPath = options?.dbPath ?? join(dataDir, 'minibook.sqlite');
  const db = openDatabase(dbPath);

  const booksRepo = new BooksRepository(db);
  const stateRepo = new StateRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const secrets = new FileSecretStore(dataDir);
  const storage = new BookFileStorage(dataDir);
  const audioCache = new SpeechAudioCache(db, dataDir);

  let lastSecretName: string | null = null;
  const listeners = new Set<(event: HostEvent) => void>();

  const synth = new SynthService({
    getSettings: () => settingsRepo.get(),
    secrets,
    cache: audioCache,
    getLastSecretName: () => lastSecretName,
    ...(options?.edgeProvider ? { edgeProvider: options.edgeProvider } : {}),
    ...(options?.openAiProvider ? { openAiProvider: options.openAiProvider } : {}),
  });

  const info: HostInfo = {
    platform: 'desktop',
    appVersion: options?.appVersion ?? '0.2.3',
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

  function emit(event: HostEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // isolate subscriber errors
      }
    }
  }

  const models = new ModelStore({
    dataDir,
    getSettings: () => settingsRepo.get(),
    emit,
    ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options?.modelStoreOptions ?? {}),
  });

  function commitStagedBook(
    ticketId: string,
    inspected: InspectedBook,
    overrideBookId?: string,
  ): LibraryBook {
    const staged = storage.getTicket(ticketId);
    const bookId = overrideBookId ?? staged.bookId;
    const fileExt = canonicalBookExtension(staged.fileName, inspected.meta.format);
    const { derivedTextSize } = storage.commitTicket({
      ticketId,
      bookId,
      fileExt,
      cover: inspected.cover,
    });

    const { book } = booksRepo.insertIfAbsent({
      id: bookId,
      title: inspected.meta.title || staged.fileName,
      authors: inspected.meta.authors,
      language: inspected.meta.language,
      format: inspected.meta.format,
      fileName: staged.fileName,
      fileExt,
      size: staged.size,
      derivedTextSize,
      hasCover: inspected.cover !== null && inspected.cover.bytes.byteLength > 0,
      coverMime: inspected.cover?.mime ?? null,
      addedAt: Date.now(),
      index: inspected.index,
    });

    emit({ type: 'library-changed', bookId: book.id });
    return book;
  }

  async function importLocalFile(
    filePath: string,
    importOpts?: {
      readonly displayName?: string;
      readonly inspectImpl?: typeof inspectBook;
    },
  ): Promise<LibraryBook> {
    const staged = storage.stageLocalFileCopy(filePath, importOpts?.displayName);
    try {
      const byteSource = createNodeFileByteSource(staged.stagedFilePath);
      let bookId = staged.bookId;
      try {
        bookId = await computeBookId(byteSource);
      } catch {
        // Scaffold fallback when computeBookId is a stub on main
      }
      const inspectFn = importOpts?.inspectImpl ?? inspectBook;
      const inspected = await inspectFn(byteSource, {
        fileName: staged.fileName,
        async putDerived(name: string, chunk: Uint8Array): Promise<void> {
          storage.appendDerived(staged.ticketId, name, chunk);
        },
      });
      return commitStagedBook(staged.ticketId, inspected, bookId);
    } catch (err) {
      storage.abortTicket(staged.ticketId);
      throw err;
    }
  }

  let closed = false;

  return {
    info,
    dataDir,
    db,
    booksRepo,
    stateRepo,
    settingsRepo,
    secrets,
    storage,
    synth,
    models,
    emit,
    subscribe(listener: (event: HostEvent) => void): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    recordSecretName(name: string, hasValue: boolean): void {
      if (hasValue) {
        lastSecretName = name;
      } else if (lastSecretName === name) {
        lastSecretName = null;
      }
    },
    openExternal: options?.openExternalImpl ?? defaultOpenExternal,
    importLocalFile,
    commitStagedBook,
    async dispose(): Promise<void> {
      if (closed) return;
      closed = true;
      listeners.clear();
      try {
        db.close();
      } catch {
        // ignore double close
      }
    },
  };
}
