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
  | 'licenses'
  | 'settings-voice'
  | 'kokoro-model'
  | 'kokoro-voices'
  | 'qwen-server';

export type ContentsTab = 'contents' | 'bookmarks' | 'search';

export interface PageableHandler {
  readonly id: string;
  readonly layer: 'screen' | 'sheet';
  nextPage(): void;
  prevPage(): void;
}

export interface OverlayTurnRequest {
  readonly swap: () => void | Promise<void>;
  readonly closedSheetCoveredHalfScreen?: boolean;
  readonly countTurn?: boolean;
}

export type OverlayTurnRunner = (req: OverlayTurnRequest) => Promise<void>;

let activeOverlayTurnRunner: OverlayTurnRunner | null = null;
let closingSheetPending = false;
let closingChromePending = false;

export function registerOverlayTurnRunner(runner: OverlayTurnRunner): () => void {
  activeOverlayTurnRunner = runner;
  return () => {
    if (activeOverlayTurnRunner === runner) {
      activeOverlayTurnRunner = null;
    }
  };
}

export function runOverlayTurn(req: OverlayTurnRequest): Promise<void> {
  if (activeOverlayTurnRunner) {
    return activeOverlayTurnRunner(req);
  }
  return Promise.resolve(req.swap());
}

export function measureOpenSheetCoveredHalf(): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;
  const sheet = document.querySelector<HTMLElement>('.mb-sheet');
  if (!sheet) return false;
  const rect = sheet.getBoundingClientRect();
  const vh = window.innerHeight || 800;
  return rect.height >= vh * 0.5;
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
  closeChromeWithRefresh(extraSwap?: () => void): void;
  setReadAloudBarOpen(open: boolean): void;
  openSheet(sheet: ActiveSheetKind, opts?: { contentsTab?: ContentsTab; infoBookId?: BookId }): void;
  closeSheet(): void;
  closeSheetWithRefresh(coveredHalfOverride?: boolean, extraSwap?: () => void): void;
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

const LIST_SHEETS = new Set<ActiveSheetKind>(['contents', 'voice', 'settings-voice', 'kokoro-voices']);

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

export function getTopmostPageableHandler(
  state: Pick<RouteState, 'activeSheet' | 'imagePreviewUrl' | 'goToPercentOpen'>,
): PageableHandler | null {
  if (state.imagePreviewUrl || state.goToPercentOpen) return null;
  if (state.activeSheet !== null) {
    // Non-list sheets never delegate paging to background screens (ARCHITECTURE.md §9.5)
    if (!LIST_SHEETS.has(state.activeSheet)) {
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
    // Only sheets backed by PagedList (`contents`, `voice`, `settings-voice`) are pageable in E-Ink mode
    if (LIST_SHEETS.has(state.activeSheet)) {
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
    closingSheetPending = false;
    closingChromePending = false;
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
    closingSheetPending = false;
    closingChromePending = false;
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
    closingSheetPending = false;
    closingChromePending = false;
    set({
      screen: 'settings',
      chromeOpen: false,
      activeSheet: null,
      imagePreviewUrl: null,
      goToPercentOpen: false,
    });
  },

  setChromeOpen(open) {
    if (!open) closingChromePending = false;
    set({ chromeOpen: open, ...(open ? {} : { goToPercentOpen: false }) });
  },

  closeChromeWithRefresh(extraSwap) {
    closingChromePending = true;
    void runOverlayTurn({
      closedSheetCoveredHalfScreen: false,
      swap: () => {
        closingChromePending = false;
        extraSwap?.();
        set({ chromeOpen: false, readAloudBarOpen: false, goToPercentOpen: false });
      },
    });
  },

  toggleChrome() {
    const s = get();
    if (s.activeSheet !== null && !closingSheetPending) {
      get().closeSheetWithRefresh();
      return;
    }
    if (s.chromeOpen && !closingChromePending) {
      get().closeChromeWithRefresh();
      return;
    }
    set({ chromeOpen: true, goToPercentOpen: false });
  },

  setReadAloudBarOpen(open) {
    set({ readAloudBarOpen: open });
  },

  openSheet(sheet, opts) {
    if (sheet === null) {
      get().closeSheetWithRefresh();
      return;
    }
    closingSheetPending = false;
    set((prev) => ({
      activeSheet: sheet,
      contentsTab: opts?.contentsTab ?? prev.contentsTab,
      infoBookId: opts?.infoBookId ?? prev.infoBookId,
      goToPercentOpen: false,
    }));
  },

  closeSheet() {
    closingSheetPending = false;
    set({ activeSheet: null, infoBookId: null });
  },

  closeSheetWithRefresh(coveredHalfOverride, extraSwap) {
    const coveredHalf = coveredHalfOverride ?? measureOpenSheetCoveredHalf();
    closingSheetPending = true;
    void runOverlayTurn({
      closedSheetCoveredHalfScreen: coveredHalf,
      swap: () => {
        closingSheetPending = false;
        extraSwap?.();
        set({ activeSheet: null, infoBookId: null });
      },
    });
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
    if (s.activeSheet !== null && !closingSheetPending) {
      get().closeSheetWithRefresh();
      return true;
    }
    if (s.screen === 'reader') {
      if ((s.chromeOpen || s.readAloudBarOpen) && !closingChromePending) {
        get().closeChromeWithRefresh();
        return true;
      }
      if (closingSheetPending || closingChromePending) {
        void runOverlayTurn({
          countTurn: false,
          swap: () => {
            closingSheetPending = false;
            closingChromePending = false;
            set({
              screen: 'library',
              chromeOpen: false,
              readAloudBarOpen: false,
              activeSheet: null,
              infoBookId: null,
            });
          },
        });
      } else {
        set({ screen: 'library', chromeOpen: false, readAloudBarOpen: false });
      }
      return true;
    }
    if (s.screen === 'settings') {
      if (closingSheetPending) {
        void runOverlayTurn({
          countTurn: false,
          swap: () => {
            closingSheetPending = false;
            set({ screen: 'library', activeSheet: null });
          },
        });
      } else {
        set({ screen: 'library' });
      }
      return true;
    }
    return false;
  },

  reset() {
    pageableStack.length = 0;
    closingSheetPending = false;
    closingChromePending = false;
    set({ ...INITIAL_STATE });
  },
}));
