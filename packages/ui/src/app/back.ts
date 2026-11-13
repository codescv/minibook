import { useEffect, useRef } from 'react';
import { useRouteStore } from './routes';

declare global {
  interface Window {
    __minibookHandleBack?: () => boolean;
  }
}

export type BackInterceptor = () => boolean;

const interceptors: BackInterceptor[] = [];

export function registerBackInterceptor(fn: BackInterceptor): () => void {
  interceptors.push(fn);
  return () => {
    const idx = interceptors.lastIndexOf(fn);
    if (idx >= 0) interceptors.splice(idx, 1);
  };
}

export function useBackInterceptor(fn: BackInterceptor, enabled = true): void {
  const fnRef = useRef<BackInterceptor>(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!enabled) return;
    return registerBackInterceptor(() => fnRef.current());
  }, [enabled]);
}

export function dispatchBackNavigation(): boolean {
  for (let i = interceptors.length - 1; i >= 0; i--) {
    const fn = interceptors[i];
    if (fn && fn()) {
      return true;
    }
  }
  return useRouteStore.getState().goBack();
}

export function installGlobalBackHandler(): () => void {
  if (typeof window === 'undefined') return () => {};

  const handler = (): boolean => dispatchBackNavigation();
  window.__minibookHandleBack = handler;

  const onDocBack = (e: Event): void => {
    if (handler()) {
      e.preventDefault();
    }
  };

  const onPopState = (): void => {
    if (handler()) {
      try {
        window.history.pushState({ minibook: 'sentinel' }, '');
      } catch {
        // ignore in restricted browsing contexts
      }
    }
  };

  try {
    const curState = window.history.state as { minibook?: string } | null;
    if (!curState || curState.minibook !== 'sentinel') {
      window.history.replaceState({ minibook: 'root' }, '');
      window.history.pushState({ minibook: 'sentinel' }, '');
    }
  } catch {
    // ignore
  }

  document.addEventListener('backbutton', onDocBack);
  window.addEventListener('popstate', onPopState);

  return () => {
    if (window.__minibookHandleBack === handler) {
      delete window.__minibookHandleBack;
    }
    document.removeEventListener('backbutton', onDocBack);
    window.removeEventListener('popstate', onPopState);
  };
}
