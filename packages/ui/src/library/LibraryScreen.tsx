import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type ReactElement,
} from 'react';
import type { LibraryBook } from '@minibook/core';
import { useRouteStore } from '../app/routes';
import { IconButton } from '../components/IconButton';
import { Sheet } from '../components/Sheet';
import { GearIcon, PauseIcon, PlayIcon, PlusIcon } from '../components/icons';
import { PagedList } from '../eink/PagedList';
import { useHostContext } from '../host/HostContext';
import { useT } from '../i18n';
import { useReadAloudStore, type ReadAloudController } from '../speech/ReadAloudController';
import { CoverTile, ImportStatusTile } from './CoverTile';
import {
  formatBookFormatLabel,
  ImportController,
  useImportStore,
  type ImportTileItem,
} from './ImportController';

export interface LibraryScreenProps {
  readonly readAloud: ReadAloudController;
}

type ShelfGridCell =
  | { readonly kind: 'import'; readonly item: ImportTileItem }
  | { readonly kind: 'book'; readonly book: LibraryBook };

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatAddedDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

/**
 * Minimalist Apple Books-benchmarked Library (`PRODUCT_DESIGN.md` §4.1 & `UI_SPEC.md` §4.1):
 * - Sorted by last opened (`openedAt ?? addedAt`), no sort menus or tab bars.
 * - Search field appears ONLY when the shelf exceeds one screen (`books.length > oneScreenCapacity`).
 * - Backed by `PagedList` so E-Ink mode renders zero-scroll discrete pages (`‹ Prev · 1 / N · Next ›`).
 */
export function LibraryScreen({ readAloud }: LibraryScreenProps): ReactElement {
  const t = useT();
  const { host, settings, isEink, refreshController } = useHostContext();
  const screen = useRouteStore((s) => s.screen);
  const importItems = useImportStore((s) => s.items);
  const activeSheet = useRouteStore((s) => s.activeSheet);
  const infoBookId = useRouteStore((s) => s.infoBookId);

  const raActive = useReadAloudStore((s) => s.active);
  const raBookId = useReadAloudStore((s) => s.bookId);
  const raTitle = useReadAloudStore((s) => s.bookTitle);
  const raStatus = useReadAloudStore((s) => s.status);

  const [books, setBooks] = useState<LibraryBook[]>([]);
  const [query, setQuery] = useState('');
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth || 393 : 393,
    h: typeof window !== 'undefined' ? window.innerHeight || 852 : 852,
  }));

  const importer = useMemo(() => new ImportController(host), [host]);

  const reloadBooks = useCallback(async () => {
    try {
      const list = await host.library.list();
      setBooks(list);
    } catch {
      // preserve current shelf if host list fails transiently
    }
  }, [host]);

  useEffect(() => {
    void reloadBooks();
    const unsub = host.subscribe((e) => {
      if (e.type === 'library-changed') {
        void reloadBooks();
      }
    });
    return unsub;
  }, [host, reloadBooks]);

  useEffect(() => {
    if (screen === 'library') {
      void reloadBooks();
    }
  }, [screen, reloadBooks]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = (): void => {
      setViewportSize({ w: window.innerWidth || 393, h: window.innerHeight || 852 });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Compute how many cover tiles fit on one screen (`PRODUCT_DESIGN.md` §4.1)
  const { columns, oneScreenCapacity } = useMemo(() => {
    const w = viewportSize.w;
    const h = viewportSize.h;
    const cols = isEink
      ? w <= 520
        ? 3
        : 4
      : w >= 840
        ? Math.max(4, Math.floor((Math.min(w, 1200) - 48 + 28) / (144 + 28)))
        : Math.max(3, Math.floor((w - 48 + 20) / (104 + 20)));
    const rows = Math.max(2, Math.floor(Math.max(240, h - 150) / 225));
    return { columns: cols, oneScreenCapacity: cols * rows };
  }, [viewportSize.w, viewportSize.h, isEink]);

  const showSearch = books.length > oneScreenCapacity || query.trim().length > 0;

  const filteredBooks = useMemo(() => {
    const q = query.trim().normalize('NFKC').toLowerCase();
    if (!q) return books;
    return books.filter((b) => {
      const authors = Array.isArray(b.authors) ? b.authors : [];
      const hay = `${b.title ?? ''} ${authors.join(' ')}`.normalize('NFKC').toLowerCase();
      return hay.includes(q);
    });
  }, [books, query]);

  const cells = useMemo<ShelfGridCell[]>(() => {
    const list: ShelfGridCell[] = [];
    for (const item of importItems) {
      list.push({ kind: 'import', item });
    }
    for (const book of filteredBooks) {
      list.push({ kind: 'book', book });
    }
    return list;
  }, [importItems, filteredBooks]);

  const handleOpenBook = (bookId: string): void => {
    readAloud.onBookOpened(bookId);
    void host.library.markOpened?.(bookId, Date.now());
    useRouteStore.getState().openBook(bookId);
  };

  const handleDrop = (e: DragEvent<HTMLElement>): void => {
    e.preventDefault();
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      void importer.importDroppedFiles(e.dataTransfer.files, isEink, () => {
        void reloadBooks();
      });
    }
  };

  const infoBook = infoBookId ? books.find((b) => b.id === infoBookId) ?? null : null;

  return (
    <main
      className="mb-library"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      <div className="mb-library-inner">
        <header className="mb-library-header">
          <h1 className="mb-library-title">{t('library')}</h1>
          <div className="mb-library-actions">
            {host.info.capabilities.filePicker && (
              <IconButton
                label={t('addBooks')}
                onClick={() => {
                  void importer.pickAndImport(isEink, () => {
                    void reloadBooks();
                  });
                }}
              >
                <PlusIcon />
              </IconButton>
            )}
            <IconButton
              label={t('settings')}
              onClick={() => useRouteStore.getState().openSettings()}
            >
              <GearIcon />
            </IconButton>
          </div>
        </header>

        {showSearch && (
          <div className="mb-library-search-wrap">
            <input
              type="text"
              role="searchbox"
              className="mb-input"
              placeholder={t('searchBooks')}
              aria-label={t('searchBooks')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}

        {cells.length === 0 ? (
          <section className="mb-empty-state" aria-label={t('library')}>
            <p className="mb-empty-desc">
              {host.info.platform === 'desktop'
                ? t('emptyLibraryDesktop')
                : t('emptyLibraryMobile')}
            </p>
            {host.info.capabilities.filePicker && (
              <button
                type="button"
                className="mb-primary-btn"
                onClick={() => {
                  void importer.pickAndImport(isEink, () => {
                    void reloadBooks();
                  });
                }}
              >
                {t('addBooks')}
              </button>
            )}
          </section>
        ) : (
          <PagedList
            items={cells}
            isEink={isEink}
            layer="screen"
            columns={columns}
            estimatedItemHeight={235}
            fallbackPageSize={columns * 3}
            resetKey={query.trim()}
            prevLabel={t('prevPage')}
            nextLabel={t('nextPage')}
            ariaLabel={t('library')}
            onPageTurn={(swap) => {
              void refreshController.runTurn({
                isEink,
                cadence: settings.fullRefreshEvery,
                swap,
              });
            }}
            renderItems={(visible) => (
              <section className="mb-cover-grid" aria-label={t('library')}>
                {visible.map((cell) =>
                  cell.kind === 'import' ? (
                    <ImportStatusTile
                      key={cell.item.key}
                      item={cell.item}
                      onDismiss={(k) => useImportStore.getState().remove(k)}
                    />
                  ) : (
                    <CoverTile
                      key={cell.book.id}
                      book={cell.book}
                      coverUrl={host.library.coverUrl(cell.book.id)}
                      isEink={isEink}
                      onOpen={handleOpenBook}
                      onContextAction={(id) => {
                        setConfirmRemoveId(null);
                        useRouteStore.getState().openSheet('book-info', { infoBookId: id });
                      }}
                    />
                  ),
                )}
              </section>
            )}
          />
        )}
      </div>

      {/* 1-Line Persistent Mini Read-Aloud Bar when listening in Library (`PRODUCT_DESIGN.md` §6) */}
      {screen === 'library' && raActive && raBookId && (
        <footer className="mb-mini-bar" aria-label={t('readAloud')}>
          <IconButton
            label={raStatus === 'playing' || raStatus === 'buffering' ? t('pause') : t('play')}
            onClick={() => readAloud.togglePlayPause()}
          >
            {raStatus === 'playing' || raStatus === 'buffering' ? <PauseIcon /> : <PlayIcon />}
          </IconButton>
          <button
            type="button"
            className="mb-mini-bar-label"
            onClick={() => useRouteStore.getState().openBook(raBookId)}
          >
            {t('miniBarTapToReturn', { title: raTitle })}
          </button>
        </footer>
      )}

      {/* Book Info / Mark as Finished / Remove Sheet (`UI_SPEC.md` §4.1) */}
      <Sheet
        open={screen === 'library' && activeSheet === 'book-info' && infoBook !== null}
        label={t('bookInfo')}
        onClose={(coveredHalf) => {
          useRouteStore.getState().closeSheetWithRefresh(coveredHalf, () => {
            setConfirmRemoveId(null);
          });
        }}
      >
        {infoBook && (
          <>
            <div className="mb-sheet-row">
              <div>
                <div style={{ fontWeight: 600 }}>{infoBook.title}</div>
                {infoBook.authors.length > 0 && (
                  <div className="mb-list-row-meta">{infoBook.authors.join(', ')}</div>
                )}
                <div className="mb-list-row-meta">
                  {formatBookFormatLabel(infoBook.format)} · {formatBytes(infoBook.size)}
                  {infoBook.addedAt ? ` · ${formatAddedDate(infoBook.addedAt)}` : ''}
                </div>
              </div>
            </div>

            <button
              type="button"
              className="mb-list-row"
              onClick={() => {
                void host.library.setFinished(infoBook.id, !infoBook.finished).then(() => {
                  useRouteStore.getState().closeSheetWithRefresh();
                  void reloadBooks();
                });
              }}
            >
              <span>{infoBook.finished ? t('markUnread') : t('markFinished')}</span>
            </button>

            {confirmRemoveId === infoBook.id ? (
              <div className="mb-sheet-row">
                <button
                  type="button"
                  className="mb-icon-btn mb-danger-text"
                  onClick={() => {
                    if (raActive && raBookId === infoBook.id) {
                      readAloud.stop();
                    }
                    void host.library.remove(infoBook.id).then(() => {
                      useRouteStore.getState().closeSheetWithRefresh(undefined, () => {
                        setConfirmRemoveId(null);
                      });
                      void reloadBooks();
                    });
                  }}
                >
                  {t('removeConfirm')}
                </button>
                <button
                  type="button"
                  className="mb-icon-btn"
                  onClick={() => setConfirmRemoveId(null)}
                >
                  {t('cancel')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="mb-list-row mb-danger-text"
                onClick={() => setConfirmRemoveId(infoBook.id)}
              >
                <span>{t('removeBook')}</span>
              </button>
            )}
          </>
        )}
      </Sheet>
    </main>
  );
}
