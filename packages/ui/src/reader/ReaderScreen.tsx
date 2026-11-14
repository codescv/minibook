import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import type { BarePageCaptionMode, Bookmark, BookSession, Locator, SectionDoc } from '@minibook/core';
import { setReaderShortcutActions } from '../app/keymap';
import {
  measureOpenSheetCoveredHalf,
  registerPageableHandler,
  useRouteStore,
} from '../app/routes';
import {
  fractionForSessionLocator,
  fullSectionLengthFromDoc,
  loadFullSectionText,
  openBookWithHost,
  reanchorLocator,
  recordSectionDocLength,
  resolveLocatorForFraction,
  sectionShareForFraction,
} from '../host/core-bridge';
import { useHostContext } from '../host/HostContext';
import { useT } from '../i18n';
import { ReadAloudBar } from '../speech/ReadAloudBar';
import { useReadAloudStore, type ReadAloudController } from '../speech/ReadAloudController';
import { SleepTimerSheet, VoiceSheet } from '../speech/VoiceSheet';
import { Chrome } from './Chrome';
import { computePaginationGeometry } from './Paginator';
import { SectionFrameManager, type FilledFrameUnit } from './SectionFrame';
import { AppearanceSheet } from './sheets/Appearance';
import { ContentsSheet } from './sheets/Contents';

export interface ReaderScreenProps {
  readonly bookId: string;
  readonly readAloud: ReadAloudController;
}

function readSafeInsets(el: HTMLElement | null): { safeTop: number; safeBottom: number } {
  if (!el || typeof window === 'undefined') return { safeTop: 0, safeBottom: 0 };
  const probe = el.ownerDocument.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;padding-top:var(--m-safe-top,0px);padding-bottom:var(--m-safe-bottom,0px);';
  el.appendChild(probe);
  const cs = window.getComputedStyle(probe);
  const safeTop = parseFloat(cs.paddingTop) || 0;
  const safeBottom = parseFloat(cs.paddingBottom) || 0;
  probe.remove();
  return { safeTop, safeBottom };
}

function computePageRange(
  unit: FilledFrameUnit,
  page: number,
): { readonly startLoc: Locator; readonly endOffset: number } {
  const startLoc = unit.paginator.firstVisibleLocator(page);
  const total = unit.paginator.getPageCount();
  const endOffset =
    page + 1 < total
      ? unit.paginator.firstVisibleLocator(page + 1).offset
      : unit.sectionDoc.unit.end;
  return { startLoc, endOffset };
}

export function ReaderScreen({ bookId, readAloud }: ReaderScreenProps): ReactElement {
  const t = useT();
  const { host, settings, isEink, refreshController, updateSettings } = useHostContext();

  const isReaderScreen = useRouteStore((s) => s.screen === 'reader');
  const chromeOpen = useRouteStore((s) => s.chromeOpen);
  const activeSheet = useRouteStore((s) => s.activeSheet);
  const imagePreviewUrl = useRouteStore((s) => s.imagePreviewUrl);
  const imagePreviewAlt = useRouteStore((s) => s.imagePreviewAlt);

  const raActive = useReadAloudStore((s) => s.active);
  const raBookId = useReadAloudStore((s) => s.bookId);
  const raUtterance = useReadAloudStore((s) => s.activeUtterance);
  const raWord = useReadAloudStore((s) => s.activeWordRange);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const frameManagerRef = useRef<SectionFrameManager | null>(null);
  const sessionRef = useRef<BookSession | null>(null);

  /**
   * Sticky reading anchor (`[P1-U2]` / DoD #2):
   * Updated ONLY by intentional navigation (open, manual turn, link/TOC/scrubber jump, TTS advance).
   * Never overwritten by relayout (`fontScale`, `margins`, `lineSpacing`, `ResizeObserver`, late fonts/images),
   * eliminating cumulative backward page-boundary rounding drift.
   */
  const readingAnchorRef = useRef<Locator>({ section: 0, offset: 0 });
  const relayoutFnRef = useRef<() => void>(() => {});

  const [session, setSession] = useState<BookSession | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sectionIndex, setSectionIndex] = useState<number>(0);
  const [unitIndex, setUnitIndex] = useState<number>(0);
  const [pageIndex, setPageIndex] = useState<number>(0);
  const [pageCount, setPageCount] = useState<number>(1);
  const [rightMarginPx, setRightMarginPx] = useState<number>(32);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [selectionState, setSelectionState] = useState<{ text: string; locator: Locator } | null>(null);
  const [finishedScreen, setFinishedScreen] = useState<boolean>(false);
  const [backJump, setBackJump] = useState<{ locator: Locator; label: string } | null>(null);
  const [searchHighlight, setSearchHighlight] = useState<{
    section: number;
    start: number;
    end: number;
  } | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void host.device.setImmersive(true).catch(() => {});
    return () => {
      void host.device.setImmersive(false).catch(() => {});
      void host.device.setKeepScreenOn(false).catch(() => {});
    };
  }, [host]);

  useEffect(() => {
    void host.device.setKeepScreenOn(Boolean(settings.keepScreenOn && !isEink)).catch(() => {});
  }, [host, settings.keepScreenOn, isEink]);

  const schedulePositionSave = useCallback(
    (sess: BookSession, unit: FilledFrameUnit, anchorLoc: Locator) => {
      const fullLen = recordSectionDocLength(sess, unit.sectionDoc);
      const frac = fractionForSessionLocator(sess, anchorLoc, fullLen);
      const localOff = Math.max(0, anchorLoc.offset - unit.sectionDoc.unit.start);
      const snippet = unit.sectionDoc.text.text.slice(localOff, localOff + 32);

      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        void host.state
          .savePosition(bookId, {
            section: anchorLoc.section,
            offset: anchorLoc.offset,
            fraction: frac,
            snippet,
            updatedAt: Date.now(),
          })
          .catch(() => {});
      }, 450);
    },
    [host, bookId],
  );

  const loadAndShowUnit = useCallback(
    async (
      sess: BookSession,
      targetSection: number,
      options?: {
        readonly targetOffset?: number;
        readonly targetEndOfSection?: boolean;
        readonly targetUnitIndex?: number;
        readonly preserveStickyAnchor?: boolean;
        readonly notifySpeechFollow?: boolean;
      },
    ): Promise<FilledFrameUnit | null> => {
      const stage = stageRef.current;
      const mgr = frameManagerRef.current;
      if (!stage || !mgr) return null;

      let chosenDoc: SectionDoc;
      let chosenUnitIdx = options?.targetUnitIndex ?? 0;

      if (sess.loadSectionUnits && (options?.targetOffset !== undefined || options?.targetEndOfSection)) {
        const allUnits = await sess.loadSectionUnits(targetSection);
        if (options.targetEndOfSection) {
          chosenUnitIdx = Math.max(0, allUnits.length - 1);
          chosenDoc = allUnits[chosenUnitIdx]!;
        } else {
          const off = options.targetOffset ?? 0;
          const foundIdx = allUnits.findIndex((u) => off >= u.unit.start && off < u.unit.end);
          chosenUnitIdx = foundIdx >= 0 ? foundIdx : Math.max(0, allUnits.length - 1);
          chosenDoc = allUnits[chosenUnitIdx]!;
        }
      } else {
        chosenDoc = await sess.loadSection(targetSection, chosenUnitIdx);
      }

      const w = stage.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 393) || 393;
      const h = stage.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 852) || 852;
      const { safeTop, safeBottom } = readSafeInsets(stage);

      const filled = await mgr.renderActive({
        session: sess,
        sectionDoc: chosenDoc,
        settings,
        isEink,
        frameWidth: w,
        frameHeight: h,
        safeTop,
        safeBottom,
      });
      recordSectionDocLength(sess, filled.sectionDoc);

      const totalPages = filled.paginator.getPageCount();
      let destPage = 0;
      if (options?.targetEndOfSection) {
        destPage = Math.max(0, totalPages - 1);
      } else if (options?.targetOffset !== undefined) {
        destPage = filled.paginator.pageOf(options.targetOffset);
      }

      filled.paginator.goToPage(destPage, { animate: false, isEink });

      if (!options?.preserveStickyAnchor) {
        readingAnchorRef.current =
          options?.targetOffset !== undefined
            ? { section: targetSection, offset: options.targetOffset }
            : filled.paginator.firstVisibleLocator(destPage);
      }

      setSectionIndex(targetSection);
      setUnitIndex(chosenUnitIdx);
      setPageIndex(destPage);
      setPageCount(totalPages);
      setRightMarginPx(filled.paginator.getGeometry().G / 2);
      setFinishedScreen(false);
      schedulePositionSave(sess, filled, readingAnchorRef.current);

      if (options?.notifySpeechFollow) {
        const { startLoc, endOffset } = computePageRange(filled, destPage);
        readAloud.notifyManualPageTurn(startLoc, endOffset);
      }

      // Asynchronously pre-render next and (in normal mode) prev adjacent units for instant & 1:1 edge-drag chapter turns (`§6.1`)
      const totalUnits = chosenDoc.units?.length ?? 1;
      const nextUnitSameSec = chosenUnitIdx + 1 < totalUnits ? chosenUnitIdx + 1 : null;
      const nextSection =
        nextUnitSameSec !== null
          ? targetSection
          : sess.spine.find((s) => s.index > targetSection && s.linear)?.index ?? null;
      if (nextSection !== null) {
        void sess
          .loadSection(nextSection, nextUnitSameSec ?? 0)
          .then((adjDoc) =>
            mgr.prerenderAdjacent(
              {
                session: sess,
                sectionDoc: adjDoc,
                settings,
                isEink,
                frameWidth: w,
                frameHeight: h,
                safeTop,
                safeBottom,
              },
              'next',
            ),
          )
          .catch(() => {});
      } else {
        mgr.clearNeighbor('next');
      }

      if (!isEink) {
        const prevUnitSameSec = chosenUnitIdx > 0 ? chosenUnitIdx - 1 : null;
        const prevSection =
          prevUnitSameSec !== null
            ? targetSection
            : [...sess.spine].reverse().find((s) => s.index < targetSection && s.linear)?.index ??
              null;
        if (prevSection !== null) {
          void (async () => {
            try {
              let prevDoc: SectionDoc;
              if (prevUnitSameSec !== null) {
                prevDoc = await sess.loadSection(prevSection, prevUnitSameSec);
              } else if (sess.loadSectionUnits) {
                const prevUnits = await sess.loadSectionUnits(prevSection);
                prevDoc = prevUnits[Math.max(0, prevUnits.length - 1)]!;
              } else {
                prevDoc = await sess.loadSection(prevSection, 0);
              }
              await mgr.prerenderAdjacent(
                {
                  session: sess,
                  sectionDoc: prevDoc,
                  settings,
                  isEink,
                  frameWidth: w,
                  frameHeight: h,
                  safeTop,
                  safeBottom,
                },
                'prev',
              );
            } catch {
              // Non-fatal pre-render failure
            }
          })();
        } else {
          mgr.clearNeighbor('prev');
        }
      } else {
        mgr.clearNeighbor('prev');
      }

      return filled;
    },
    [settings, isEink, schedulePositionSave, readAloud],
  );

  const turnPage = useCallback(
    (delta: -1 | 1, manual = true): void => {
      const sess = sessionRef.current;
      const active = frameManagerRef.current?.getActive();
      if (!sess || !active) return;

      setSearchHighlight(null);

      const performSwap = async (): Promise<void> => {
        if (manual && useRouteStore.getState().chromeOpen) {
          useRouteStore.getState().setChromeOpen(false);
        }
        const curPage = active.paginator.getCurrentPage();
        const total = active.paginator.getPageCount();

        if (delta > 0) {
          if (curPage + 1 < total) {
            const next = active.paginator.goToPage(curPage + 1, { animate: manual, isEink });
            const { startLoc, endOffset } = computePageRange(active, next);
            readingAnchorRef.current = startLoc;
            setPageIndex(next);
            schedulePositionSave(sess, active, startLoc);
            if (manual) {
              readAloud.notifyManualPageTurn(startLoc, endOffset);
            }
            return;
          }

          const unitsCount = active.sectionDoc.units?.length ?? 1;
          if (unitIndex + 1 < unitsCount) {
            await loadAndShowUnit(sess, sectionIndex, {
              targetUnitIndex: unitIndex + 1,
              notifySpeechFollow: manual,
            });
            return;
          }

          const nextLinear = sess.spine.find((s) => s.index > sectionIndex && s.linear);
          if (nextLinear) {
            await loadAndShowUnit(sess, nextLinear.index, {
              targetOffset: 0,
              notifySpeechFollow: manual,
            });
            return;
          }

          setFinishedScreen(true);
          void host.library.setFinished(bookId, true).catch(() => {});
        } else {
          if (finishedScreen) {
            setFinishedScreen(false);
            return;
          }
          if (curPage > 0) {
            const prev = active.paginator.goToPage(curPage - 1, { animate: manual, isEink });
            const { startLoc, endOffset } = computePageRange(active, prev);
            readingAnchorRef.current = startLoc;
            setPageIndex(prev);
            schedulePositionSave(sess, active, startLoc);
            if (manual) {
              readAloud.notifyManualPageTurn(startLoc, endOffset);
            }
            return;
          }

          if (unitIndex > 0) {
            await loadAndShowUnit(sess, sectionIndex, {
              targetUnitIndex: unitIndex - 1,
              targetEndOfSection: true,
              notifySpeechFollow: manual,
            });
            return;
          }

          const prevLinear = [...sess.spine]
            .reverse()
            .find((s) => s.index < sectionIndex && s.linear);
          if (prevLinear) {
            await loadAndShowUnit(sess, prevLinear.index, {
              targetEndOfSection: true,
              notifySpeechFollow: manual,
            });
          }
        }
      };

      void refreshController.runTurn({
        isEink,
        cadence: settings.fullRefreshEvery,
        swap: performSwap,
      });
    },
    [
      chromeOpen,
      isEink,
      settings.fullRefreshEvery,
      refreshController,
      schedulePositionSave,
      readAloud,
      unitIndex,
      sectionIndex,
      loadAndShowUnit,
      finishedScreen,
      host,
      bookId,
    ],
  );

  const gestureHandlersRef = useRef({
    onPrev: () => {},
    onNext: () => {},
    onToggleChrome: () => {},
    onInternalLink: (_dest: string) => {},
    onExternalLink: (_url: string) => {},
    onReadAloudTap: (_loc: Locator): boolean => false,
  });

  gestureHandlersRef.current = {
    onPrev: () => turnPage(-1, true),
    onNext: () => turnPage(1, true),
    onToggleChrome: () => {
      const route = useRouteStore.getState();
      if (route.activeSheet !== null) {
        route.closeSheetWithRefresh();
        return;
      }
      if (raActive && raBookId === bookId) {
        if (route.readAloudBarOpen) {
          route.setReadAloudBarOpen(false);
          route.setChromeOpen(true);
        } else if (route.chromeOpen) {
          route.closeChromeWithRefresh();
        } else {
          route.setReadAloudBarOpen(true);
        }
        return;
      }
      route.toggleChrome();
    },
    onInternalLink: (rawTarget: string) => {
      const sess = sessionRef.current;
      const active = frameManagerRef.current?.getActive();
      if (!sess || !active) return;
      const resolved = sess.resolveHref(sectionIndex, rawTarget);
      if (!resolved) return;
      if ('external' in resolved) {
        void host.files.openExternal(resolved.external);
        return;
      }
      setBackJump({ locator: readingAnchorRef.current, label: `p. ${pageIndex + 1}` });
      void refreshController.runTurn({
        isEink,
        cadence: settings.fullRefreshEvery,
        swap: async () => {
          await loadAndShowUnit(sess, resolved.section, {
            targetOffset: resolved.offset,
            notifySpeechFollow: true,
          });
        },
      });
    },
    onExternalLink: (url: string) => {
      void host.files.openExternal(url);
    },
    onReadAloudTap: (loc: Locator) => {
      const route = useRouteStore.getState();
      if (
        raActive &&
        raBookId === bookId &&
        route.readAloudBarOpen &&
        route.activeSheet === null
      ) {
        readingAnchorRef.current = loc;
        return readAloud.seekToLocator(loc);
      }
      return false;
    },
  };

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const mgr = new SectionFrameManager(stage, {
      onPrevPage: () => gestureHandlersRef.current.onPrev(),
      onNextPage: () => gestureHandlersRef.current.onNext(),
      onToggleChrome: () => gestureHandlersRef.current.onToggleChrome(),
      onInternalLink: (tDest) => gestureHandlersRef.current.onInternalLink(tDest),
      onExternalLink: (url) => gestureHandlersRef.current.onExternalLink(url),
      onImageZoom: (src, alt) => useRouteStore.getState().openImagePreview(src, alt),
      onSelectionChange: (sel) => setSelectionState(sel),
      onReadAloudTapLocator: (loc) => gestureHandlersRef.current.onReadAloudTap(loc),
      onContentRelayout: () => relayoutFnRef.current(),
    });
    frameManagerRef.current = mgr;

    let cancelled = false;
    setErrorMsg(null);

    void (async () => {
      try {
        const [detail, savedPos, initialBookmarks] = await Promise.all([
          host.library.get(bookId),
          host.state.getPosition(bookId),
          host.state.listBookmarks(bookId),
        ]);
        if (cancelled) return;
        setBookmarks(initialBookmarks);

        const sess = await openBookWithHost(host, bookId, detail);
        if (cancelled) {
          sess.close();
          return;
        }
        sessionRef.current = sess;
        setSession(sess);

        const ra = useReadAloudStore.getState();
        if (ra.active && ra.bookId === bookId && ra.activeUtterance) {
          await loadAndShowUnit(sess, ra.activeUtterance.section, {
            targetOffset: ra.activeUtterance.start,
          });
          return;
        }

        if (savedPos) {
          const fullText = await loadFullSectionText(sess, savedPos.section);
          const anchored = reanchorLocator(fullText, savedPos);
          await loadAndShowUnit(sess, savedPos.section, { targetOffset: anchored });
        } else {
          const firstLinear = sess.spine.find((s) => s.linear)?.index ?? 0;
          await loadAndShowUnit(sess, firstLinear, { targetOffset: 0 });
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : t('errorCorrupt'));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      mgr.disposeAll();
      frameManagerRef.current = null;
      sessionRef.current?.close();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, host]);

  // Live re-pagination on Appearance / E-Ink / viewport resize / late image/font load
  // Always re-anchors to sticky `readingAnchorRef.current` without mutating it (`[P1-U2]`).
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const active = frameManagerRef.current?.getActive();
    const sess = sessionRef.current;
    if (!stage || !active || !sess) return;

    const applyRelayout = (): void => {
      const curUnit = frameManagerRef.current?.getActive();
      const curSess = sessionRef.current;
      if (!curUnit || !curSess || !stageRef.current) return;

      const anchor = readingAnchorRef.current;
      const unitRange = curUnit.sectionDoc.unit;
      if (
        anchor.section === curUnit.sectionDoc.index &&
        unitRange.end > unitRange.start &&
        (anchor.offset < unitRange.start || anchor.offset >= unitRange.end)
      ) {
        void loadAndShowUnit(curSess, anchor.section, {
          targetOffset: anchor.offset,
          preserveStickyAnchor: true,
        });
        return;
      }

      const w = stageRef.current.clientWidth || window.innerWidth || 393;
      const h = stageRef.current.clientHeight || window.innerHeight || 852;
      const { safeTop, safeBottom } = readSafeInsets(stageRef.current);
      const geom = computePaginationGeometry({
        frameWidth: w,
        frameHeight: h,
        fontScale: settings.fontScale,
        margins: settings.margins,
        safeTop,
        safeBottom,
        isEink,
        ...(curUnit.sectionDoc.isCoverLike !== undefined
          ? { isCoverLike: curUnit.sectionDoc.isCoverLike }
          : {}),
      });
      curUnit.updateStylesAndLayout(settings, isEink, geom);
      frameManagerRef.current?.updateNeighborsStylesAndLayout({
        settings,
        isEink,
        frameWidth: w,
        frameHeight: h,
        safeTop,
        safeBottom,
      });
      const newPage = curUnit.paginator.pageOf(anchor.offset);
      curUnit.paginator.goToPage(newPage, { animate: false, isEink });
      setPageIndex(newPage);
      setPageCount(curUnit.paginator.getPageCount());
      setRightMarginPx(geom.G / 2);
    };

    relayoutFnRef.current = applyRelayout;
    applyRelayout();

    const ro = new ResizeObserver(() => {
      if (useRouteStore.getState().textInputFocused) return;
      applyRelayout();
    });
    ro.observe(stage);
    return () => ro.disconnect();
  }, [
    settings.fontScale,
    settings.fontFamily,
    settings.lineSpacing,
    settings.margins,
    settings.justify,
    settings.theme,
    settings.matchSystemTheme,
    settings.textBoldness,
    isEink,
    loadAndShowUnit,
  ]);

  useEffect(() => {
    if (!isReaderScreen) return;
    return registerPageableHandler({
      id: 'reader-paginator',
      layer: 'screen',
      nextPage: () => turnPage(1, true),
      prevPage: () => turnPage(-1, true),
    });
  }, [turnPage, isReaderScreen]);

  // Connect ReadAloudController view adapter (exposing `visibleUnitRange` for `[P1-U3]`)
  useEffect(() => {
    readAloud.attachViewAdapter({
      get visibleSection() {
        return sectionIndex;
      },
      get visibleUnitRange() {
        return frameManagerRef.current?.getActive()?.sectionDoc.unit ?? { start: 0, end: 0 };
      },
      currentPage: () => frameManagerRef.current?.getActive()?.paginator.getCurrentPage() ?? 0,
      pageOf: (off) => frameManagerRef.current?.getActive()?.paginator.pageOf(off) ?? 0,
      countCharsOnPage: (s, e, p) =>
        frameManagerRef.current?.getActive()?.paginator.countCharsOnPage(s, e, p) ?? 1,
      goToPage: (targetPage) => {
        const active = frameManagerRef.current?.getActive();
        const sess = sessionRef.current;
        if (!active || !sess) return;
        void refreshController.runTurn({
          isEink,
          cadence: settings.fullRefreshEvery,
          swap: () => {
            const p = active.paginator.goToPage(targetPage, { animate: true, isEink });
            const loc = active.paginator.firstVisibleLocator(p);
            readingAnchorRef.current = loc;
            setPageIndex(p);
            schedulePositionSave(sess, active, loc);
          },
        });
      },
      jumpToLocator: (loc) => {
        const sess = sessionRef.current;
        if (!sess) return;
        readingAnchorRef.current = loc;
        void refreshController.runTurn({
          isEink,
          cadence: settings.fullRefreshEvery,
          swap: async () => {
            await loadAndShowUnit(sess, loc.section, { targetOffset: loc.offset });
          },
        });
      },
    });

    const onVis = (): void => {
      if (document.visibilityState === 'visible') {
        void readAloud.reconcileOnWake();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      readAloud.attachViewAdapter(null);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [
    readAloud,
    sectionIndex,
    isEink,
    settings.fullRefreshEvery,
    refreshController,
    schedulePositionSave,
    loadAndShowUnit,
  ]);

  useEffect(() => {
    const active = frameManagerRef.current?.getActive();
    if (!active) return;

    if (raActive && raBookId === bookId && raUtterance && raUtterance.section === sectionIndex) {
      active.highlighter.paintSpeech({
        sentence: { start: raUtterance.start, end: raUtterance.end },
        word: raWord,
        settings,
        isEink,
      });
    } else {
      active.highlighter.paintSpeech({
        sentence: null,
        word: null,
        settings,
        isEink,
      });
    }

    if (searchHighlight && searchHighlight.section === sectionIndex) {
      active.highlighter.paintSearchHit(
        { start: searchHighlight.start, end: searchHighlight.end },
        isEink,
      );
    } else {
      active.highlighter.paintSearchHit(null, isEink);
    }
  }, [
    raActive,
    raBookId,
    bookId,
    raUtterance,
    raWord,
    sectionIndex,
    unitIndex,
    pageIndex,
    settings,
    isEink,
    searchHighlight,
  ]);

  const activeUnit = frameManagerRef.current?.getActive() ?? null;
  const currentFirstLoc: Locator = activeUnit
    ? activeUnit.paginator.firstVisibleLocator(pageIndex)
    : readingAnchorRef.current;

  const currentFraction = session
    ? fractionForSessionLocator(
        session,
        currentFirstLoc,
        activeUnit ? fullSectionLengthFromDoc(activeUnit.sectionDoc) : undefined,
      )
    : 0;

  const currentChapterTitle =
    session?.spine.find((s) => s.index === sectionIndex)?.title ??
    session?.toc.find((item) => item.locator.section === sectionIndex)?.title ??
    '';

  const currentBookmark = bookmarks.find((bm) => {
    if (bm.section !== sectionIndex || !activeUnit) return false;
    return activeUnit.paginator.pageOf(bm.offset) === pageIndex;
  });

  const handleToggleBookmark = useCallback(() => {
    if (!session || !activeUnit) return;
    if (currentBookmark) {
      void host.state.removeBookmark(bookId, currentBookmark.id).then(async () => {
        setBookmarks(await host.state.listBookmarks(bookId));
      });
    } else {
      const localOff = Math.max(0, currentFirstLoc.offset - activeUnit.sectionDoc.unit.start);
      const label =
        activeUnit.sectionDoc.text.text.slice(localOff, localOff + 60).trim() ||
        currentChapterTitle ||
        session.meta.title;
      void host.state
        .addBookmark(bookId, {
          section: currentFirstLoc.section,
          offset: currentFirstLoc.offset,
          fraction: currentFraction,
          label,
        })
        .then(async () => {
          setBookmarks(await host.state.listBookmarks(bookId));
        });
    }
  }, [
    session,
    activeUnit,
    currentBookmark,
    host,
    bookId,
    currentFirstLoc,
    currentChapterTitle,
    currentFraction,
  ]);

  const handleStartReadAloud = useCallback(
    (fromSelectionLocator?: Locator) => {
      const sess = session ?? sessionRef.current;
      const curActive = frameManagerRef.current?.getActive();
      const pageRange = curActive ? computePageRange(curActive, pageIndex) : null;
      void readAloud.start({
        bookId,
        startLocator: fromSelectionLocator ?? pageRange?.startLoc ?? currentFirstLoc,
        ...(fromSelectionLocator === undefined && pageRange !== null
          ? { pageEndOffset: pageRange.endOffset }
          : {}),
        preferContaining: fromSelectionLocator !== undefined,
        ...(sess ? { sharedSession: sess } : {}),
        ...(sess ? { chapterTitle: currentChapterTitle || sess.meta.title } : {}),
      });
    },
    [session, readAloud, bookId, pageIndex, currentFirstLoc, currentChapterTitle],
  );

  useEffect(() => {
    return setReaderShortcutActions({
      toggleBookmark: handleToggleBookmark,
      toggleReadAloud: () => {
        if (raActive && raBookId === bookId) readAloud.stop();
        else handleStartReadAloud();
      },
      togglePlayPause: () => {
        if (raActive && raBookId === bookId) readAloud.togglePlayPause();
        else handleStartReadAloud();
      },
      adjustSpeed: (delta) => {
        if (raActive && raBookId === bookId) {
          readAloud.setRate(useReadAloudStore.getState().rate + delta);
        }
      },
    });
  }, [handleToggleBookmark, handleStartReadAloud, raActive, raBookId, bookId, readAloud]);

  const handleSheetClose = useCallback((coveredHalf: boolean) => {
    useRouteStore.getState().closeSheetWithRefresh(coveredHalf);
  }, []);

  const pagesLeft = Math.max(0, pageCount - pageIndex - 1);
  const cycleCaptionMode = (): void => {
    const order: readonly BarePageCaptionMode[] = ['pages-left', 'percent', 'hidden'];
    const idx = order.indexOf(settings.captionMode);
    const next = order[(idx + 1) % order.length] ?? 'pages-left';
    void updateSettings({ captionMode: next });
  };

  const captionText =
    settings.captionMode === 'hidden'
      ? ''
      : settings.captionMode === 'percent'
        ? `${Math.round(currentFraction * 100)}%`
        : pagesLeft === 0
          ? t('lastPageOfChapter')
          : pagesLeft === 1
            ? t('onePageLeftInChapter')
            : t('pagesLeftInChapter', { n: pagesLeft });

  if (errorMsg) {
    return (
      <main className="mb-reader">
        <section className="mb-empty-state">
          <p className="mb-empty-desc">{errorMsg}</p>
          <button
            type="button"
            className="mb-primary-btn"
            onClick={() => useRouteStore.getState().openLibrary()}
          >
            {t('backToLibrary')}
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="mb-reader" data-testid="reader-screen">
      <div ref={stageRef} className="mb-reader-stage" data-testid="reader-stage" />

      {!chromeOpen &&
        !(raActive && raBookId === bookId && useRouteStore.getState().readAloudBarOpen) &&
        !finishedScreen && (
          <button
            type="button"
            className="mb-page-caption"
            style={{ right: `${rightMarginPx}px` }}
            aria-label="Reading progress caption"
            onClick={cycleCaptionMode}
          >
            {captionText}
          </button>
        )}

      {finishedScreen && (
        <section className="mb-image-viewer" aria-label={t('finishedBook')}>
          <h2 className="mb-library-title" style={{ marginBottom: 16 }}>
            {t('finishedBook')}
          </h2>
          <button
            type="button"
            className="mb-primary-btn"
            onClick={() => useRouteStore.getState().openLibrary()}
          >
            {t('backToLibrary')}
          </button>
        </section>
      )}

      {selectionState && (
        <div className="mb-selection-bar" role="toolbar" aria-label="Text selection actions">
          <button
            type="button"
            className="mb-icon-btn"
            onClick={() => {
              void navigator.clipboard?.writeText(selectionState.text).catch(() => {});
              activeUnit?.frameDoc.getSelection()?.removeAllRanges();
              setSelectionState(null);
            }}
          >
            {t('copy')}
          </button>
          <button
            type="button"
            className="mb-icon-btn"
            onClick={() => {
              const target = selectionState.locator;
              activeUnit?.frameDoc.getSelection()?.removeAllRanges();
              setSelectionState(null);
              handleStartReadAloud(target);
            }}
          >
            {t('readFromHere')}
          </button>
        </div>
      )}

      <Chrome
        open={chromeOpen}
        isEink={isEink}
        bookTitle={session?.meta.title ?? ''}
        chapterTitle={currentChapterTitle}
        fraction={currentFraction}
        isBookmarked={Boolean(currentBookmark)}
        backJumpLabel={backJump?.label ?? null}
        onBackToLibrary={() => useRouteStore.getState().openLibrary()}
        onManualRefresh={() => {
          void refreshController.runTurn({
            isEink: true,
            cadence: settings.fullRefreshEvery,
            userPressedRefresh: true,
            swap: () => {},
          });
        }}
        onToggleBookmark={handleToggleBookmark}
        onStartReadAloud={() => handleStartReadAloud()}
        onScrubFraction={(targetFrac) => {
          if (!session) return;
          setBackJump({ locator: readingAnchorRef.current, label: `${Math.round(currentFraction * 100)}%` });
          void refreshController.runTurn({
            isEink,
            cadence: settings.fullRefreshEvery,
            swap: async () => {
              const dest = await resolveLocatorForFraction(session, targetFrac);
              await loadAndShowUnit(session, dest.section, {
                targetOffset: dest.offset,
                notifySpeechFollow: true,
              });
            },
          });
        }}
        onPreviewChapterForFraction={(frac) => {
          if (!session) return '';
          const { section } = sectionShareForFraction(session.spine, frac);
          return (
            session.spine.find((s) => s.index === section)?.title ??
            session.meta.title
          );
        }}
        onStepChapter={(delta) => {
          if (!session) return;
          const linear = session.spine.filter((s) => s.linear);
          const curPos = linear.findIndex((s) => s.index === sectionIndex);
          const target = linear[Math.max(0, Math.min(linear.length - 1, curPos + delta))];
          if (target) {
            void refreshController.runTurn({
              isEink,
              cadence: settings.fullRefreshEvery,
              swap: async () => {
                await loadAndShowUnit(session, target.index, {
                  targetOffset: 0,
                  notifySpeechFollow: true,
                });
              },
            });
          }
        }}
        onReturnBackJump={() => {
          if (!session || !backJump) return;
          const target = backJump.locator;
          setBackJump(null);
          void refreshController.runTurn({
            isEink,
            cadence: settings.fullRefreshEvery,
            swap: async () => {
              await loadAndShowUnit(session, target.section, {
                targetOffset: target.offset,
                notifySpeechFollow: true,
              });
            },
          });
        }}
      />

      <ReadAloudBar controller={readAloud} isEink={isEink} bookId={bookId} />

      <AppearanceSheet
        open={activeSheet === 'appearance'}
        onClose={handleSheetClose}
      />

      <ContentsSheet
        open={activeSheet === 'contents'}
        session={session}
        currentSection={sectionIndex}
        bookmarks={bookmarks}
        onSelectLocator={(loc, matchLen) => {
          if (!session) return;
          const coveredHalf = measureOpenSheetCoveredHalf();
          setBackJump({ locator: readingAnchorRef.current, label: `p. ${pageIndex + 1}` });
          if (matchLen && matchLen > 0) {
            setSearchHighlight({
              section: loc.section,
              start: loc.offset,
              end: loc.offset + matchLen,
            });
          } else {
            setSearchHighlight(null);
          }
          void refreshController.runTurn({
            isEink,
            cadence: settings.fullRefreshEvery,
            closedSheetCoveredHalfScreen: coveredHalf,
            swap: async () => {
              useRouteStore.getState().closeSheet();
              useRouteStore.getState().setChromeOpen(false);
              await loadAndShowUnit(session, loc.section, {
                targetOffset: loc.offset,
                notifySpeechFollow: true,
              });
            },
          });
        }}
        onRemoveBookmark={(id) => {
          void host.state.removeBookmark(bookId, id).then(async () => {
            setBookmarks(await host.state.listBookmarks(bookId));
          });
        }}
        onClose={handleSheetClose}
      />

      <VoiceSheet
        open={activeSheet === 'voice'}
        controller={readAloud}
        onCloseSheet={handleSheetClose}
      />

      <SleepTimerSheet
        open={activeSheet === 'sleep'}
        controller={readAloud}
        onCloseSheet={handleSheetClose}
      />

      {imagePreviewUrl && (
        <section
          className="mb-image-viewer"
          role="dialog"
          aria-label={imagePreviewAlt || 'Image preview'}
          onClick={() => useRouteStore.getState().closeImagePreview()}
        >
          <img src={imagePreviewUrl} alt={imagePreviewAlt} />
        </section>
      )}
    </main>
  );
}
