import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { DEFAULT_APP_SETTINGS, type PlatformHost, type SpeechPlayer } from '@minibook/core';
import { AppErrorBoundary } from './ErrorBoundary';
import { installGlobalBackHandler } from './back';
import { installKeymapAndPolicySync } from './keymap';
import { useRouteStore } from './routes';
import { IconButton } from '../components/IconButton';
import { CloseIcon } from '../components/icons';
import { FlashOverlay } from '../eink/FlashOverlay';
import { HostProvider, useHostContext, useSettingsStore } from '../host/HostContext';
import { resolveLocale, translate } from '../i18n';
import { useImportStore } from '../library/ImportController';
import { LibraryScreen } from '../library/LibraryScreen';
import { ReaderScreen } from '../reader/ReaderScreen';
import { SettingsScreen } from '../settings/SettingsScreen';
import { ReadAloudController } from '../speech/ReadAloudController';
import { computeEffectiveEink } from '../theme/theme-manager';

export interface AppProps {
  readonly host: PlatformHost;
  readonly speechPlayer: SpeechPlayer;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function AppShell(): ReactElement {
  const { host, speechPlayer, isEink } = useHostContext();
  const screen = useRouteStore((s) => s.screen);
  const activeBookId = useRouteStore((s) => s.activeBookId);
  const noticeMessage = useRouteStore((s) => s.noticeMessage);
  const noticeActionLabel = useRouteStore((s) => s.noticeActionLabel);
  const noticeAction = useRouteStore((s) => s.noticeAction);

  const instant = isEink || prefersReducedMotion();
  const libraryLayerRef = useRef<HTMLDivElement | null>(null);
  const readerLayerRef = useRef<HTMLDivElement | null>(null);
  const settingsLayerRef = useRef<HTMLDivElement | null>(null);

  const readerActive = screen === 'reader' && Boolean(activeBookId);
  const settingsActive = screen === 'settings';

  const [retainedBookId, setRetainedBookId] = useState<string | null>(activeBookId);
  const [readerMounted, setReaderMounted] = useState<boolean>(readerActive);
  const [readerEntered, setReaderEntered] = useState<boolean>(readerActive);
  const [settingsMounted, setSettingsMounted] = useState<boolean>(settingsActive);
  const [settingsEntered, setSettingsEntered] = useState<boolean>(settingsActive);

  useEffect(() => {
    if (activeBookId) {
      setRetainedBookId(activeBookId);
    }
  }, [activeBookId]);

  useEffect(() => {
    if (instant) {
      setReaderMounted(readerActive);
      setReaderEntered(readerActive);
      return;
    }
    if (readerActive) {
      setReaderMounted(true);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          setReaderEntered(true);
        });
      });
      return () => {
        cancelAnimationFrame(raf1);
        if (raf2) cancelAnimationFrame(raf2);
      };
    }
    setReaderEntered(false);
    if (screen !== 'library') {
      setReaderMounted(false);
      return;
    }
    const timer = setTimeout(() => {
      setReaderMounted(false);
    }, 240);
    return () => clearTimeout(timer);
  }, [readerActive, screen, instant]);

  useEffect(() => {
    if (instant) {
      setSettingsMounted(settingsActive);
      setSettingsEntered(settingsActive);
      return;
    }
    if (settingsActive) {
      setSettingsMounted(true);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          setSettingsEntered(true);
        });
      });
      return () => {
        cancelAnimationFrame(raf1);
        if (raf2) cancelAnimationFrame(raf2);
      };
    }
    setSettingsEntered(false);
    if (screen !== 'library') {
      setSettingsMounted(false);
      return;
    }
    const timer = setTimeout(() => {
      setSettingsMounted(false);
    }, 240);
    return () => clearTimeout(timer);
  }, [settingsActive, screen, instant]);

  useEffect(() => {
    const libEl = libraryLayerRef.current;
    if (libEl) {
      if (screen !== 'library') libEl.setAttribute('inert', '');
      else libEl.removeAttribute('inert');
    }
    const rdrEl = readerLayerRef.current;
    if (rdrEl) {
      if (!readerActive) rdrEl.setAttribute('inert', '');
      else rdrEl.removeAttribute('inert');
    }
    const setEl = settingsLayerRef.current;
    if (setEl) {
      if (!settingsActive) setEl.setAttribute('inert', '');
      else setEl.removeAttribute('inert');
    }
  }, [screen, readerActive, settingsActive, readerMounted, settingsMounted]);

  // App-scoped ReadAloudController singleton (`ARCHITECTURE.md` §8.2)
  const readAloud = useMemo(
    () =>
      new ReadAloudController({
        host,
        player: speechPlayer,
        getSettings: () => useSettingsStore.getState().settings,
        getIsEink: () =>
          computeEffectiveEink(useSettingsStore.getState().settings, host.info.capabilities),
      }),
    [host, speechPlayer],
  );

  useEffect(() => {
    const uninstallBack = installGlobalBackHandler();
    const uninstallKeys = installKeymapAndPolicySync(
      host,
      () => useSettingsStore.getState().settings,
    );
    const unsubSettings = useSettingsStore.subscribe(() => {
      // Re-evaluate volume key policy whenever user toggles settings
      const route = useRouteStore.getState();
      useRouteStore.setState({ appVisible: route.appVisible });
    });

    let lastHostProgressMs = 0;
    const unsubHost = host.subscribe((ev) => {
      if (ev.type === 'import-progress') {
        const isEink = computeEffectiveEink(
          useSettingsStore.getState().settings,
          host.info.capabilities,
        );
        const now = Date.now();
        if (ev.completed >= ev.total) {
          useImportStore.getState().remove('host-import-progress');
          return;
        }
        if (!isEink || now - lastHostProgressMs >= 1000 || lastHostProgressMs === 0) {
          lastHostProgressMs = now;
          const locale = resolveLocale();
          useImportStore.getState().upsert({
            key: 'host-import-progress',
            name: ev.currentName ?? translate(locale, 'importing'),
            status: 'importing',
            stepLabel: `${translate(locale, 'importing')} ${ev.completed + 1} / ${ev.total}`,
          });
        }
      } else if (ev.type === 'library-changed') {
        useImportStore.getState().remove('host-import-progress');
      }
    });

    return () => {
      uninstallBack();
      uninstallKeys();
      unsubSettings();
      unsubHost();
      readAloud.dispose();
    };
  }, [host, readAloud]);

  const effectiveReaderBookId = activeBookId ?? retainedBookId;
  const showReaderLayer =
    !instant && (readerActive || (screen === 'library' && readerMounted && Boolean(effectiveReaderBookId)));
  const readerPhase: 'entering' | 'open' | 'exiting' = !readerActive
    ? 'exiting'
    : readerEntered
      ? 'open'
      : 'entering';

  const showSettingsLayer = !instant && (settingsActive || (screen === 'library' && settingsMounted));
  const settingsPhase: 'entering' | 'open' | 'exiting' = !settingsActive
    ? 'exiting'
    : settingsEntered
      ? 'open'
      : 'entering';

  const libraryTransition =
    screen === 'settings'
      ? 'covered-settings'
      : screen === 'reader'
        ? 'covered-reader'
        : 'active';

  useLayoutEffect(() => {
    if (typeof window !== 'undefined') {
      window.__minibookMounted = true;
    }
  }, []);

  return (
    <div className="mb-app">
      {instant ? (
        screen === 'reader' && activeBookId ? (
          <ReaderScreen bookId={activeBookId} readAloud={readAloud} />
        ) : screen === 'settings' ? (
          <SettingsScreen />
        ) : (
          <LibraryScreen readAloud={readAloud} />
        )
      ) : (
        <>
          <div
            ref={libraryLayerRef}
            className="mb-screen-layer mb-screen-library"
            data-transition={libraryTransition}
            aria-hidden={screen !== 'library' ? 'true' : undefined}
            style={screen !== 'library' ? { pointerEvents: 'none' } : undefined}
          >
            <LibraryScreen readAloud={readAloud} />
          </div>

          {showReaderLayer && effectiveReaderBookId && (
            <div
              ref={readerLayerRef}
              className="mb-screen-layer mb-screen-reader"
              data-transition={readerPhase}
              aria-hidden={!readerActive ? 'true' : undefined}
              style={!readerActive ? { pointerEvents: 'none' } : undefined}
              onTransitionEnd={(e) => {
                if (e.target === e.currentTarget && !readerActive) {
                  setReaderMounted(false);
                }
              }}
            >
              <ReaderScreen bookId={effectiveReaderBookId} readAloud={readAloud} />
            </div>
          )}

          {showSettingsLayer && (
            <div
              ref={settingsLayerRef}
              className="mb-screen-layer mb-screen-settings"
              data-transition={settingsPhase}
              aria-hidden={!settingsActive ? 'true' : undefined}
              style={!settingsActive ? { pointerEvents: 'none' } : undefined}
              onTransitionEnd={(e) => {
                if (e.target === e.currentTarget && !settingsActive) {
                  setSettingsMounted(false);
                }
              }}
            >
              <SettingsScreen />
            </div>
          )}
        </>
      )}

      {noticeMessage && (
        <div className="mb-notice-banner" role="status">
          <span>{noticeMessage}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {noticeActionLabel && noticeAction && (
              <button
                type="button"
                className="mb-link-btn"
                onClick={() => noticeAction()}
              >
                {noticeActionLabel}
              </button>
            )}
            <IconButton
              label="Dismiss notice"
              onClick={() => useRouteStore.getState().dismissNotice()}
            >
              <CloseIcon />
            </IconButton>
          </div>
        </div>
      )}

      <FlashOverlay />
    </div>
  );
}

export function App({ host, speechPlayer }: AppProps): ReactElement {
  return (
    <AppErrorBoundary
      onResetSettings={() => {
        useSettingsStore.getState().setSettings(DEFAULT_APP_SETTINGS);
        void host.settings.update(DEFAULT_APP_SETTINGS).catch(() => {});
      }}
    >
      <HostProvider host={host} speechPlayer={speechPlayer}>
        <AppShell />
      </HostProvider>
    </AppErrorBoundary>
  );
}
