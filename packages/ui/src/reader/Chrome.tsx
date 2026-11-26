import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { useRouteStore } from '../app/routes';
import { IconButton } from '../components/IconButton';
import {
  BookmarkIcon,
  ChevronLeftIcon,
  ContentsIcon,
  HeadphonesIcon,
  RefreshIcon,
} from '../components/icons';
import { useT } from '../i18n';

export interface ChromeProps {
  readonly open: boolean;
  readonly isEink: boolean;
  readonly bookTitle: string;
  readonly chapterTitle: string;
  readonly fraction: number;
  readonly isBookmarked: boolean;
  readonly backJumpLabel: string | null;
  readonly onBackToLibrary: () => void;
  readonly onManualRefresh: () => void;
  readonly onToggleBookmark: () => void;
  readonly onStartReadAloud: () => void;
  readonly onScrubFraction: (fraction: number) => void;
  readonly onPreviewChapterForFraction: (fraction: number) => string;
  readonly onStepChapter: (delta: -1 | 1) => void;
  readonly onReturnBackJump: () => void;
}

/**
 * 1-Tap Reader Chrome (`PRODUCT_DESIGN.md` §4.3, §8.2 & `UI_SPEC.md` §4.3):
 * - Overlays constant `pt` and `pb` without shifting or dimming the reading page.
 * - Normal mode: **5 controls** (`‹ Library`, `🔖`, `☰`, `Aa`, `🎧`) + scrubber slider.
 * - E-Ink mode: **6 controls** (`‹ Library`, `⟳` Refresh, `🔖`, `☰`, `Aa`, `🎧`) + discrete
 *   stepped scrubber (`‹ Chapter · 12 % · Chapter ›` + `Go to %`).
 */
export function Chrome({
  open,
  isEink,
  bookTitle,
  chapterTitle,
  fraction,
  isBookmarked,
  backJumpLabel,
  onBackToLibrary,
  onManualRefresh,
  onToggleBookmark,
  onStartReadAloud,
  onScrubFraction,
  onPreviewChapterForFraction,
  onStepChapter,
  onReturnBackJump,
}: ChromeProps): ReactElement | null {
  const t = useT();
  const activeSheet = useRouteStore((s) => s.activeSheet);
  const goToPercentOpen = useRouteStore((s) => s.goToPercentOpen);

  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragFraction, setDragFraction] = useState<number | null>(null);
  const [pctInput, setPctInput] = useState<string>('');
  const [mounted, setMounted] = useState<boolean>(open);
  const [entered, setEntered] = useState<boolean>(open);

  useEffect(() => {
    if (isEink) {
      setMounted(open);
      setEntered(open);
      return;
    }
    if (open) {
      setMounted(true);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          setEntered(true);
        });
      });
      return () => {
        cancelAnimationFrame(raf1);
        if (raf2) cancelAnimationFrame(raf2);
      };
    }
    setEntered(false);
    const timer = setTimeout(() => {
      setMounted(false);
    }, 220);
    return () => clearTimeout(timer);
  }, [open, isEink]);

  // Auto-hide after 4s without interaction in normal mode; disabled in E-Ink mode (R4)
  useEffect(() => {
    if (!open || isEink || activeSheet !== null || goToPercentOpen || dragFraction !== null) {
      return;
    }
    const timer = setTimeout(() => {
      useRouteStore.getState().setChromeOpen(false);
    }, 4000);
    return () => clearTimeout(timer);
  }, [open, isEink, activeSheet, goToPercentOpen, dragFraction, fraction, isBookmarked]);

  if (isEink ? !open : !open && !mounted) return null;

  const phase: 'entering' | 'open' | 'closing' = isEink
    ? 'open'
    : !open
      ? 'closing'
      : entered
        ? 'open'
        : 'entering';
  const isClosing = phase === 'closing';

  const displayFraction = dragFraction ?? fraction;
  const pct = Math.max(0, Math.min(100, Math.round(displayFraction * 100)));
  const headerLine =
    chapterTitle && chapterTitle !== bookTitle
      ? `${bookTitle} · ${chapterTitle}`
      : bookTitle;

  const computeTrackRatio = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return fraction;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const onScrubberDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragFraction(computeTrackRatio(e.clientX));
  };

  const onScrubberMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragFraction === null) return;
    setDragFraction(computeTrackRatio(e.clientX));
  };

  const onScrubberUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragFraction === null) return;
    const finalFrac = computeTrackRatio(e.clientX);
    setDragFraction(null);
    onScrubFraction(finalFrac);
  };

  return (
    <>
      <header
        className="mb-chrome-top"
        data-state={phase}
        aria-hidden={isClosing ? 'true' : undefined}
        style={isClosing ? { pointerEvents: 'none' } : undefined}
      >
        <IconButton label={t('backToLibrary')} onClick={onBackToLibrary}>
          <ChevronLeftIcon />
          <span>{t('library')}</span>
        </IconButton>

        <div className="mb-chrome-right">
          {isEink && (
            <IconButton label={t('fullRefresh')} onClick={onManualRefresh}>
              <RefreshIcon />
            </IconButton>
          )}

          <IconButton
            label={t('bookmark')}
            aria-pressed={isBookmarked}
            active={isBookmarked}
            onClick={onToggleBookmark}
          >
            <BookmarkIcon filled={isBookmarked} />
          </IconButton>

          <IconButton
            label={t('contents')}
            active={activeSheet === 'contents'}
            onClick={() =>
              useRouteStore
                .getState()
                .openSheet(activeSheet === 'contents' ? null : 'contents')
            }
          >
            <ContentsIcon />
          </IconButton>

          <IconButton
            label={t('appearance')}
            active={activeSheet === 'appearance'}
            onClick={() =>
              useRouteStore
                .getState()
                .openSheet(activeSheet === 'appearance' ? null : 'appearance')
            }
          >
            <span style={{ fontFamily: 'var(--mb-font-serif)', fontWeight: 600 }}>Aa</span>
          </IconButton>

          <IconButton label={t('readAloud')} onClick={onStartReadAloud}>
            <HeadphonesIcon />
          </IconButton>
        </div>
      </header>

      <footer
        className="mb-chrome-bottom"
        data-state={phase}
        aria-label={isClosing ? undefined : t('readingPosition')}
        aria-hidden={isClosing ? 'true' : undefined}
        style={isClosing ? { pointerEvents: 'none' } : undefined}
      >
        <div className="mb-chrome-meta-row">
          <div className="mb-chrome-chapter-label">{headerLine}</div>
          {backJumpLabel && (
            <button
              type="button"
              className="mb-back-jump-pill"
              onClick={onReturnBackJump}
            >
              ↩ {backJumpLabel}
            </button>
          )}
        </div>

        {isEink ? (
          goToPercentOpen ? (
            <form
              className="mb-eink-scrubber-controls"
              onSubmit={(e) => {
                e.preventDefault();
                const parsed = Number(pctInput);
                if (Number.isFinite(parsed)) {
                  onScrubFraction(Math.max(0, Math.min(100, parsed)) / 100);
                }
                useRouteStore.getState().setGoToPercentOpen(false);
              }}
            >
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                className="mb-input"
                aria-label={t('goToPercent')}
                value={pctInput}
                onChange={(e) => setPctInput(e.target.value.replace(/[^0-9.]/g, ''))}
                autoFocus
              />
              <button type="submit" className="mb-eink-step-btn">
                {t('go')}
              </button>
              <button
                type="button"
                className="mb-eink-step-btn"
                onClick={() => useRouteStore.getState().setGoToPercentOpen(false)}
              >
                {t('cancel')}
              </button>
            </form>
          ) : (
            <div className="mb-eink-scrubber-controls">
              <button
                type="button"
                className="mb-eink-step-btn"
                onClick={() => onStepChapter(-1)}
              >
                {t('prevChapter')}
              </button>
              <span>{pct} %</span>
              <button
                type="button"
                className="mb-eink-step-btn"
                onClick={() => onStepChapter(1)}
              >
                {t('nextChapter')}
              </button>
              <button
                type="button"
                className="mb-eink-step-btn"
                onClick={() => {
                  setPctInput(String(pct));
                  useRouteStore.getState().setGoToPercentOpen(true);
                }}
              >
                {t('goToPercent')}
              </button>
            </div>
          )
        ) : (
          <div className="mb-scrubber-row">
            {dragFraction !== null && (
              <div
                className="mb-scrubber-preview"
                style={{ left: `${pct}%` }}
              >
                {onPreviewChapterForFraction(dragFraction)} · {pct}%
              </div>
            )}
            <div
              className="mb-scrubber-hit"
              onPointerDown={onScrubberDown}
              onPointerMove={onScrubberMove}
              onPointerUp={onScrubberUp}
              onPointerCancel={() => setDragFraction(null)}
            >
              <div
                ref={trackRef}
                className="mb-scrubber-track"
                role="slider"
                tabIndex={0}
                aria-label={t('readingPosition')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight') onScrubFraction(Math.min(1, fraction + 0.05));
                  if (e.key === 'ArrowLeft') onScrubFraction(Math.max(0, fraction - 0.05));
                }}
              >
                <div className="mb-scrubber-fill" style={{ width: `${pct}%` }} />
                <div className="mb-scrubber-thumb" style={{ left: `${pct}%` }} />
              </div>
            </div>
            <span className="mb-scrubber-pct">{pct}%</span>
          </div>
        )}
      </footer>
    </>
  );
}
