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
  readonly prevLabel?: string;
  readonly nextLabel?: string;
  readonly ariaLabel?: string;
  readonly onPageTurn?: () => void;
}

/**
 * `PagedList` (`ARCHITECTURE.md` §9.3 & `PRODUCT_DESIGN.md` §8.2 R3):
 * - Normal mode: ordinary vertical scroll container (`overflow-y: auto`).
 * - E-Ink mode: zero-scroll discrete paginator (`overflow: hidden; overscroll-behavior: none; touch-action: none`),
 *   measuring available height and rendering `‹ Prev · n / N · Next ›` + swipe-end + hardware/volume key paging.
 */
export function PagedList<T>({
  items,
  renderItems,
  isEink,
  layer = 'screen',
  estimatedItemHeight = 52,
  columns = 1,
  fallbackPageSize = 8,
  prevLabel = '‹ Prev',
  nextLabel = 'Next ›',
  ariaLabel = 'Pagination',
  onPageTurn,
}: PagedListProps<T>): ReactElement {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [measuredHeight, setMeasuredHeight] = useState<number>(0);
  const [page, setPage] = useState<number>(0);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!isEink) return;
    const el = viewportRef.current;
    if (!el) return;
    const update = (): void => {
      const h = el.clientHeight;
      if (h > 0) setMeasuredHeight(h);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isEink]);

  const pageSize = useMemo(() => {
    if (!isEink) return items.length || 1;
    if (measuredHeight <= 0) return Math.max(1, fallbackPageSize);
    const rows = Math.max(1, Math.floor(measuredHeight / Math.max(24, estimatedItemHeight)));
    return Math.max(1, rows * Math.max(1, columns));
  }, [isEink, items.length, measuredHeight, fallbackPageSize, estimatedItemHeight, columns]);

  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const clampedPage = Math.min(page, pageCount - 1);

  useEffect(() => {
    if (page !== clampedPage) {
      setPage(clampedPage);
    }
  }, [page, clampedPage]);

  const goNext = useCallback(() => {
    setPage((prev) => {
      const next = Math.min(pageCount - 1, prev + 1);
      if (next !== prev) onPageTurn?.();
      return next;
    });
  }, [pageCount, onPageTurn]);

  const goPrev = useCallback(() => {
    setPage((prev) => {
      const next = Math.max(0, prev - 1);
      if (next !== prev) onPageTurn?.();
      return next;
    });
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

  const slice = items.slice(clampedPage * pageSize, (clampedPage + 1) * pageSize);

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
      className="mb-paged-eink"
      data-testid="paged-list-eink"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        pointerStart.current = null;
      }}
    >
      <div ref={viewportRef} className="mb-paged-eink-viewport">
        {renderItems(slice)}
      </div>
      {pageCount > 1 && (
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
