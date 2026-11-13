import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { Bookmark, BookSession, Locator, SearchHit, TocItem } from '@minibook/core';
import { useRouteStore, type ContentsTab } from '../../app/routes';
import { IconButton } from '../../components/IconButton';
import { Segmented } from '../../components/Segmented';
import { Sheet } from '../../components/Sheet';
import { CloseIcon } from '../../components/icons';
import { PagedList } from '../../eink/PagedList';
import { fractionForLocator, searchBookSafe } from '../../host/core-bridge';
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

function flattenToc(
  items: readonly TocItem[],
  spine: BookSession['spine'],
  currentSection: number,
  depth = 0,
  acc: FlatTocRow[] = [],
): FlatTocRow[] {
  items.forEach((item, idx) => {
    const pct = Math.max(0, Math.min(100, Math.round(fractionForLocator(spine, item.locator) * 100)));
    acc.push({
      key: `${depth}-${idx}-${item.locator.section}:${item.locator.offset}`,
      title: item.title,
      locator: item.locator,
      depth,
      percent: pct,
      isCurrent: item.locator.section === currentSection,
    });
    if (item.children.length > 0) {
      flattenToc(item.children, spine, currentSection, depth + 1, acc);
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
 * Every list is backed by `PagedList` so E-Ink mode stays strictly zero-scroll.
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
  const { isEink } = useHostContext();
  const tab = useRouteStore((s) => s.contentsTab);
  const setTab = useRouteStore((s) => s.setContentsTab);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);

  const tocRows = useMemo(() => {
    if (!session) return [];
    if (session.toc.length > 0) {
      return flattenToc(session.toc, session.spine, currentSection);
    }
    return session.spine
      .filter((s) => s.linear)
      .map((s, idx): FlatTocRow => ({
        key: `part-${s.index}`,
        title: s.title || `Part ${idx + 1}`,
        locator: { section: s.index, offset: 0 },
        depth: 0,
        percent: Math.round(fractionForLocator(session.spine, { section: s.index, offset: 0 }) * 100),
        isCurrent: s.index === currentSection,
      }));
  }, [session, currentSection]);

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
    <Sheet open={open} label={t('contents')} onClose={onClose}>
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
          fallbackPageSize={6}
          prevLabel={t('prevPage')}
          nextLabel={t('nextPage')}
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
                    onClose(false);
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
            fallbackPageSize={5}
            prevLabel={t('prevPage')}
            nextLabel={t('nextPage')}
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
                        onClose(false);
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
                      label="Delete bookmark"
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
            type="search"
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
              fallbackPageSize={5}
              prevLabel={t('prevPage')}
              nextLabel={t('nextPage')}
              renderItems={(visible) => (
                <div role="list" aria-label={t('search')}>
                  {visible.map((hit, i) => {
                    const pct = session
                      ? Math.round(fractionForLocator(session.spine, hit.locator) * 100)
                      : 0;
                    return (
                      <button
                        key={`${hit.locator.section}:${hit.locator.offset}:${i}`}
                        type="button"
                        className="mb-list-row"
                        onClick={() => {
                          onSelectLocator(hit.locator, hit.length);
                          onClose(false);
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
