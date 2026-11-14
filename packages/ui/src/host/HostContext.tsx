import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { create } from 'zustand';
import {
  DEFAULT_APP_SETTINGS,
  sanitizeAppSettings,
  type AppSettings,
  type DeviceInfo,
  type PlatformHost,
  type SpeechPlayer,
} from '@minibook/core';
import { registerOverlayTurnRunner, useRouteStore } from '../app/routes';
import { RefreshController } from '../eink/RefreshController';
import { translate, resolveLocale, syncDocumentLang } from '../i18n';
import {
  applyDocumentTheme,
  computeEffectiveEink,
  detectMediaEink,
} from '../theme/theme-manager';

export interface SettingsStoreState {
  settings: AppSettings;
  hydrated: boolean;
  setSettings(next: AppSettings): void;
  patchLocal(patch: Partial<AppSettings>): void;
  reset(): void;
}

export const useSettingsStore = create<SettingsStoreState>((set) => ({
  settings: DEFAULT_APP_SETTINGS,
  hydrated: false,
  setSettings(next) {
    set({ settings: sanitizeAppSettings(next, DEFAULT_APP_SETTINGS), hydrated: true });
  },
  patchLocal(patch) {
    set((s) => ({ settings: sanitizeAppSettings(patch, s.settings) }));
  },
  reset() {
    set({ settings: DEFAULT_APP_SETTINGS, hydrated: false });
  },
}));

export interface HostContextValue {
  readonly host: PlatformHost;
  readonly speechPlayer: SpeechPlayer;
  readonly refreshController: RefreshController;
  readonly settings: AppSettings;
  readonly isEink: boolean;
  readonly device: DeviceInfo;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
}

const HostContext = createContext<HostContextValue | null>(null);

export interface HostProviderProps {
  readonly host: PlatformHost;
  readonly speechPlayer: SpeechPlayer;
  readonly children: ReactNode;
}

export function HostProvider({
  host,
  speechPlayer,
  children,
}: HostProviderProps): ReactElement {
  const settings = useSettingsStore((s) => s.settings);
  const [device, setDevice] = useState<DeviceInfo>(host.info.device);
  const [mediaEink, setMediaEink] = useState<boolean>(() => detectMediaEink());

  const refreshController = useMemo(
    () =>
      new RefreshController({
        host,
        setFlashPhase: (phase) => useRouteStore.getState().setFlashPhase(phase),
      }),
    [host],
  );

  useEffect(() => {
    let cancelled = false;
    void host.settings
      .get()
      .then((loaded) => {
        if (!cancelled) {
          useSettingsStore.getState().setSettings(loaded);
        }
      })
      .catch(() => {
        if (!cancelled) {
          useSettingsStore.getState().setSettings(DEFAULT_APP_SETTINGS);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [host]);

  useEffect(() => {
    const unsub = host.subscribe((e) => {
      if (e.type === 'device-changed') {
        setDevice(e.device);
      }
    });
    return unsub;
  }, [host]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mqSlow = window.matchMedia('(update: slow)');
    const mqMono = window.matchMedia('(monochrome)');
    const onChange = (): void => setMediaEink(mqSlow.matches || mqMono.matches);
    mqSlow.addEventListener?.('change', onChange);
    mqMono.addEventListener?.('change', onChange);
    return () => {
      mqSlow.removeEventListener?.('change', onChange);
      mqMono.removeEventListener?.('change', onChange);
    };
  }, []);

  const isEink = computeEffectiveEink(
    settings,
    { einkDetected: host.info.capabilities.einkDetected || device.eink },
    mediaEink,
  );

  useEffect(() => {
    syncDocumentLang(undefined, true);
  }, []);

  useEffect(() => {
    applyDocumentTheme(settings, isEink);
  }, [settings, isEink]);

  useEffect(() => {
    return registerOverlayTurnRunner((req) =>
      refreshController.runTurn({
        isEink,
        cadence: settings.fullRefreshEvery,
        swap: req.swap,
        ...(req.closedSheetCoveredHalfScreen !== undefined
          ? { closedSheetCoveredHalfScreen: req.closedSheetCoveredHalfScreen }
          : {}),
        ...(req.countTurn !== undefined ? { countTurn: req.countTurn } : {}),
      }),
    );
  }, [refreshController, isEink, settings.fullRefreshEvery]);

  // One-time auto E-Ink notice (`PRODUCT_DESIGN.md` §8.1)
  const hydrated = useSettingsStore((s) => s.hydrated);
  useEffect(() => {
    if (!hydrated) return;
    if (settings.einkMode === 'auto' && isEink && !settings.einkAutoNoticeShown) {
      const locale = resolveLocale();
      useRouteStore.getState().showNotice(
        translate(locale, 'einkAutoNotice'),
        translate(locale, 'settings'),
        () => {
          useRouteStore.getState().dismissNotice();
          useRouteStore.getState().openSettings();
        },
      );
      useSettingsStore.getState().patchLocal({ einkAutoNoticeShown: true });
      void host.settings.update({ einkAutoNoticeShown: true }).catch(() => {});
    }
  }, [hydrated, settings.einkMode, settings.einkAutoNoticeShown, isEink, host]);

  const updateSettings = useMemo(
    () => async (patch: Partial<AppSettings>): Promise<AppSettings> => {
      useSettingsStore.getState().patchLocal(patch);
      const updated = await host.settings.update(patch);
      useSettingsStore.getState().setSettings(updated);
      return updated;
    },
    [host],
  );

  const value = useMemo<HostContextValue>(
    () => ({
      host,
      speechPlayer,
      refreshController,
      settings,
      isEink,
      device,
      updateSettings,
    }),
    [host, speechPlayer, refreshController, settings, isEink, device, updateSettings],
  );

  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}

export function useHostContext(): HostContextValue {
  const ctx = useContext(HostContext);
  if (!ctx) {
    throw new Error('useHostContext must be used inside HostProvider');
  }
  return ctx;
}

export function useIsEink(): boolean {
  const ctx = useContext(HostContext);
  if (ctx) return ctx.isEink;
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('data-eink');
    if (attr === '1' || attr === 'true') return true;
  }
  return false;
}

export function useHost(): PlatformHost {
  return useHostContext().host;
}

export function useSpeechPlayer(): SpeechPlayer {
  return useHostContext().speechPlayer;
}
