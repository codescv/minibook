import type { AppSettings, HardwareKey, PlatformHost } from '@minibook/core';
import { computeEffectiveEink, computeEffectiveVolumeKeyPaging } from '../theme/theme-manager';
import { dispatchBackNavigation } from './back';
import {
  computeTopmostLayerIsPageable,
  getTopmostPageableHandler,
  subscribePageableStack,
  useRouteStore,
  type RouteState,
} from './routes';

export interface ReaderShortcutActions {
  toggleBookmark?: () => void;
  toggleReadAloud?: () => void;
  togglePlayPause?: () => void;
  adjustSpeed?: (delta: number) => void;
}

let shortcutActions: ReaderShortcutActions = {};

export function setReaderShortcutActions(actions: ReaderShortcutActions): () => void {
  shortcutActions = actions;
  return () => {
    if (shortcutActions === actions) {
      shortcutActions = {};
    }
  };
}

export function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const input = el as HTMLInputElement;
    return !input.readOnly && !input.disabled;
  }
  return (el as HTMLElement).isContentEditable === true;
}

/**
 * Computes exact `keyPolicy.volumePaging` per `ARCHITECTURE.md` §9.5:
 * `true` <=> setting is enabled AND capabilities.volumeKeyPaging AND app is visible
 *            AND no text input has focus AND topmost layer is pageable.
 */
export function computeKeyPolicyVolumePaging(
  settings: AppSettings,
  host: PlatformHost,
  route: Pick<
    RouteState,
    'screen' | 'activeSheet' | 'imagePreviewUrl' | 'goToPercentOpen' | 'textInputFocused' | 'appVisible'
  >,
  mediaEink?: boolean,
): boolean {
  const isEink = computeEffectiveEink(settings, host.info.capabilities, mediaEink);
  const settingOn = computeEffectiveVolumeKeyPaging(settings, isEink, host.info.capabilities);
  if (!settingOn) return false;
  if (!route.appVisible) return false;
  if (route.textInputFocused) return false;
  return computeTopmostLayerIsPageable(route, isEink);
}

export function handleHardwareKey(key: HardwareKey): boolean {
  const state = useRouteStore.getState();
  if (state.textInputFocused) return false;
  const handler = getTopmostPageableHandler(state);
  if (!handler) return false;

  if (key === 'volume-down' || key === 'page-down') {
    handler.nextPage();
    return true;
  }
  if (key === 'volume-up' || key === 'page-up') {
    handler.prevPage();
    return true;
  }
  return false;
}

export function handleGlobalKeyDown(event: KeyboardEvent): void {
  const target = event.target as Element | null;
  if (isEditableElement(target)) {
    if (event.key === 'Escape') {
      (target as HTMLElement).blur();
      event.preventDefault();
    }
    return;
  }

  if (event.repeat && (event.key === 'PageDown' || event.key === 'PageUp' || event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === ' ')) {
    event.preventDefault();
    return;
  }

  const state = useRouteStore.getState();

  // Search shortcut: Ctrl/Cmd+F or `/` in Reader
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && state.screen === 'reader') {
    event.preventDefault();
    state.openSheet('contents', { contentsTab: 'search' });
    return;
  }

  if (event.ctrlKey || event.metaKey || event.altKey) return;

  if (event.key === 'Escape') {
    if (dispatchBackNavigation()) {
      event.preventDefault();
    }
    return;
  }

  const pageable = getTopmostPageableHandler(state);
  if (pageable) {
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || (event.key === ' ' && !event.shiftKey)) {
      event.preventDefault();
      pageable.nextPage();
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'PageUp' || (event.key === ' ' && event.shiftKey)) {
      event.preventDefault();
      pageable.prevPage();
      return;
    }
  }

  if (state.screen !== 'reader') return;

  switch (event.key) {
    case 't':
    case 'T':
      event.preventDefault();
      state.openSheet(state.activeSheet === 'contents' ? null : 'contents', { contentsTab: 'contents' });
      break;
    case '/':
      event.preventDefault();
      state.openSheet('contents', { contentsTab: 'search' });
      break;
    case 'b':
    case 'B':
      event.preventDefault();
      shortcutActions.toggleBookmark?.();
      break;
    case 'a':
    case 'A':
      event.preventDefault();
      state.openSheet(state.activeSheet === 'appearance' ? null : 'appearance');
      break;
    case 'r':
    case 'R':
      event.preventDefault();
      shortcutActions.toggleReadAloud?.();
      break;
    case 'p':
    case 'P':
    case 'MediaPlayPause':
      event.preventDefault();
      shortcutActions.togglePlayPause?.();
      break;
    case '[':
      event.preventDefault();
      shortcutActions.adjustSpeed?.(-0.1);
      break;
    case ']':
      event.preventDefault();
      shortcutActions.adjustSpeed?.(0.1);
      break;
    default:
      break;
  }
}

export function installKeymapAndPolicySync(
  host: PlatformHost,
  getSettings: () => AppSettings,
): () => void {
  if (typeof window === 'undefined') return () => {};

  let lastPushed: boolean | null = null;
  const syncPolicy = (): void => {
    const route = useRouteStore.getState();
    const next = computeKeyPolicyVolumePaging(getSettings(), host, route);
    if (next !== lastPushed) {
      lastPushed = next;
      void host.device.setKeyPolicy({ volumePaging: next }).catch(() => {});
    }
  };

  const onFocusIn = (e: FocusEvent): void => {
    useRouteStore.getState().setTextInputFocused(isEditableElement(e.target as Element | null));
  };
  const onFocusOut = (): void => {
    setTimeout(() => {
      useRouteStore.getState().setTextInputFocused(isEditableElement(document.activeElement));
    }, 0);
  };
  const onVisibility = (): void => {
    useRouteStore.getState().setAppVisible(document.visibilityState !== 'hidden');
  };

  const unsubRoute = useRouteStore.subscribe(syncPolicy);
  const unsubPageable = subscribePageableStack(syncPolicy);
  const unsubHost = host.subscribe((event) => {
    if (event.type === 'hardware-key') {
      handleHardwareKey(event.key);
    } else if (event.type === 'device-changed') {
      syncPolicy();
    }
  });

  window.addEventListener('keydown', handleGlobalKeyDown);
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);
  document.addEventListener('visibilitychange', onVisibility);

  syncPolicy();

  return () => {
    unsubRoute();
    unsubPageable();
    unsubHost();
    window.removeEventListener('keydown', handleGlobalKeyDown);
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('focusout', onFocusOut);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
