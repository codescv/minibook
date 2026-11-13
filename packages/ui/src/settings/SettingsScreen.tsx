import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type {
  EinkModeSetting,
  FullRefreshCadence,
  TextBoldnessStep,
  Voice,
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
import { computeEffectiveVolumeKeyPaging } from '../theme/theme-manager';

type SettingsItem =
  | { readonly key: string; readonly kind: 'header'; readonly title: string }
  | { readonly key: string; readonly kind: 'row'; readonly render: () => ReactElement };

const REFRESH_CADENCES: readonly FullRefreshCadence[] = [0, 5, 10, 20];
const BOLDNESS_STEPS: readonly TextBoldnessStep[] = [0, 1, 2, 3];

function formatBytesMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Settings Screen (`PRODUCT_DESIGN.md` §4.7 & Stage-2 `#13` P2 #2):
 * Strictly 11 defined rows across `READING` (5), `READ ALOUD` (4), and `ABOUT` (2).
 * Rows inapplicable to the platform or mode are hidden, never disabled.
 * Backed by `PagedList` so E-Ink mode stays strictly zero-scroll.
 */
export function SettingsScreen(): ReactElement {
  const t = useT();
  const { host, speechPlayer, settings, isEink, refreshController, updateSettings } =
    useHostContext();
  const activeSheet = useRouteStore((s) => s.activeSheet);

  const [storageMb, setStorageMb] = useState<string>('0.0 MB');
  const [cacheBytes, setCacheBytes] = useState<number>(0);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);

  const [srvUrl, setSrvUrl] = useState(settings.customSpeechServer?.baseUrl ?? '');
  const [srvModel, setSrvModel] = useState(settings.customSpeechServer?.model ?? 'tts-1');
  const [srvVoice, setSrvVoice] = useState(settings.customSpeechServer?.voice ?? 'alloy');
  const [srvApiKey, setSrvApiKey] = useState('');

  useEffect(() => {
    let cancelled = false;
    const loadUsage = async (): Promise<void> => {
      try {
        if (host.settings.storageUsage) {
          const u = await host.settings.storageUsage();
          if (!cancelled) {
            setStorageMb(formatBytesMb(u.booksBytes + u.speechCacheBytes));
            setCacheBytes(u.speechCacheBytes);
          }
        } else {
          const sz = await host.speech.cacheSize();
          if (!cancelled) {
            setStorageMb(formatBytesMb(sz));
            setCacheBytes(sz);
          }
        }
      } catch {
        // ignore
      }
    };
    void loadUsage();
    void speechPlayer
      .listVoices()
      .then((list) => {
        if (!cancelled) setVoices(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [host, speechPlayer]);

  const effectiveVolumePaging = computeEffectiveVolumeKeyPaging(
    settings,
    isEink,
    host.info.capabilities,
  );

  const cadenceIdx = Math.max(0, REFRESH_CADENCES.indexOf(settings.fullRefreshEvery));
  const boldIdx = Math.max(0, BOLDNESS_STEPS.indexOf(settings.textBoldness));

  const currentDefaultVoice = settings.preferredVoices.default ?? {
    kind: 'system' as const,
    voiceId: null,
  };
  const currentVoiceLabel = useMemo(() => {
    if (currentDefaultVoice.kind === 'system') {
      if (!currentDefaultVoice.voiceId) return t('systemDefault');
      const match = voices.find((v) => v.id === currentDefaultVoice.voiceId);
      return match ? `${t('systemDefault')} · ${match.name}` : t('systemDefault');
    }
    return currentDefaultVoice.voiceId;
  }, [currentDefaultVoice, voices, t]);

  // Exact 11 rows (capability-gated and E-Ink-gated per PRODUCT_DESIGN.md §4.7)
  const items = useMemo<SettingsItem[]>(() => {
    const list: SettingsItem[] = [];

    // --- Section 1: READING (up to 5 rows) ---
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

    // Row 3: Full refresh (E-Ink mode only)
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

      // Row 4: Text boldness (E-Ink mode only)
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
      // Row 5: Keep screen on (while reading; hidden on E-Ink per PRODUCT_DESIGN.md §4.7)
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

    // --- Section 2: READ ALOUD (4 rows) ---
    list.push({ key: 'hdr-read-aloud', kind: 'header', title: t('sectionReadAloud') });

    // Row 6: Voice
    list.push({
      key: 'row-voice',
      kind: 'row',
      render: () => (
        <button
          type="button"
          className="mb-list-row"
          data-setting-row="voice"
          onClick={() => setVoicePickerOpen(true)}
        >
          <span>{t('voice')}</span>
          <span className="mb-list-row-meta">{currentVoiceLabel} ▸</span>
        </button>
      ),
    });

    // Row 7: Edge neural voices
    list.push({
      key: 'row-edge-voices',
      kind: 'row',
      render: () => (
        <div className="mb-sheet-row" data-setting-row="edge-voices">
          <span className="mb-sheet-label">{t('edgeNeuralVoices')}</span>
          <Toggle
            label={t('edgeNeuralVoices')}
            checked={settings.edgeVoicesEnabled}
            isEink={isEink}
            onText={t('on')}
            offText={t('off')}
            onChange={(edgeVoicesEnabled) => {
              void updateSettings({ edgeVoicesEnabled });
            }}
          />
        </div>
      ),
    });

    // Row 8: Custom speech server
    list.push({
      key: 'row-custom-server',
      kind: 'row',
      render: () => (
        <button
          type="button"
          className="mb-list-row"
          data-setting-row="custom-server"
          onClick={() => {
            setSrvUrl(settings.customSpeechServer?.baseUrl ?? '');
            setSrvModel(settings.customSpeechServer?.model ?? 'tts-1');
            setSrvVoice(settings.customSpeechServer?.voice ?? 'alloy');
            setSrvApiKey('');
            useRouteStore.getState().openSheet('custom-server');
          }}
        >
          <span>{t('customSpeechServer')}</span>
          <span className="mb-list-row-meta">
            {settings.customSpeechServer ? settings.customSpeechServer.voice : t('notSet')} ▸
          </span>
        </button>
      ),
    });

    // Row 9: Fall back to system voice
    list.push({
      key: 'row-fallback-system',
      kind: 'row',
      render: () => (
        <div className="mb-sheet-row" data-setting-row="fallback-system">
          <span className="mb-sheet-label">{t('fallbackToSystem')}</span>
          <Toggle
            label={t('fallbackToSystem')}
            checked={settings.fallbackToSystemVoice}
            isEink={isEink}
            onText={t('on')}
            offText={t('off')}
            onChange={(fallbackToSystemVoice) => {
              void updateSettings({ fallbackToSystemVoice });
            }}
          />
        </div>
      ),
    });

    // --- Section 3: ABOUT (2 rows) ---
    list.push({ key: 'hdr-about', kind: 'header', title: t('sectionAbout') });

    // Row 10: Storage (books + speech cache Clear)
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

    // Row 11: Version 0.1.0 · Licenses
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
          <span>{t('versionAndLicenses', { v: host.info.appVersion })}</span>
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
    currentVoiceLabel,
    storageMb,
    cacheBytes,
    updateSettings,
  ]);

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
          fallbackPageSize={14}
          prevLabel={t('prevPage')}
          nextLabel={t('nextPage')}
          ariaLabel={t('settings')}
          onPageTurn={() => {
            void refreshController.runTurn({
              isEink,
              cadence: settings.fullRefreshEvery,
              swap: () => {},
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

      {/* Default System Voice Selector Sheet */}
      <Sheet
        open={voicePickerOpen}
        label={t('voice')}
        onClose={() => setVoicePickerOpen(false)}
      >
        <button
          type="button"
          className="mb-list-row"
          onClick={() => {
            void updateSettings({
              preferredVoices: {
                ...settings.preferredVoices,
                default: { kind: 'system', voiceId: null },
              },
            });
            setVoicePickerOpen(false);
          }}
        >
          <span>{t('systemDefault')}</span>
          <span>
            {currentDefaultVoice.kind === 'system' && currentDefaultVoice.voiceId === null
              ? '✓'
              : ''}
          </span>
        </button>
        {voices.map((v) => (
          <button
            key={v.id}
            type="button"
            className="mb-list-row"
            onClick={() => {
              void updateSettings({
                preferredVoices: {
                  ...settings.preferredVoices,
                  default: {
                    kind: 'system',
                    voiceId: v.id,
                    ...(v.engine ? { engine: v.engine } : {}),
                  },
                },
              });
              setVoicePickerOpen(false);
            }}
          >
            <span>
              {v.name} <span className="mb-list-row-meta">{v.engine ?? v.lang}</span>
            </span>
            <span>
              {currentDefaultVoice.kind === 'system' && currentDefaultVoice.voiceId === v.id
                ? '✓'
                : ''}
            </span>
          </button>
        ))}
      </Sheet>

      {/* Custom OpenAI-Compatible Speech Server Sheet */}
      <Sheet
        open={activeSheet === 'custom-server'}
        label={t('customSpeechServer')}
        onClose={() => useRouteStore.getState().closeSheet()}
      >
        <input
          type="url"
          className="mb-input"
          placeholder="http://127.0.0.1:8000/v1"
          aria-label={t('serverUrl')}
          value={srvUrl}
          onChange={(e) => setSrvUrl(e.target.value)}
        />
        <input
          type="password"
          className="mb-input"
          placeholder={t('apiKey')}
          aria-label={t('apiKey')}
          value={srvApiKey}
          onChange={(e) => setSrvApiKey(e.target.value)}
        />
        <input
          type="text"
          className="mb-input"
          placeholder="tts-1"
          aria-label={t('modelName')}
          value={srvModel}
          onChange={(e) => setSrvModel(e.target.value)}
        />
        <input
          type="text"
          className="mb-input"
          placeholder="alloy"
          aria-label={t('voiceName')}
          value={srvVoice}
          onChange={(e) => setSrvVoice(e.target.value)}
        />
        <div className="mb-sheet-row">
          <button
            type="button"
            className="mb-primary-btn"
            onClick={() => {
              if (srvApiKey.trim()) {
                void host.settings.setSecret('openai-api-key', srvApiKey.trim());
              }
              const trimmedUrl = srvUrl.trim();
              void updateSettings({
                customSpeechServer: trimmedUrl
                  ? {
                      baseUrl: trimmedUrl,
                      model: srvModel.trim() || 'tts-1',
                      voice: srvVoice.trim() || 'alloy',
                    }
                  : null,
              });
              useRouteStore.getState().closeSheet();
            }}
          >
            {t('save')}
          </button>
          {settings.customSpeechServer && (
            <button
              type="button"
              className="mb-icon-btn"
              onClick={() => {
                void host.settings.setSecret('openai-api-key', null);
                void updateSettings({ customSpeechServer: null });
                useRouteStore.getState().closeSheet();
              }}
            >
              {t('clear')}
            </button>
          )}
        </div>
      </Sheet>

      {/* Open-Source Licenses Sheet */}
      <Sheet
        open={activeSheet === 'licenses'}
        label="Licenses"
        onClose={() => useRouteStore.getState().closeSheet()}
      >
        <div className="mb-sheet-row">
          <div>
            <div style={{ fontWeight: 600 }}>Books (MiniBook) v{host.info.appVersion}</div>
            <div className="mb-list-row-meta">
              Literata Typeface — SIL Open Font License 1.1 (TypeTogether)
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
