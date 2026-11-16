import { useEffect, useState } from 'react';
import { detectPrefersDark, subscribePrefersDark } from './theme-manager';

/**
 * Live OS `prefers-color-scheme: dark` state. Re-renders whenever the system appearance flips so
 * Match System (`appearanceMode === 'system'`) can re-apply iframe theme colours immediately.
 */
export function usePrefersDark(): boolean {
  const [prefersDark, setPrefersDark] = useState<boolean>(() => detectPrefersDark());
  useEffect(() => {
    setPrefersDark(detectPrefersDark());
    return subscribePrefersDark(setPrefersDark);
  }, []);
  return prefersDark;
}
