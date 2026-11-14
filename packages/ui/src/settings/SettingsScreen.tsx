import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  type EinkModeSetting,
  type FullRefreshCadence,
  type TextBoldnessStep,
} from '@minibook/core';
import { useRouteStore } from '../app/routes';
import { IconButton } from '../components/IconButton';
import { Segmented } from '../components/Segmented';
import { Sheet } from '../components/Sheet';
import { Stepper } from '../components/Stepper';
import { Toggle } from '../components/Toggle';
import { ChevronLeftIcon } from '../components/icons';
import { PagedList } from '../eink/PagedList';
import { useHostContext } from '../host/HostContext';
import { useT } from '../i18n';
import { useSpeechModelStatus } from '../speech/speech-model-store';
import { computeEffectiveVolumeKeyPaging } from '../theme/theme-manager';

export const APP_VERSION = '0.2.5';

export { QWEN_PRESETS, type QwenPresetItem } from '../speech/VoiceSheet';

type SettingsItem =
  | { readonly key: string; readonly kind: 'header'; readonly title: string }
  | { readonly key: string; readonly kind: 'row'; readonly render: () => ReactElement };

const REFRESH_CADENCES: readonly FullRefreshCadence[] = [0, 5, 10, 20];
const BOLDNESS_STEPS: readonly TextBoldnessStep[] = [0, 1, 2, 3];

function formatBytesMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Settings Screen (`v0.2.3`):
 * Cleanly contains ONLY `READING` (`阅读`) and `ABOUT` (`关于`).
 * All TTS / Read-Aloud options live inside the guided 3-tab `VoiceSheet`
 * popped up directly from `ReadAloudBar` in the Reader.
 * Backed by `PagedList` so E-Ink mode stays strictly zero-scroll.
 */
export function SettingsScreen(): ReactElement {
  const t = useT();
  const { host, settings, isEink, refreshController, updateSettings } = useHostContext();
  const activeSheet = useRouteStore((s) => s.activeSheet);
  const { status: modelStatus } = useSpeechModelStatus(host, isEink);

  const [storageMb, setStorageMb] = useState<string>('0.0 MB');
  const [cacheBytes, setCacheBytes] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    const loadUsage = async (): Promise<void> => {
      try {
        if (host.settings.storageUsage) {
          const u = await host.settings.storageUsage();
          if (!cancelled) {
            const modelsBytes = u.modelsBytes ?? modelStatus?.installedBytes ?? 0;
            setStorageMb(formatBytesMb(u.booksBytes + u.speechCacheBytes + modelsBytes));
            setCacheBytes(u.speechCacheBytes);
          }
        } else {
          const sz = await host.speech.cacheSize();
          if (!cancelled) {
            const modelsBytes = modelStatus?.installedBytes ?? 0;
            setStorageMb(formatBytesMb(sz + modelsBytes));
            setCacheBytes(sz);
          }
        }
      } catch {
        // ignore
      }
    };
    void loadUsage();
    return () => {
      cancelled = true;
    };
  }, [host, modelStatus?.installedBytes]);

  const effectiveVolumePaging = computeEffectiveVolumeKeyPaging(
    settings,
    isEink,
    host.info.capabilities,
  );

  const cadenceIdx = Math.max(0, REFRESH_CADENCES.indexOf(settings.fullRefreshEvery));
  const boldIdx = Math.max(0, BOLDNESS_STEPS.indexOf(settings.textBoldness));

  const items = useMemo<SettingsItem[]>(() => {
    const list: SettingsItem[] = [];

    // --- Section 1: READING ---
    list.push({ key: 'hdr-reading', kind: 'header', title: t('sectionReading') });

    // Row 1: E-Ink mode (Auto · On · Off)
    list.push({
      key: 'row-eink-mode',
      kind: 'row',
      render: () => (
        <div className="mb-sheet-row" data-setting-row="eink-mode">
          <span className="mb-sheet-label">{t('einkMode')}</span>
          <Segmented<EinkModeSetting>
            label={t('einkMode')}
            value={settings.einkMode}
            options={[
              { value: 'auto', label: t('auto') },
              { value: 'on', label: t('on') },
              { value: 'off', label: t('off') },
            ]}
            onChange={(einkMode) => {
              void updateSettings({ einkMode });
            }}
          />
        </div>
      ),
    });

    // Row 2: Volume keys turn pages (Android only -> capabilities.volumeKeyPaging)
    if (host.info.capabilities.volumeKeyPaging) {
      list.push({
        key: 'row-volume-keys',
        kind: 'row',
        render: () => (
          <div className="mb-sheet-row" data-setting-row="volume-keys">
            <span className="mb-sheet-label">{t('volumeKeysTurnPages')}</span>
            <Toggle
              label={t('volumeKeysTurnPages')}
              checked={effectiveVolumePaging}
              isEink={isEink}
              onText={t('on')}
              offText={t('off')}
              onChange={(volumeKeyPaging) => {
                void updateSettings({ volumeKeyPaging });
              }}
            />
          </div>
        ),
      });
    }

    // Row 3 & 4: Full refresh & Text boldness (E-Ink mode) OR Keep screen on (normal mode)
    if (isEink) {
      list.push({
        key: 'row-full-refresh',
        kind: 'row',
        render: () => (
          <div className="mb-sheet-row" data-setting-row="full-refresh">
            <span className="mb-sheet-label">{t('fullRefresh')}</span>
            <Stepper
              valueLabel={
                settings.fullRefreshEvery === 0
                  ? t('off')
                  : t('everyNPages', { n: settings.fullRefreshEvery })
              }
              canDecrement={cadenceIdx > 0}
              canIncrement={cadenceIdx < REFRESH_CADENCES.length - 1}
              decrementLabel="Decrease refresh interval"
              incrementLabel="Increase refresh interval"
              onDecrement={() => {
                const next = REFRESH_CADENCES[Math.max(0, cadenceIdx - 1)];
                if (next !== undefined) void updateSettings({ fullRefreshEvery: next });
              }}
              onIncrement={() => {
                const next =
                  REFRESH_CADENCES[Math.min(REFRESH_CADENCES.length - 1, cadenceIdx + 1)];
                if (next !== undefined) void updateSettings({ fullRefreshEvery: next });
              }}
            />
          </div>
        ),
      });

      list.push({
        key: 'row-text-boldness',
        kind: 'row',
        render: () => (
          <div className="mb-sheet-row" data-setting-row="text-boldness">
            <span className="mb-sheet-label">{t('textBoldness')}</span>
            <Stepper
              valueLabel={String(settings.textBoldness)}
              canDecrement={boldIdx > 0}
              canIncrement={boldIdx < BOLDNESS_STEPS.length - 1}
              decrementLabel="Decrease boldness"
              incrementLabel="Increase boldness"
              onDecrement={() => {
                const next = BOLDNESS_STEPS[Math.max(0, boldIdx - 1)];
                if (next !== undefined) void updateSettings({ textBoldness: next });
              }}
              onIncrement={() => {
                const next =
                  BOLDNESS_STEPS[Math.min(BOLDNESS_STEPS.length - 1, boldIdx + 1)];
                if (next !== undefined) void updateSettings({ textBoldness: next });
              }}
            />
          </div>
        ),
      });
    } else {
      list.push({
        key: 'row-keep-screen-on',
        kind: 'row',
        render: () => (
          <div className="mb-sheet-row" data-setting-row="keep-screen-on">
            <span className="mb-sheet-label">{t('keepScreenOn')}</span>
            <Toggle
              label={t('keepScreenOn')}
              checked={settings.keepScreenOn}
              isEink={false}
              onText={t('on')}
              offText={t('off')}
              onChange={(keepScreenOn) => {
                void updateSettings({ keepScreenOn });
              }}
            />
          </div>
        ),
      });
    }

    // --- Section 2: ABOUT ---
    list.push({ key: 'hdr-about', kind: 'header', title: t('sectionAbout') });

    // Storage (books + speech cache + models)
    list.push({
      key: 'row-storage',
      kind: 'row',
      render: () => (
        <div className="mb-sheet-row" data-setting-row="storage">
          <span>
            {t('storage')} <span className="mb-list-row-meta">({storageMb})</span>
          </span>
          {cacheBytes > 0 && (
            <button
              type="button"
              className="mb-icon-btn"
              onClick={() => {
                void host.speech.clearCache().then(() => {
                  setCacheBytes(0);
                });
              }}
            >
              {t('clear')}
            </button>
          )}
        </div>
      ),
    });

    // Version 0.2.5 · Licenses
    list.push({
      key: 'row-version',
      kind: 'row',
      render: () => (
        <button
          type="button"
          className="mb-list-row"
          data-setting-row="version-licenses"
          onClick={() => useRouteStore.getState().openSheet('licenses')}
        >
          <span>{t('versionAndLicenses', { v: host.info.appVersion || APP_VERSION })}</span>
          <span className="mb-list-row-meta">▸</span>
        </button>
      ),
    });

    return list;
  }, [
    t,
    settings,
    host,
    isEink,
    effectiveVolumePaging,
    cadenceIdx,
    boldIdx,
    storageMb,
    cacheBytes,
    updateSettings,
  ]);

  const handleCloseSheet = (coveredHalf: boolean): void => {
    useRouteStore.getState().closeSheetWithRefresh(coveredHalf);
  };

  return (
    <main className="mb-settings" data-testid="settings-screen">
      <div className="mb-settings-inner">
        <header className="mb-settings-header">
          <IconButton
            label={t('backToLibrary')}
            onClick={() => useRouteStore.getState().openLibrary()}
          >
            <ChevronLeftIcon />
          </IconButton>
          <h1 className="mb-library-title">{t('settings')}</h1>
        </header>

        <PagedList
          items={items}
          isEink={isEink}
          layer="screen"
          estimatedItemHeight={48}
          fallbackPageSize={16}
          prevLabel={t('prevPage')}
          nextLabel={t('nextPage')}
          ariaLabel={t('settings')}
          onPageTurn={(swap) => {
            void refreshController.runTurn({
              isEink,
              cadence: settings.fullRefreshEvery,
              swap,
            });
          }}
          renderItems={(visible) => (
            <div>
              {visible.map((item) =>
                item.kind === 'header' ? (
                  <div key={item.key} className="mb-settings-section-title">
                    {item.title}
                  </div>
                ) : (
                  <div key={item.key}>{item.render()}</div>
                ),
              )}
            </div>
          )}
        />
      </div>

      {/* Open-Source Licenses Sheet */}
      <Sheet
        open={activeSheet === 'licenses'}
        label="Licenses"
        onClose={handleCloseSheet}
      >
        <div className="mb-sheet-row">
          <div>
            <div style={{ fontWeight: 600 }}>Books (MiniBook) v{host.info.appVersion}</div>
            <div className="mb-list-row-meta">
              Literata Typeface — SIL Open Font License 1.1 (TypeTogether)
            </div>
            <div className="mb-list-row-meta">
              Kokoro-82M v1.1-zh — Apache 2.0 (hexgrad / onnx-community / FluidInference)
            </div>
            <div className="mb-list-row-meta">ONNX Runtime — MIT License</div>
            <div className="mb-list-row-meta">
              misaki / jieba / pypinyin / cn2an — Apache 2.0 &amp; MIT License
            </div>
            <div className="mb-list-row-meta">
              MOBI/KF8 container &amp; index algorithms adapted from foliate-js (MIT, John Factotum)
            </div>
            <div className="mb-list-row-meta">fflate &amp; parse5 — MIT License</div>
          </div>
        </div>
      </Sheet>
    </main>
  );
}
