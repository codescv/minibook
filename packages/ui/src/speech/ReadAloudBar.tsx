import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useRouteStore } from '../app/routes';
import { IconButton } from '../components/IconButton';
import {
  CloseIcon,
  MoonIcon,
  PauseIcon,
  PlayIcon,
  SkipNextIcon,
  SkipPrevIcon,
} from '../components/icons';
import { useT } from '../i18n';
import { useReadAloudStore, type ReadAloudController } from './ReadAloudController';

export interface ReadAloudBarProps {
  readonly controller: ReadAloudController;
  readonly isEink: boolean;
  readonly bookId?: string;
}

/**
 * Compact Read-Aloud floating bar (`PRODUCT_DESIGN.md` §4.6 & `UI_SPEC.md` §4.6):
 * Exact 6 controls: `✕ · ⏮ · ⏸/▶ · ⏭ · 1.0× · ⏾`.
 * Auto-hides after 4s in normal mode; never auto-hides in E-Ink mode (R4).
 */
export function ReadAloudBar({ controller, isEink, bookId }: ReadAloudBarProps): ReactElement | null {
  const t = useT();
  const active = useReadAloudStore((s) => s.active);
  const raBookId = useReadAloudStore((s) => s.bookId);
  const status = useReadAloudStore((s) => s.status);
  const rate = useReadAloudStore((s) => s.rate);
  const sleepTimer = useReadAloudStore((s) => s.sleepTimer);
  const barOpen = useRouteStore((s) => s.readAloudBarOpen);
  const activeSheet = useRouteStore((s) => s.activeSheet);

  const shouldShow = active && (!bookId || raBookId === bookId) && barOpen;
  const [mounted, setMounted] = useState<boolean>(shouldShow);
  const [entered, setEntered] = useState<boolean>(shouldShow);

  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  useEffect(() => {
    if (isEink) {
      setMounted(shouldShow);
      setEntered(shouldShow);
      return;
    }
    if (shouldShow) {
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
  }, [shouldShow, isEink]);

  useEffect(() => {
    if (!active || !barOpen || isEink || activeSheet !== null) return;
    const timer = setTimeout(() => {
      useRouteStore.getState().setReadAloudBarOpen(false);
    }, 4000);
    return () => clearTimeout(timer);
  }, [active, barOpen, isEink, activeSheet, status, rate]);

  if (isEink ? !shouldShow : !shouldShow && !mounted) return null;

  const phase: 'entering' | 'open' | 'closing' = isEink
    ? 'open'
    : !shouldShow
      ? 'closing'
      : entered
        ? 'open'
        : 'entering';
  const isClosing = phase === 'closing';

  const isPlaying = status === 'playing' || status === 'buffering';

  const startSkipPress = (dir: -1 | 1): void => {
    longPressFired.current = false;
    if (longPressRef.current) clearTimeout(longPressRef.current);
    longPressRef.current = setTimeout(() => {
      longPressFired.current = true;
      controller.stepParagraph(dir);
    }, 450);
  };

  const endSkipPress = (dir: -1 | 1): void => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
    if (!longPressFired.current) {
      controller.stepSentence(dir);
    }
  };

  return (
    <nav
      className="mb-tts-bar"
      data-state={phase}
      aria-label={isClosing ? undefined : t('readAloud')}
      aria-hidden={isClosing ? 'true' : undefined}
      style={isClosing ? { pointerEvents: 'none' } : undefined}
    >
      <IconButton label={t('stopReadAloud')} onClick={() => controller.stop()}>
        <CloseIcon />
      </IconButton>

      <IconButton
        label={t('prevSentence')}
        onPointerDown={() => startSkipPress(-1)}
        onPointerUp={() => endSkipPress(-1)}
        onPointerCancel={() => {
          if (longPressRef.current) clearTimeout(longPressRef.current);
        }}
      >
        <SkipPrevIcon />
      </IconButton>

      <button
        type="button"
        className="mb-tts-play-btn"
        aria-label={isPlaying ? t('pause') : t('play')}
        onClick={() => controller.togglePlayPause()}
      >
        {isPlaying ? <PauseIcon /> : <PlayIcon />}
      </button>

      <IconButton
        label={t('nextSentence')}
        onPointerDown={() => startSkipPress(1)}
        onPointerUp={() => endSkipPress(1)}
        onPointerCancel={() => {
          if (longPressRef.current) clearTimeout(longPressRef.current);
        }}
      >
        <SkipNextIcon />
      </IconButton>

      <button
        type="button"
        className="mb-tts-speed-pill"
        aria-label={`${t('voiceAndSpeed')}: ${rate.toFixed(1)}x`}
        onClick={() => useRouteStore.getState().openSheet('voice')}
      >
        {rate.toFixed(1)}×
      </button>

      <IconButton
        label={t('sleepTimer')}
        active={sleepTimer.mode !== 'off'}
        onClick={() => useRouteStore.getState().openSheet('sleep')}
      >
        <MoonIcon />
      </IconButton>
    </nav>
  );
}
