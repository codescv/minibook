import { create } from 'zustand';
import type { BookId } from '@minibook/core';

export type ScreenName = 'library' | 'reader' | 'settings';

export type ActiveSheetKind =
  | null
  | 'appearance'
  | 'contents'
  | 'voice'
  | 'sleep'
  | 'book-info'
  | 'custom-server'
  | 'licenses';

export type ContentsTab = 'contents' | 'bookmarks' | 'search';

export interface PageableHandler {
  readonly id: string;
  readonly layer: 'screen' | 'sheet';
  nextPage(): void;
  prevPage(): void;
}

export interface RouteState {
  screen: ScreenName;
  activeBookId: BookId | null;
  chromeOpen: boolean;
  readAloudBarOpen: boolean;
  activeSheet: ActiveSheetKind;
  contentsTab: ContentsTab;
  infoBookId: BookId | null;
  imagePreviewUrl: string | null;
  imagePreviewAlt: string;
  goToPercentOpen: boolean;
  textInputFocused: boolean;
  appVisible: boolean;
  flashPhase: 'black' | 'white' | null;
  noticeMessage: string | null;
  noticeActionLabel: string | null;
  noticeAction: (() => void) | null;

  openBook(bookId: BookId): void;
  openLibrary(): void;
  openSettings(): void;
  setChromeOpen(open: boolean): void;
  toggleChrome(): void;
  setReadAloudBarOpen(open: boolean): void;
  openSheet(sheet: ActiveSheetKind, opts?: { contentsTab?: ContentsTab; infoBookId?: BookId }): void;
  closeSheet(): void;
  setContentsTab(tab: ContentsTab): void;
  openImagePreview(url: string, alt?: string): void;
  closeImagePreview(): void;
  setGoToPercentOpen(open: boolean): void;
  setTextInputFocused(focused: boolean): void;
  setAppVisible(visible: boolean): void;
  setFlashPhase(phase: 'black' | 'white' | null): void;
  showNotice(msg: string, actionLabel?: string | null, action?: (() => void) | null): void;
  dismissNotice(): void;
  goBack(): boolean;
  reset(): void;
}

const pageableStack: PageableHandler[] = [];
const pageableListeners = new Set<() => void>();

function notifyPageableChange(): void {
  for (const fn of pageableListeners) fn();
}

export function registerPageableHandler(handler: PageableHandler): () => void {
  pageableStack.push(handler);
  notifyPageableChange();
  return () => {
    const idx = pageableStack.lastIndexOf(handler);
    if (idx >= 0) {
      pageableStack.splice(idx, 1);
      notifyPageableChange();
    }
  };
}

export function subscribePageableStack(fn: () => void): () => void {
  pageableListeners.add(fn);
  return () => {
    pageableListeners.delete(fn);
  };
}

export function getTopmostPageableHandler(state: Pick<RouteState, 'activeSheet' | 'imagePreviewUrl' | 'goToPercentOpen'>): PageableHandler | null {
  if (state.imagePreviewUrl || state.goToPercentOpen) return null;
  if (state.activeSheet !== null) {
    // Non-list sheets never delegate paging to background screens (ARCHITECTURE.md §9.5)
    if (state.activeSheet !== 'contents' && state.activeSheet !== 'voice') {
      return null;
    }
    for (let i = pageableStack.length - 1; i >= 0; i--) {
      const h = pageableStack[i]!;
      if (h.layer === 'sheet') return h;
    }
    return null;
  }
  for (let i = pageableStack.length - 1; i >= 0; i--) {
    const h = pageableStack[i]!;
    if (h.layer === 'screen') return h;
  }
  return null;
}

export function computeTopmostLayerIsPageable(
  state: Pick<RouteState, 'screen' | 'activeSheet' | 'imagePreviewUrl' | 'goToPercentOpen'>,
  isEink: boolean,
): boolean {
  if (state.imagePreviewUrl !== null || state.goToPercentOpen) return false;
  if (state.activeSheet !== null) {
    // Only sheets backed by PagedList (`contents` and `voice`) are pageable, and PagedList pages in E-Ink mode
    if (state.activeSheet === 'contents' || state.activeSheet === 'voice') {
      return isEink && getTopmostPageableHandler(state) !== null;
    }
    return false;
  }
  if (state.screen === 'reader') {
    return true;
  }
  // Library and Settings are backed by PagedList, which is pageable in E-Ink mode
  return isEink && getTopmostPageableHandler(state) !== null;
}

const INITIAL_STATE = {
  screen: 'library' as ScreenName,
  activeBookId: null as BookId | null,
  chromeOpen: false,
  readAloudBarOpen: false,
  activeSheet: null as ActiveSheetKind,
  contentsTab: 'contents' as ContentsTab,
  infoBookId: null as BookId | null,
  imagePreviewUrl: null as string | null,
  imagePreviewAlt: '',
  goToPercentOpen: false,
  textInputFocused: false,
  appVisible: true,
  flashPhase: null as 'black' | 'white' | null,
  noticeMessage: null as string | null,
  noticeActionLabel: null as string | null,
  noticeAction: null as (() => void) | null,
};

export const useRouteStore = create<RouteState>((set, get) => ({
  ...INITIAL_STATE,

  openBook(bookId) {
    set({
      screen: 'reader',
      activeBookId: bookId,
      chromeOpen: false,
      activeSheet: null,
      imagePreviewUrl: null,
      goToPercentOpen: false,
    });
  },

  openLibrary() {
    set({
      screen: 'library',
      chromeOpen: false,
      readAloudBarOpen: false,
      activeSheet: null,
      imagePreviewUrl: null,
      goToPercentOpen: false,
    });
  },

  openSettings() {
    set({
      screen: 'settings',
      chromeOpen: false,
      activeSheet: null,
      imagePreviewUrl: null,
      goToPercentOpen: false,
    });
  },

  setChromeOpen(open) {
    set({ chromeOpen: open, ...(open ? {} : { goToPercentOpen: false }) });
  },

  toggleChrome() {
    const s = get();
    if (s.activeSheet !== null) {
      set({ activeSheet: null });
      return;
    }
    set({ chromeOpen: !s.chromeOpen, goToPercentOpen: false });
  },

  setReadAloudBarOpen(open) {
    set({ readAloudBarOpen: open });
  },

  openSheet(sheet, opts) {
    set((prev) => ({
      activeSheet: sheet,
      contentsTab: opts?.contentsTab ?? prev.contentsTab,
      infoBookId: opts?.infoBookId ?? prev.infoBookId,
      goToPercentOpen: false,
    }));
  },

  closeSheet() {
    set({ activeSheet: null, infoBookId: null });
  },

  setContentsTab(tab) {
    set({ contentsTab: tab });
  },

  openImagePreview(url, alt = '') {
    set({ imagePreviewUrl: url, imagePreviewAlt: alt });
  },

  closeImagePreview() {
    set({ imagePreviewUrl: null, imagePreviewAlt: '' });
  },

  setGoToPercentOpen(open) {
    set({ goToPercentOpen: open });
  },

  setTextInputFocused(focused) {
    set({ textInputFocused: focused });
  },

  setAppVisible(visible) {
    set({ appVisible: visible });
  },

  setFlashPhase(phase) {
    set({ flashPhase: phase });
  },

  showNotice(msg, actionLabel = null, action = null) {
    set({ noticeMessage: msg, noticeActionLabel: actionLabel, noticeAction: action });
  },

  dismissNotice() {
    set({ noticeMessage: null, noticeActionLabel: null, noticeAction: null });
  },

  goBack() {
    const s = get();
    if (s.imagePreviewUrl !== null) {
      set({ imagePreviewUrl: null, imagePreviewAlt: '' });
      return true;
    }
    if (s.goToPercentOpen) {
      set({ goToPercentOpen: false });
      return true;
    }
    if (s.activeSheet !== null) {
      set({ activeSheet: null, infoBookId: null });
      return true;
    }
    if (s.screen === 'reader') {
      if (s.chromeOpen || s.readAloudBarOpen) {
        set({ chromeOpen: false, readAloudBarOpen: false });
        return true;
      }
      set({ screen: 'library', chromeOpen: false, readAloudBarOpen: false });
      return true;
    }
    if (s.screen === 'settings') {
      set({ screen: 'library' });
      return true;
    }
    return false;
  },

  reset() {
    pageableStack.length = 0;
    set({ ...INITIAL_STATE });
  },
}));
