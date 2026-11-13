import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { registerPageableHandler } from '../app/routes';
import { IconButton } from '../components/IconButton';

export interface PagedListProps<T> {
  readonly items: readonly T[];
  readonly renderItems: (visibleItems: readonly T[]) => ReactNode;
  readonly isEink: boolean;
  readonly layer?: 'screen' | 'sheet';
  readonly estimatedItemHeight?: number;
  readonly columns?: number;
  readonly fallbackPageSize?: number;
  readonly resetKey?: string | number;
  readonly prevLabel?: string;
  readonly nextLabel?: string;
  readonly ariaLabel?: string;
  readonly onPageTurn?: (swap: () => void) => void;
}

type PageSlice = readonly [number, number];

const FOOTER_RESERVE_PX = 64;

function buildFixedChunks(total: number, step: number): PageSlice[] {
  const safeStep = Math.max(1, step);
  if (total <= 0) return [[0, 0]];
  const out: PageSlice[] = [];
  for (let i = 0; i < total; i += safeStep) {
    out.push([i, Math.min(total, i + safeStep)]);
  }
  return out;
}

/**
 * `PagedList` (`ARCHITECTURE.md` §9.3 & `PRODUCT_DESIGN.md` §8.2 R3):
 * - Normal mode: ordinary vertical scroll container (`overflow-y: auto`).
 * - E-Ink mode: zero-scroll discrete paginator (`overflow: hidden; overscroll-behavior: none; touch-action: none`),
 *   measuring real rendered item heights + gaps inside a stable outer flex container (`rootRef`) so zero
 *   items are ever clipped and ResizeObserver never enters a height feedback loop.
 */
export function PagedList<T>({
  items,
  renderItems,
  isEink,
  layer = 'screen',
  columns = 1,
  fallbackPageSize = 8,
  resetKey,
  prevLabel = '‹ Prev',
  nextLabel = 'Next ›',
  ariaLabel = 'Pagination',
  onPageTurn,
}: PagedListProps<T>): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);

  const [containerBox, setContainerBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [packed, setPacked] = useState<{ sig: string; pages: readonly PageSlice[] } | null>(null);
  const [page, setPage] = useState<number>(0);

  const prevResetKeyRef = useRef<string | number | undefined>(resetKey);
  const prevLengthRef = useRef<number>(items.length);

  useEffect(() => {
    if (prevResetKeyRef.current !== resetKey) {
      prevResetKeyRef.current = resetKey;
      prevLengthRef.current = items.length;
      setPage(0);
      return;
    }
    // Reset to page 0 when an empty list populates or search results stream a fresh batch
    if (prevLengthRef.current === 0 && items.length > 0) {
      setPage(0);
    }
    prevLengthRef.current = items.length;
  }, [resetKey, items.length]);

  useLayoutEffect(() => {
    if (!isEink) return;
    const rootEl = rootRef.current;
    if (!rootEl) return;

    const updateBox = (): void => {
      const w = rootEl.clientWidth;
      const h = rootEl.clientHeight;
      setContainerBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    updateBox();

    const ro = new ResizeObserver(updateBox);
    ro.observe(rootEl);
    return () => ro.disconnect();
  }, [isEink]);

  const measureSig = `${containerBox.w}x${containerBox.h}:cols=${columns}:len=${items.length}:rk=${String(resetKey ?? '')}`;
  const needsRealMeasure =
    isEink && containerBox.h > 0 && items.length > 0 && packed?.sig !== measureSig;

  useLayoutEffect(() => {
    if (!needsRealMeasure) return;
    const rootEl = rootRef.current;
    const viewportEl = viewportRef.current;
    if (!rootEl || !viewportEl) return;

    const totalH = rootEl.clientHeight;
    if (totalH <= 0) return;

    const computedPages: PageSlice[] = [];

    if (columns > 1) {
      const gridEl = viewportEl.firstElementChild as HTMLElement | null;
      const kids = gridEl ? (Array.from(gridEl.children) as HTMLElement[]) : [];
      if (kids.length > 0) {
        const top0 = kids[0]!.getBoundingClientRect().top;
        const firstRowCount = kids.filter(
          (k) => Math.abs(k.getBoundingClientRect().top - top0) <= 4,
        ).length;
        const actualCols = Math.max(1, firstRowCount);
        const rowH = Math.max(
          24,
          ...kids.slice(0, actualCols).map((k) => k.getBoundingClientRect().height),
        );
        const rowGap =
          gridEl && typeof window !== 'undefined'
            ? parseFloat(window.getComputedStyle(gridEl).rowGap) || 0
            : 0;
        const totalRows = Math.ceil(items.length / actualCols);
        const allHeight = totalRows * rowH + Math.max(0, totalRows - 1) * rowGap;

        if (allHeight <= totalH - 2) {
          computedPages.push([0, items.length]);
        } else {
          const availH = Math.max(44, totalH - FOOTER_RESERVE_PX);
          const rowsPerPage = Math.max(1, Math.floor((availH + rowGap) / (rowH + rowGap)));
          const step = Math.max(1, rowsPerPage * actualCols);
          computedPages.push(...buildFixedChunks(items.length, step));
        }
      }
    } else {
      const listEl = viewportEl.firstElementChild as HTMLElement | null;
      const kids = listEl ? (Array.from(listEl.children) as HTMLElement[]) : [];
      if (kids.length === items.length && kids.length > 0) {
        const firstTop = kids[0]!.getBoundingClientRect().top;
        const lastBottom = kids[kids.length - 1]!.getBoundingClientRect().bottom;
        if (lastBottom - firstTop <= totalH - 2) {
          computedPages.push([0, items.length]);
        } else {
          const availH = Math.max(44, totalH - FOOTER_RESERVE_PX);
          let start = 0;
          while (start < kids.length) {
            const startTop = kids[start]!.getBoundingClientRect().top;
            let end = start + 1;
            while (end < kids.length) {
              const span = kids[end]!.getBoundingClientRect().bottom - startTop;
              if (span > availH) break;
              end += 1;
            }
            if (
              end < kids.length &&
              end - start >= 2 &&
              kids[end - 1]!.classList.contains('mb-settings-section-title')
            ) {
              end -= 1;
            }
            computedPages.push([start, end]);
            start = end;
          }
        }
      }
    }

    if (computedPages.length === 0) {
      computedPages.push(...buildFixedChunks(items.length, fallbackPageSize));
    }

    setPacked({ sig: measureSig, pages: computedPages });
  }, [needsRealMeasure, measureSig, columns, items.length, fallbackPageSize]);

  const pages = useMemo<readonly PageSlice[]>(() => {
    if (!isEink) return [[0, items.length]];
    if (packed && packed.sig === measureSig) {
      return packed.pages;
    }
    return buildFixedChunks(items.length, fallbackPageSize);
  }, [isEink, items.length, packed, measureSig, fallbackPageSize]);

  const pageCount = Math.max(1, pages.length);
  const resetPending = prevResetKeyRef.current !== resetKey;
  const clampedPage = resetPending ? 0 : Math.min(page, pageCount - 1);

  const stateRef = useRef({ clampedPage, pageCount });
  stateRef.current = { clampedPage, pageCount };

  useEffect(() => {
    if (!resetPending && page !== clampedPage) {
      setPage(clampedPage);
    }
  }, [page, clampedPage, resetPending]);

  const goNext = useCallback(() => {
    const { clampedPage: cur, pageCount: total } = stateRef.current;
    if (cur + 1 >= total) return;
    const applySwap = (): void => {
      setPage((prev) => Math.min(stateRef.current.pageCount - 1, prev + 1));
    };
    if (onPageTurn) {
      onPageTurn(applySwap);
    } else {
      applySwap();
    }
  }, [onPageTurn]);

  const goPrev = useCallback(() => {
    const { clampedPage: cur } = stateRef.current;
    if (cur <= 0) return;
    const applySwap = (): void => {
      setPage((prev) => Math.max(0, prev - 1));
    };
    if (onPageTurn) {
      onPageTurn(applySwap);
    } else {
      applySwap();
    }
  }, [onPageTurn]);

  useEffect(() => {
    if (!isEink) return;
    return registerPageableHandler({
      id: `paged-list-${layer}`,
      layer,
      nextPage: goNext,
      prevPage: goPrev,
    });
  }, [isEink, layer, goNext, goPrev]);

  if (!isEink) {
    return <div className="mb-paged-scroll">{renderItems(items)}</div>;
  }

  // During the synchronous pre-paint measurement pass (`needsRealMeasure`), render `items`
  // (`<= 24` tiles for grids or full list for vertical items) so `useLayoutEffect` measures
  // exact `getBoundingClientRect()` heights before the browser ever paints a frame.
  const activeSliceRange = pages[clampedPage] ?? [0, items.length];
  const visibleSlice = needsRealMeasure
    ? columns > 1
      ? items.slice(0, Math.min(items.length, Math.max(columns * 3, 12)))
      : items
    : items.slice(activeSliceRange[0], activeSliceRange[1]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    pointerStart.current = { x: e.clientX, y: e.clientY };
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) >= 40 && Math.abs(dx) > 2 * Math.abs(dy)) {
      if (dx < 0) goNext();
      else goPrev();
    }
  };

  return (
    <div
      ref={rootRef}
      className="mb-paged-eink"
      data-testid="paged-list-eink"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        pointerStart.current = null;
      }}
    >
      <div ref={viewportRef} className="mb-paged-eink-viewport">
        {renderItems(visibleSlice)}
      </div>
      {!needsRealMeasure && pageCount > 1 && (
        <footer className="mb-paged-footer" aria-label={ariaLabel}>
          <IconButton
            label={prevLabel}
            disabled={clampedPage <= 0}
            onClick={goPrev}
          >
            <span>{prevLabel}</span>
          </IconButton>
          <span>
            {clampedPage + 1} / {pageCount}
          </span>
          <IconButton
            label={nextLabel}
            disabled={clampedPage >= pageCount - 1}
            onClick={goNext}
          >
            <span>{nextLabel}</span>
          </IconButton>
        </footer>
      )}
    </div>
  );
}
