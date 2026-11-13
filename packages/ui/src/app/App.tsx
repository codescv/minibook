import { useEffect, useMemo, type ReactElement } from 'react';
import type { PlatformHost, SpeechPlayer } from '@minibook/core';
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

function AppShell(): ReactElement {
  const { host, speechPlayer } = useHostContext();
  const screen = useRouteStore((s) => s.screen);
  const activeBookId = useRouteStore((s) => s.activeBookId);
  const noticeMessage = useRouteStore((s) => s.noticeMessage);
  const noticeActionLabel = useRouteStore((s) => s.noticeActionLabel);
  const noticeAction = useRouteStore((s) => s.noticeAction);

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

  return (
    <div className="mb-app">
      {screen === 'reader' && activeBookId ? (
        <ReaderScreen bookId={activeBookId} readAloud={readAloud} />
      ) : screen === 'settings' ? (
        <SettingsScreen />
      ) : (
        <LibraryScreen readAloud={readAloud} />
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
    <HostProvider host={host} speechPlayer={speechPlayer}>
      <AppShell />
    </HostProvider>
  );
}
