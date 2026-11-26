import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { Bookmark, BookSession, Locator, SearchHit, TocItem } from '@minibook/core';
import { useRouteStore, type ContentsTab } from '../../app/routes';
import { IconButton } from '../../components/IconButton';
import { Segmented } from '../../components/Segmented';
import { Sheet } from '../../components/Sheet';
import { CloseIcon } from '../../components/icons';
import { PagedList } from '../../eink/PagedList';
import {
  ensureSectionCharLength,
  fractionForSessionLocator,
  getKnownSectionCharLength,
  getSessionCharLengthRevision,
  searchBookSafe,
} from '../../host/core-bridge';
import { useHostContext } from '../../host/HostContext';
import { useT } from '../../i18n';

export interface ContentsSheetProps {
  readonly open: boolean;
  readonly session: BookSession | null;
  readonly currentSection: number;
  readonly bookmarks: readonly Bookmark[];
  readonly onSelectLocator: (locator: Locator, searchHighlightLen?: number) => void;
  readonly onRemoveBookmark: (id: string) => void;
  readonly onClose: (coveredHalf: boolean) => void;
}

interface FlatTocRow {
  readonly key: string;
  readonly title: string;
  readonly locator: Locator;
  readonly depth: number;
  readonly percent: number;
  readonly isCurrent: boolean;
}

function collectAnchoredTocSections(items: readonly TocItem[], out: Set<number>): void {
  for (const item of items) {
    if (item.locator.offset > 0) {
      out.add(item.locator.section);
    }
    if (item.children.length > 0) {
      collectAnchoredTocSections(item.children, out);
    }
  }
}

function flattenToc(
  items: readonly TocItem[],
  session: BookSession,
  currentSection: number,
  depth = 0,
  acc: FlatTocRow[] = [],
): FlatTocRow[] {
  items.forEach((item, idx) => {
    const pct = Math.max(
      0,
      Math.min(100, Math.round(fractionForSessionLocator(session, item.locator) * 100)),
    );
    acc.push({
      key: `${depth}-${idx}-${item.locator.section}:${item.locator.offset}`,
      title: item.title,
      locator: item.locator,
      depth,
      percent: pct,
      isCurrent: item.locator.section === currentSection,
    });
    if (item.children.length > 0) {
      flattenToc(item.children, session, currentSection, depth + 1, acc);
    }
  });
  return acc;
}

function renderBoldMatch(snippet: string, query: string): ReactElement {
  const q = query.trim();
  if (!q) return <span>{snippet}</span>;
  const idx = snippet.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return <span>{snippet}</span>;
  return (
    <span>
      {snippet.slice(0, idx)}
      <strong>{snippet.slice(idx, idx + q.length)}</strong>
      {snippet.slice(idx + q.length)}
    </span>
  );
}

/**
 * 3-Segment `Contents · Bookmarks · Search` Sheet (`PRODUCT_DESIGN.md` §4.5 & `UI_SPEC.md` §4.5).
 * Every list is backed by `PagedList` so E-Ink mode stays strictly zero-scroll and packs real
 * measured rows per screen while using exact counted-char section lengths for `%` labels (`[P1-F1]`).
 */
export function ContentsSheet({
  open,
  session,
  currentSection,
  bookmarks,
  onSelectLocator,
  onRemoveBookmark,
  onClose,
}: ContentsSheetProps): ReactElement | null {
  const t = useT();
  const { isEink, settings, refreshController } = useHostContext();
  const tab = useRouteStore((s) => s.contentsTab);
  const setTab = useRouteStore((s) => s.setContentsTab);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [charLenVersion, setCharLenVersion] = useState<number>(0);

  const handlePageTurn = (swap: () => void): void => {
    void refreshController.runTurn({
      isEink,
      cadence: settings.fullRefreshEvery,
      swap,
    });
  };

  // Ensure exact counted-character lengths are known for any section with mid-section TOC anchors (`offset > 0`)
  useEffect(() => {
    if (!open || !session || session.toc.length === 0) return;
    const needed = new Set<number>();
    collectAnchoredTocSections(session.toc, needed);
    const missing = [...needed].filter((sec) => getKnownSectionCharLength(session, sec) === undefined);
    if (missing.length === 0) return;

    let cancelled = false;
    void Promise.all(missing.map((sec) => ensureSectionCharLength(session, sec)))
      .then(() => {
        if (!cancelled) {
          setCharLenVersion((v) => v + 1);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, session]);

  const sessionLenRev = getSessionCharLengthRevision(session);

  const tocRows = useMemo(() => {
    void charLenVersion;
    void sessionLenRev;
    if (!session) return [];
    if (session.toc.length > 0) {
      return flattenToc(session.toc, session, currentSection);
    }
    return session.spine
      .filter((s) => s.linear)
      .map((s, idx): FlatTocRow => ({
        key: `part-${s.index}`,
        title: s.title || `Part ${idx + 1}`,
        locator: { section: s.index, offset: 0 },
        depth: 0,
        percent: Math.round(fractionForSessionLocator(session, { section: s.index, offset: 0 }) * 100),
        isCurrent: s.index === currentSection,
      }));
  }, [open, session, currentSection, charLenVersion, sessionLenRev]);

  useEffect(() => {
    if (!open || tab !== 'search' || !session) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setHits([]);
      return;
    }

    const ctl = new AbortController();
    setHits([]);

    void (async () => {
      const collected: SearchHit[] = [];
      for await (const hit of searchBookSafe(session, trimmed, { signal: ctl.signal })) {
        if (ctl.signal.aborted) return;
        await ensureSectionCharLength(session, hit.locator.section);
        if (ctl.signal.aborted) return;
        collected.push(hit);
        if (collected.length <= 100) {
          setHits([...collected]);
        } else {
          break;
        }
      }
    })();

    return () => ctl.abort();
  }, [open, tab, session, query]);

  return (
    <Sheet open={open} label={t('contents')} listSheet onClose={onClose}>
      <Segmented<ContentsTab>
        label={t('contents')}
        value={tab}
        options={[
          { value: 'contents', label: t('contents') },
          { value: 'bookmarks', label: t('bookmarks') },
          { value: 'search', label: t('search') },
        ]}
        onChange={setTab}
      />

      {tab === 'contents' && (
        <PagedList
          items={tocRows}
          isEink={isEink}
          layer="sheet"
          estimatedItemHeight={46}
          fallbackPageSize={8}
          resetKey="contents"
          prevLabel={t('prevPage')}
          nextLabel={t('nextPage')}
          onPageTurn={handlePageTurn}
          renderItems={(visible) => (
            <div role="list" aria-label={t('contents')}>
              {visible.map((row) => (
                <button
                  key={row.key}
                  type="button"
                  className="mb-list-row"
                  data-current={row.isCurrent ? 'true' : undefined}
                  style={{ paddingLeft: `${row.depth * 16}px` }}
                  onClick={() => {
                    onSelectLocator(row.locator);
                  }}
                >
                  <span>
                    {row.isCurrent ? '▸ ' : ''}
                    {row.title}
                  </span>
                  <span className="mb-list-row-meta">{row.percent}%</span>
                </button>
              ))}
            </div>
          )}
        />
      )}

      {tab === 'bookmarks' && (
        bookmarks.length === 0 ? (
          <div className="mb-sheet-row">
            <span className="mb-list-row-meta">{t('noBookmarks')}</span>
          </div>
        ) : (
          <PagedList
            items={bookmarks}
            isEink={isEink}
            layer="sheet"
            estimatedItemHeight={56}
            fallbackPageSize={6}
            resetKey="bookmarks"
            prevLabel={t('prevPage')}
            nextLabel={t('nextPage')}
            onPageTurn={handlePageTurn}
            renderItems={(visible) => (
              <div role="list" aria-label={t('bookmarks')}>
                {visible.map((bm) => (
                  <div key={bm.id} className="mb-sheet-row">
                    <button
                      type="button"
                      className="mb-list-row"
                      style={{ borderBottom: 'none' }}
                      onClick={() => {
                        onSelectLocator({ section: bm.section, offset: bm.offset });
                      }}
                    >
                      <div>
                        <div className="mb-list-row-meta">
                          {Math.round(bm.fraction * 100)}%
                        </div>
                        <div>{bm.label}</div>
                      </div>
                    </button>
                    <IconButton
                      label={t('deleteBookmark')}
                      onClick={() => onRemoveBookmark(bm.id)}
                    >
                      <CloseIcon />
                    </IconButton>
                  </div>
                ))}
              </div>
            )}
          />
        )
      )}

      {tab === 'search' && (
        <>
          <input
            type="text"
            role="searchbox"
            className="mb-input"
            placeholder={t('searchInBook')}
            aria-label={t('searchInBook')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />

          {query.trim().length > 0 && hits.length === 0 ? (
            <div className="mb-sheet-row">
              <span className="mb-list-row-meta">{t('noResults')}</span>
            </div>
          ) : (
            <PagedList
              items={hits}
              isEink={isEink}
              layer="sheet"
              estimatedItemHeight={56}
              fallbackPageSize={6}
              resetKey={query.trim()}
              prevLabel={t('prevPage')}
              nextLabel={t('nextPage')}
              onPageTurn={handlePageTurn}
              renderItems={(visible) => (
                <div role="list" aria-label={t('search')}>
                  {visible.map((hit, i) => {
                    const pct = session
                      ? Math.round(fractionForSessionLocator(session, hit.locator) * 100)
                      : 0;
                    return (
                      <button
                        key={`${hit.locator.section}:${hit.locator.offset}:${i}`}
                        type="button"
                        className="mb-list-row"
                        onClick={() => {
                          onSelectLocator(hit.locator, hit.length);
                        }}
                      >
                        <div>
                          <div>…{renderBoldMatch(hit.snippet, query)}…</div>
                          <div className="mb-list-row-meta">
                            {hit.chapterTitle ? `${hit.chapterTitle} · ` : ''}
                            {pct}%
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            />
          )}
        </>
      )}
    </Sheet>
  );
}
