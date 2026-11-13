import type { ReactElement } from 'react';
import { useRouteStore } from '../app/routes';

export function FlashOverlay(): ReactElement | null {
  const phase = useRouteStore((s) => s.flashPhase);
  if (!phase) return null;
  return (
    <div
      className="mb-flash-overlay"
      data-phase={phase}
      data-testid="flash-overlay"
      aria-hidden="true"
    />
  );
}
