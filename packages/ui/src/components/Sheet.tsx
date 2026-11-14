import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { useIsEink } from '../host/HostContext';

export interface SheetProps {
  readonly open: boolean;
  readonly label: string;
  readonly onClose: (coveredHalfScreen: boolean) => void;
  readonly popoverOnDesktop?: boolean;
  readonly listSheet?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function Sheet({
  open,
  label,
  onClose,
  popoverOnDesktop = true,
  listSheet = false,
  className,
  children,
}: SheetProps): ReactElement | null {
  const isEink = useIsEink();
  const instant = isEink || prefersReducedMotion();
  const sheetRef = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState<boolean>(open);
  const [entered, setEntered] = useState<boolean>(open);
  const [dragDy, setDragDy] = useState<number>(0);
  const dragStateRef = useRef<{ pointerId: number; startY: number; dy: number } | null>(null);

  useEffect(() => {
    if (instant) {
      setMounted(open);
      setEntered(open);
      setDragDy(0);
      dragStateRef.current = null;
      return;
    }
    if (open) {
      setMounted(true);
      setDragDy(0);
      dragStateRef.current = null;
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
    setDragDy(0);
    dragStateRef.current = null;
    const timer = setTimeout(() => {
      setMounted(false);
    }, 240);
    return () => clearTimeout(timer);
  }, [open, instant]);

  const handleClose = (): void => {
    const rect = sheetRef.current?.getBoundingClientRect();
    const vh = typeof window !== 'undefined' ? window.innerHeight || 800 : 800;
    const coveredHalf = rect ? rect.height >= vh * 0.5 : false;
    onClose(coveredHalf);
  };
  const handleCloseRef = useRef(handleClose);
  handleCloseRef.current = handleClose;

  useEffect(() => {
    if (instant || !open || typeof window === 'undefined') return;
    const onWinPointerMove = (e: PointerEvent): void => {
      const st = dragStateRef.current;
      const pid = e.pointerId ?? 0;
      if (!st || (st.pointerId !== pid && st.pointerId !== 0) || typeof e.clientY !== 'number' || Number.isNaN(e.clientY)) {
        return;
      }
      const dy = Math.max(0, e.clientY - st.startY);
      st.dy = dy;
      setDragDy(dy);
    };
    const onWinPointerEnd = (e: PointerEvent): void => {
      const st = dragStateRef.current;
      const pid = e.pointerId ?? 0;
      if (!st || (st.pointerId !== pid && st.pointerId !== 0)) return;
      const finalDy = st.dy;
      dragStateRef.current = null;
      setDragDy(0);
      if (e.type !== 'pointercancel' && finalDy >= 56) {
        handleCloseRef.current();
      }
    };
    window.addEventListener('pointermove', onWinPointerMove);
    window.addEventListener('pointerup', onWinPointerEnd);
    window.addEventListener('pointercancel', onWinPointerEnd);
    return () => {
      window.removeEventListener('pointermove', onWinPointerMove);
      window.removeEventListener('pointerup', onWinPointerEnd);
      window.removeEventListener('pointercancel', onWinPointerEnd);
    };
  }, [instant, open]);

  if (instant) {
    if (!open) return null;
  } else if (!open && !mounted) {
    return null;
  }

  const phase: 'entering' | 'open' | 'closing' = instant
    ? 'open'
    : !open
      ? 'closing'
      : entered
        ? 'open'
        : 'entering';

  const startPointerDrag = (e: ReactPointerEvent<HTMLElement>): void => {
    if (instant || !open || typeof e.clientY !== 'number' || Number.isNaN(e.clientY)) return;
    const pid = e.pointerId ?? 0;
    dragStateRef.current = {
      pointerId: pid,
      startY: e.clientY,
      dy: 0,
    };
    try {
      if (typeof e.pointerId === 'number') {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
    } catch {
      // Ignore synthetic PointerEvent capture errors in headless/jsdom environments
    }
  };

  const onGrabberPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    startPointerDrag(e);
  };

  const onSheetPointerDown = (e: ReactPointerEvent<HTMLElement>): void => {
    if (dragStateRef.current || instant || !open) return;
    const rect = sheetRef.current?.getBoundingClientRect();
    if (!rect || e.clientY - rect.top > 36) return;
    const target = e.target as Element | null;
    if (
      target?.closest?.(
        'button, input, a, select, textarea, [role="button"], [role="tab"], [role="slider"], [role="option"], [role="switch"]',
      )
    ) {
      return;
    }
    startPointerDrag(e);
  };

  const onGrabberPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const st = dragStateRef.current;
    const pid = e.pointerId ?? 0;
    if (!st || (st.pointerId !== pid && st.pointerId !== 0) || typeof e.clientY !== 'number' || Number.isNaN(e.clientY)) {
      return;
    }
    const dy = Math.max(0, e.clientY - st.startY);
    st.dy = dy;
    setDragDy(dy);
  };

  const onGrabberPointerEnd = (e: ReactPointerEvent<HTMLElement>): void => {
    const st = dragStateRef.current;
    const pid = e.pointerId ?? 0;
    if (!st || (st.pointerId !== pid && st.pointerId !== 0)) return;
    const finalDy = st.dy;
    dragStateRef.current = null;
    setDragDy(0);
    if (e.type !== 'pointercancel' && finalDy >= 56) {
      handleClose();
    }
  };

  const onGrabberTouchStart = (e: ReactTouchEvent<HTMLDivElement>): void => {
    if (instant || !open) return;
    const touch = e.touches[0];
    if (!touch) return;
    dragStateRef.current = {
      pointerId: -1,
      startY: touch.clientY,
      dy: 0,
    };
  };

  const onGrabberTouchMove = (e: ReactTouchEvent<HTMLDivElement>): void => {
    const st = dragStateRef.current;
    const touch = e.touches[0];
    if (!st || st.pointerId !== -1 || !touch) return;
    const dy = Math.max(0, touch.clientY - st.startY);
    st.dy = dy;
    setDragDy(dy);
  };

  const onGrabberTouchEnd = (e: ReactTouchEvent<HTMLDivElement>): void => {
    const st = dragStateRef.current;
    if (!st || st.pointerId !== -1) return;
    const finalDy = st.dy;
    dragStateRef.current = null;
    setDragDy(0);
    if (e.type !== 'touchcancel' && finalDy >= 56) {
      handleClose();
    }
  };

  const isClosing = phase === 'closing';

  return (
    <>
      <div
        className="mb-sheet-backdrop"
        data-testid={isClosing ? undefined : 'sheet-backdrop'}
        data-state={phase}
        onClick={isClosing ? undefined : handleClose}
        aria-hidden="true"
        style={isClosing ? { pointerEvents: 'none' } : undefined}
      />
      <section
        ref={sheetRef}
        className={className ? `mb-sheet ${className}` : 'mb-sheet'}
        data-state={phase}
        role={isClosing ? undefined : 'dialog'}
        aria-modal={isClosing ? undefined : 'true'}
        aria-label={isClosing ? undefined : label}
        aria-hidden={isClosing ? 'true' : undefined}
        data-popover={popoverOnDesktop ? 'true' : 'false'}
        data-list-sheet={listSheet ? 'true' : undefined}
        onTransitionEnd={(e) => {
          if (e.target === e.currentTarget && !open) {
            setMounted(false);
          }
        }}
        onPointerDown={onSheetPointerDown}
        onPointerMove={onGrabberPointerMove}
        onPointerUp={onGrabberPointerEnd}
        onPointerCancel={onGrabberPointerEnd}
        style={
          isClosing
            ? { pointerEvents: 'none' }
            : dragDy > 0
              ? { transform: `translate3d(0, ${dragDy}px, 0)`, transition: 'none' }
              : undefined
        }
      >
        <div
          className="mb-sheet-grabber"
          aria-hidden="true"
          onPointerDown={onGrabberPointerDown}
          onPointerMove={onGrabberPointerMove}
          onPointerUp={onGrabberPointerEnd}
          onPointerCancel={onGrabberPointerEnd}
          onTouchStart={onGrabberTouchStart}
          onTouchMove={onGrabberTouchMove}
          onTouchEnd={onGrabberTouchEnd}
          onTouchCancel={onGrabberTouchEnd}
        />
        {children}
      </section>
    </>
  );
}
