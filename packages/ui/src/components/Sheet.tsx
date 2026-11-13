import { useRef, type ReactElement, type ReactNode } from 'react';

export interface SheetProps {
  readonly open: boolean;
  readonly label: string;
  readonly onClose: (coveredHalfScreen: boolean) => void;
  readonly popoverOnDesktop?: boolean;
  readonly children: ReactNode;
}

export function Sheet({
  open,
  label,
  onClose,
  popoverOnDesktop = true,
  children,
}: SheetProps): ReactElement | null {
  const sheetRef = useRef<HTMLElement | null>(null);

  if (!open) return null;

  const handleClose = (): void => {
    const rect = sheetRef.current?.getBoundingClientRect();
    const vh = typeof window !== 'undefined' ? window.innerHeight || 800 : 800;
    const coveredHalf = rect ? rect.height >= vh * 0.5 : false;
    onClose(coveredHalf);
  };

  return (
    <>
      <div
        className="mb-sheet-backdrop"
        data-testid="sheet-backdrop"
        onClick={handleClose}
        aria-hidden="true"
      />
      <section
        ref={sheetRef}
        className="mb-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-popover={popoverOnDesktop ? 'true' : 'false'}
      >
        <div className="mb-sheet-grabber" aria-hidden="true" />
        {children}
      </section>
    </>
  );
}
