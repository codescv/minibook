import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  KOKORO_CURATED_VOICES,
  KOKORO_MODEL_ID,
  KOKORO_VOICE_IDS,
  kokoroVoiceLang,
  type EinkModeSetting,
  type FullRefreshCadence,
  type ModelDownloadSource,
  type QwenProtocol,
  type TextBoldnessStep,
  type Voice,
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
import { resolveLocale, useT } from '../i18n';
import {
  formatKokoroVoiceLabel,
  formatModelBackendBadge,
  formatModelErrorInfo,
  formatSteppedEinkPct,
  getSpeechModelsApi,
  resolveEffectiveModelSourceHost,
  useSpeechModelStatus,
} from '../speech/speech-model-store';
import { computeEffectiveVolumeKeyPaging } from '../theme/theme-manager';

type SettingsItem =
  | { readonly key: string; readonly kind: 'header'; readonly title: string }
  | { readonly key: string; readonly kind: 'row'; readonly render: () => ReactElement };

const REFRESH_CADENCES: readonly FullRefreshCadence[] = [0, 5, 10, 20];
const BOLDNESS_STEPS: readonly TextBoldnessStep[] = [0, 1, 2, 3];

export interface QwenPresetItem {
  readonly label: string;
  readonly protocol: QwenProtocol;
  readonly model: string;
  readonly voice: string;
  readonly defaultUrl: string;
}

export const QWEN_PRESETS: readonly QwenPresetItem[] = [
  {
    label: 'Mac · mlx-audio · Qwen3-TTS 0.6B',
    protocol: 'mlx-audio',
    model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit',
    voice: 'Vivian',
    defaultUrl: 'http://127.0.0.1:8000',
  },
  {
    label: 'Mac · mlx-audio · Qwen3-TTS 1.7B',
    protocol: 'mlx-audio',
    model: 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit',
    voice: 'Vivian',
    defaultUrl: 'http://127.0.0.1:8000',
  },
  {
    label: 'Mac · mlx-audio · Kokoro-82M',
    protocol: 'mlx-audio',
    model: 'mlx-community/Kokoro-82M-bf16',
    voice: 'zf_001',
    defaultUrl: 'http://127.0.0.1:8000',
  },
  {
    label: 'vLLM-Omni · Qwen3-TTS',
    protocol: 'vllm-omni',
    model: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
    voice: 'Vivian',
    defaultUrl: 'http://127.0.0.1:8091',
  },
  {
    label: 'qwen-tts · /synthesize',
    protocol: 'qwen-native',
    model: 'Qwen3-TTS',
    voice: 'Vivian',
    defaultUrl: 'http://127.0.0.1:8000',
  },
];

function formatBytesMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Settings Screen (`PRODUCT_DESIGN.md` §4.7 & `TTS_V2_SPEC.md` §7):
 * Strictly <= 13 honest rows across `READING` (up to 5), `READ ALOUD` (up to 6), and `ABOUT` (2).
 * Rows inapplicable to the platform or mode are hidden, never disabled.
 * Backed by `PagedList` so E-Ink mode stays strictly zero-scroll.
 */
export function SettingsScreen(): ReactElement {
  const t = useT();
  const locale = useMemo(() => resolveLocale(), []);
  const { host, speechPlayer, settings, isEink, refreshController, updateSettings } =
    useHostContext();
  const activeSheet = useRouteStore((s) => s.activeSheet);

  const modelsApi = getSpeechModelsApi(host);
  const { status: modelStatus, displayPct } = useSpeechModelStatus(host, isEink);

  const [storageMb, setStorageMb] = useState<string>('0.0 MB');
  const [cacheBytes, setCacheBytes] = useState<number>(0);
  const [voices, setVoices] = useState<Voice[]>([]);

  // Custom OpenAI-compatible Speech Server state
  const [srvUrl, setSrvUrl] = useState(settings.customSpeechServer?.baseUrl ?? '');
  const [srvModel, setSrvModel] = useState(settings.customSpeechServer?.model ?? 'tts-1');
  const [srvVoice, setSrvVoice] = useState(settings.customSpeechServer?.voice ?? 'alloy');
  const [srvApiKey, setSrvApiKey] = useState('');

  // Local GPU Server (Qwen3-TTS / mlx-audio / vllm-omni) state
  const [qwenPresetIdx, setQwenPresetIdx] = useState<number>(0);
  const [qwenUrl, setQwenUrl] = useState(settings.qwenServer?.baseUrl ?? '');
  const [qwenProtocol, setQwenProtocol] = useState<QwenProtocol>(
    settings.qwenServer?.protocol ?? 'mlx-audio',
  );
  const [qwenModel, setQwenModel] = useState(
    settings.qwenServer?.model ?? QWEN_PRESETS[0]!.model,
  );
  const [qwenVoice, setQwenVoice] = useState(
    settings.qwenServer?.voice ?? QWEN_PRESETS[0]!.voice,
  );
  const [qwenInstruct, setQwenInstruct] = useState(settings.qwenServer?.instruct ?? '');
  const [qwenRefAudio, setQwenRefAudio] = useState(settings.qwenServer?.refAudio ?? '');
  const [qwenRefText, setQwenRefText] = useState(settings.qwenServer?.refText ?? '');
  const [qwenTestStatus, setQwenTestStatus] = useState<string | null>(null);

  // Kokoro custom mirror input & 2-tap delete confirmation
  const [customMirrorUrl, setCustomMirrorUrl] = useState(settings.modelMirrorBaseUrl ?? '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (deleteTimerRef.current !== null) {
        clearTimeout(deleteTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setConfirmingDelete(false);
    if (deleteTimerRef.current !== null) {
      clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = null;
    }
  }, [modelStatus?.state, activeSheet]);

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
    void speechPlayer
      .listVoices()
      .then((list) => {
        if (!cancelled) setVoices(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [host, speechPlayer, modelStatus?.installedBytes]);

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
    if (currentDefaultVoice.kind === 'kokoro' && currentDefaultVoice.voiceId) {
      return formatKokoroVoiceLabel(currentDefaultVoice.voiceId, locale);
    }
    return currentDefaultVoice.voiceId;
  }, [currentDefaultVoice, voices, locale, t]);

  const backendBadge = formatModelBackendBadge(
    modelStatus,
    host.info.platform,
    t('onDevice'),
  );

  const onDeviceRowMeta = useMemo(() => {
    const state = modelStatus?.state ?? 'absent';
    if (state === 'absent') return t('notSet');
    if (state === 'downloading') {
      return isEink ? formatSteppedEinkPct(displayPct) : `${displayPct}%`;
    }
    if (state === 'paused') {
      return isEink
        ? formatSteppedEinkPct(displayPct)
        : t('pausedPct', { pct: displayPct });
    }
    if (state === 'verifying') return t('checking');
    if (state === 'ready') {
      const mb = Math.max(
        1,
        Math.round(((modelStatus?.installedBytes || modelStatus?.bytesTotal || 129_967_797) / (1024 * 1024))),
      );
      return `${t('readySize', { mb })} · ${backendBadge}`;
    }
    return t('needsAttention');
  }, [modelStatus, displayPct, isEink, backendBadge, t]);

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

    // --- Section 2: READ ALOUD (up to 6 rows) ---
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
          onClick={() => useRouteStore.getState().openSheet('settings-voice')}
        >
          <span>{t('voice')}</span>
          <span className="mb-list-row-meta">{currentVoiceLabel} ▸</span>
        </button>
      ),
    });

    // Row 7: On-device neural voice (Kokoro-82M; hidden when host.speech.models is absent)
    if (modelsApi) {
      list.push({
        key: 'row-on-device-neural-voice',
        kind: 'row',
        render: () => (
          <button
            type="button"
            className="mb-list-row"
            data-setting-row="on-device-neural-voice"
            onClick={() => {
              setCustomMirrorUrl(settings.modelMirrorBaseUrl ?? '');
              useRouteStore.getState().openSheet('kokoro-model');
            }}
          >
            <span>{t('onDeviceNeuralVoice')}</span>
            <span className="mb-list-row-meta" data-testid="settings-kokoro-meta">
              {onDeviceRowMeta} ▸
            </span>
          </button>
        ),
      });
    }

    // Row 8: Edge neural voices
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

    // Row 9: Local GPU server (mlx-audio / Qwen3-TTS / vllm-omni)
    list.push({
      key: 'row-local-gpu-server',
      kind: 'row',
      render: () => (
        <button
          type="button"
          className="mb-list-row"
          data-setting-row="local-gpu-server"
          onClick={() => {
            const q = settings.qwenServer;
            if (q) {
              const matchedIdx = QWEN_PRESETS.findIndex(
                (p) => p.protocol === q.protocol && p.model === q.model,
              );
              setQwenPresetIdx(matchedIdx >= 0 ? matchedIdx : 0);
              setQwenUrl(q.baseUrl);
              setQwenProtocol(q.protocol);
              setQwenModel(q.model);
              setQwenVoice(q.voice);
              setQwenInstruct(q.instruct ?? '');
              setQwenRefAudio(q.refAudio ?? '');
              setQwenRefText(q.refText ?? '');
            } else {
              const def = QWEN_PRESETS[0]!;
              setQwenPresetIdx(0);
              setQwenUrl('');
              setQwenProtocol(def.protocol);
              setQwenModel(def.model);
              setQwenVoice(def.voice);
              setQwenInstruct('');
              setQwenRefAudio('');
              setQwenRefText('');
            }
            setQwenTestStatus(null);
            useRouteStore.getState().openSheet('qwen-server');
          }}
        >
          <span>{t('localGpuServer')}</span>
          <span className="mb-list-row-meta">
            {settings.qwenServer ? settings.qwenServer.voice : t('notSet')} ▸
          </span>
        </button>
      ),
    });

    // Row 10: Custom speech server
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

    // Row 11: Fall back to system voice
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

    // Row 12: Storage (books + speech cache + models)
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

    // Row 13: Version 0.2.0 · Licenses
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
    modelsApi,
    onDeviceRowMeta,
    isEink,
    effectiveVolumePaging,
    cadenceIdx,
    boldIdx,
    currentVoiceLabel,
    storageMb,
    cacheBytes,
    updateSettings,
  ]);

  const voiceOptions = useMemo(() => {
    const opts: Array<{
      readonly key: string;
      readonly label: string;
      readonly meta: string;
      readonly selected: boolean;
      readonly onSelect: () => void;
    }> = [
      {
        key: 'sys-default',
        label: t('systemDefault'),
        meta: '',
        selected:
          currentDefaultVoice.kind === 'system' && currentDefaultVoice.voiceId === null,
        onSelect: () => {
          void updateSettings({
            preferredVoices: {
              ...settings.preferredVoices,
              default: { kind: 'system', voiceId: null },
            },
          });
          useRouteStore.getState().closeSheetWithRefresh();
        },
      },
    ];
    for (const v of voices) {
      opts.push({
        key: `v:${v.id}`,
        label: v.name,
        meta: v.engine ?? v.lang,
        selected:
          currentDefaultVoice.kind === 'system' && currentDefaultVoice.voiceId === v.id,
        onSelect: () => {
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
          useRouteStore.getState().closeSheetWithRefresh();
        },
      });
    }
    return opts;
  }, [t, voices, currentDefaultVoice, settings.preferredVoices, updateSettings]);

  const allKokoroCatalogItems = useMemo(() => {
    const preferZh = locale.toLowerCase().startsWith('zh');
    const sortedIds = [...KOKORO_VOICE_IDS].sort((a, b) => {
      const aZh = a.startsWith('z');
      const bZh = b.startsWith('z');
      if (aZh !== bZh) {
        return preferZh ? (aZh ? -1 : 1) : (aZh ? 1 : -1);
      }
      return a.localeCompare(b);
    });
    const installedSet = new Set(modelStatus?.installedVoices ?? []);
    return sortedIds.map((voiceId) => ({
      voiceId,
      label: formatKokoroVoiceLabel(voiceId, locale),
      installed: installedSet.has(voiceId),
      langKey: kokoroVoiceLang(voiceId).split('-')[0]?.toLowerCase() ?? 'en',
    }));
  }, [locale, modelStatus?.installedVoices]);

  const applyQwenPreset = (nextIdx: number): void => {
    const wrapped = (nextIdx + QWEN_PRESETS.length) % QWEN_PRESETS.length;
    const preset = QWEN_PRESETS[wrapped]!;
    setQwenPresetIdx(wrapped);
    setQwenProtocol(preset.protocol);
    setQwenModel(preset.model);
    setQwenVoice(preset.voice);
    if (!qwenUrl.trim() || qwenUrl.startsWith('http://127.0.0.1:')) {
      setQwenUrl(preset.defaultUrl);
    }
    setQwenTestStatus(null);
  };

  const handleCloseSheet = (coveredHalf: boolean): void => {
    useRouteStore.getState().closeSheetWithRefresh(coveredHalf);
  };

  const modelState = modelStatus?.state ?? 'absent';
  const totalModelMb = Math.max(
    1,
    Math.round(((modelStatus?.bytesTotal ?? 129_967_797) / (1024 * 1024))),
  );
  const installedModelMb = Math.max(
    1,
    Math.round(((modelStatus?.installedBytes || modelStatus?.bytesTotal || 129_967_797) / (1024 * 1024))),
  );
  const errorInfo = modelState === 'error' ? formatModelErrorInfo(modelStatus, t) : null;

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

      {/* Default System Voice Selector Sheet (`activeSheet === 'settings-voice'`, backed by PagedList) */}
      <Sheet
        open={activeSheet === 'settings-voice'}
        label={t('voice')}
        listSheet
        onClose={handleCloseSheet}
      >
        <PagedList
          items={voiceOptions}
          isEink={isEink}
          layer="sheet"
          estimatedItemHeight={48}
          fallbackPageSize={6}
          prevLabel={t('prevPage')}
          nextLabel={t('nextPage')}
          ariaLabel={t('voice')}
          onPageTurn={(swap) => {
            void refreshController.runTurn({
              isEink,
              cadence: settings.fullRefreshEvery,
              swap,
            });
          }}
          renderItems={(visible) => (
            <div role="listbox" aria-label={t('voice')}>
              {visible.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  role="option"
                  aria-selected={opt.selected}
                  className="mb-list-row"
                  onClick={opt.onSelect}
                >
                  <span>
                    {opt.label}{' '}
                    {opt.meta && <span className="mb-list-row-meta">{opt.meta}</span>}
                  </span>
                  <span aria-hidden="true">{opt.selected ? '✓' : ''}</span>
                </button>
              ))}
            </div>
          )}
        />
      </Sheet>

      {/* On-Device Neural Voice (Kokoro-82M) Sheet (`activeSheet === 'kokoro-model'`) */}
      {modelsApi && (
        <Sheet
          open={activeSheet === 'kokoro-model'}
          label={t('onDeviceNeuralVoice')}
          onClose={handleCloseSheet}
        >
          <div className="mb-sheet-row">
            <div>
              <div>
                <span className="mb-sheet-label">{t('kokoroTitle')}</span>{' '}
                {host.info.platform === 'ios' && (
                  <span className="mb-badge">{t('beta')}</span>
                )}
              </div>
              <div className="mb-list-row-meta">{t('kokoroCaption')}</div>
            </div>
            <span className="mb-badge" data-testid="kokoro-backend-badge">
              {backendBadge}
            </span>
          </div>

          <div className="mb-sheet-row" data-testid="kokoro-model-status-row">
            {modelState === 'absent' && (
              <>
                <span data-testid="kokoro-status-text">
                  {t('downloadSizeMb', { mb: totalModelMb })} · 5 voices
                </span>
                <button
                  type="button"
                  className="mb-primary-btn"
                  data-testid="kokoro-download-btn"
                  onClick={() => {
                    void modelsApi.download(
                      KOKORO_MODEL_ID,
                      {
                        source: settings.modelDownloadSource,
                        mirrorBaseUrl: settings.modelMirrorBaseUrl,
                      } as never,
                    );
                  }}
                >
                  {t('download')}
                </button>
              </>
            )}

            {modelState === 'downloading' && (
              <>
                <span data-testid="kokoro-status-text">
                  {isEink
                    ? formatSteppedEinkPct(displayPct)
                    : t('downloadingPct', { pct: displayPct })}
                  {(() => {
                    const effectiveSource = resolveEffectiveModelSourceHost(
                      modelStatus?.source,
                      settings.modelDownloadSource,
                      settings.modelMirrorBaseUrl,
                    );
                    return effectiveSource
                      ? ` · ${t('viaSource', { source: effectiveSource })}`
                      : '';
                  })()}
                </span>
                <button
                  type="button"
                  className="mb-icon-btn"
                  data-testid="kokoro-pause-btn"
                  onClick={() => {
                    void modelsApi.pause(KOKORO_MODEL_ID);
                  }}
                >
                  {t('pause')}
                </button>
              </>
            )}

            {modelState === 'paused' && (
              <>
                <span data-testid="kokoro-status-text">
                  {isEink
                    ? formatSteppedEinkPct(displayPct)
                    : t('pausedPct', { pct: displayPct })}
                </span>
                <div className="mb-library-actions">
                  <button
                    type="button"
                    className="mb-primary-btn"
                    data-testid="kokoro-resume-btn"
                    onClick={() => {
                      void modelsApi.download(
                        KOKORO_MODEL_ID,
                        {
                          source: settings.modelDownloadSource,
                          mirrorBaseUrl: settings.modelMirrorBaseUrl,
                        } as never,
                      );
                    }}
                  >
                    {t('resume')}
                  </button>
                  <button
                    type="button"
                    className="mb-icon-btn"
                    data-testid="kokoro-delete-paused-btn"
                    onClick={() => {
                      void modelsApi.remove(KOKORO_MODEL_ID);
                    }}
                  >
                    {t('delete')}
                  </button>
                </div>
              </>
            )}

            {modelState === 'verifying' && (
              <span data-testid="kokoro-status-text">{t('checking')}</span>
            )}

            {modelState === 'ready' && (
              <>
                <span data-testid="kokoro-status-text">
                  {t('readySize', { mb: installedModelMb })} · {backendBadge}
                  {modelStatus?.rtf
                    ? ` · ${t('timesRealTime', {
                        x: (1 / Math.max(0.05, modelStatus.rtf)).toFixed(1),
                      })}`
                    : ''}
                </span>
                <button
                  type="button"
                  className="mb-icon-btn mb-danger-text"
                  data-testid="kokoro-delete-btn"
                  onClick={() => {
                    if (!confirmingDelete) {
                      setConfirmingDelete(true);
                      if (deleteTimerRef.current !== null) {
                        clearTimeout(deleteTimerRef.current);
                      }
                      deleteTimerRef.current = setTimeout(() => {
                        setConfirmingDelete(false);
                        deleteTimerRef.current = null;
                      }, 4000);
                      return;
                    }
                    if (deleteTimerRef.current !== null) {
                      clearTimeout(deleteTimerRef.current);
                      deleteTimerRef.current = null;
                    }
                    setConfirmingDelete(false);
                    void modelsApi.remove(KOKORO_MODEL_ID);
                  }}
                >
                  {confirmingDelete ? t('deleteConfirm') : t('delete')}
                </button>
              </>
            )}

            {modelState === 'error' && errorInfo && (
              <>
                <span data-testid="kokoro-status-text">{errorInfo.message}</span>
                {errorInfo.actionKind !== 'none' && (
                  <button
                    type="button"
                    className="mb-primary-btn"
                    data-testid="kokoro-retry-btn"
                    onClick={() => {
                      const dlOpts = {
                        source: settings.modelDownloadSource,
                        mirrorBaseUrl: settings.modelMirrorBaseUrl,
                      } as never;
                      if (errorInfo.actionKind === 'try-again') {
                        void modelsApi.remove(KOKORO_MODEL_ID).then(() => {
                          void modelsApi.download(KOKORO_MODEL_ID, dlOpts);
                        });
                      } else {
                        void modelsApi.download(KOKORO_MODEL_ID, dlOpts);
                      }
                    }}
                  >
                    {errorInfo.actionKind === 'try-again' ? t('tryAgain') : t('retry')}
                  </button>
                )}
              </>
            )}
          </div>

          {(modelState === 'downloading' || modelState === 'paused') && (
            <div
              className="mb-progress-track"
              data-block="true"
              data-testid="kokoro-progress-track"
            >
              <div
                className="mb-progress-fill"
                style={{ width: `${displayPct}%` }}
              />
            </div>
          )}

          <div className="mb-sheet-row">
            <span className="mb-sheet-label">{t('downloadFrom')}</span>
            <Segmented<Exclude<ModelDownloadSource, 'custom'>>
              label={t('downloadFrom')}
              value={
                settings.modelDownloadSource === 'custom'
                  ? 'hf-mirror'
                  : settings.modelDownloadSource
              }
              options={[
                { value: 'auto', label: t('sourceAuto') },
                { value: 'huggingface', label: t('sourceHf') },
                { value: 'hf-mirror', label: t('sourceMirror') },
              ]}
              onChange={(modelDownloadSource) => {
                setCustomMirrorUrl('');
                void (async () => {
                  await updateSettings({
                    modelDownloadSource,
                    modelMirrorBaseUrl: null,
                  });
                  if (modelStatus?.state === 'downloading') {
                    void modelsApi.download(
                      KOKORO_MODEL_ID,
                      {
                        source: modelDownloadSource,
                        mirrorBaseUrl: null,
                      } as never,
                    );
                  }
                })();
              }}
            />
          </div>

          <input
            type="url"
            className="mb-input"
            placeholder="https://hf-mirror.com"
            aria-label={t('customMirror')}
            value={customMirrorUrl}
            onChange={(e) => {
              const nextVal = e.target.value;
              setCustomMirrorUrl(nextVal);
              const trimmed = nextVal.trim();
              const nextSource: ModelDownloadSource = trimmed ? 'custom' : 'auto';
              const nextMirror = trimmed ? trimmed : null;
              void (async () => {
                await updateSettings({
                  modelMirrorBaseUrl: nextMirror,
                  modelDownloadSource: nextSource,
                });
                if (modelStatus?.state === 'downloading') {
                  void modelsApi.download(
                    KOKORO_MODEL_ID,
                    {
                      source: nextSource,
                      mirrorBaseUrl: nextMirror,
                    } as never,
                  );
                }
              })();
            }}
          />

          {modelState === 'ready' && (
            <div>
              {KOKORO_CURATED_VOICES.map((voiceId) => {
                const isInstalled = modelStatus?.installedVoices.includes(voiceId) ?? false;
                const langKey = kokoroVoiceLang(voiceId).split('-')[0]?.toLowerCase() ?? 'en';
                const activePref = settings.preferredVoices[langKey] ?? settings.preferredVoices.default;
                const isSelected =
                  activePref?.kind === 'kokoro' && activePref.voiceId === voiceId;

                return (
                  <div key={voiceId} className="mb-sheet-row">
                    <span>{formatKokoroVoiceLabel(voiceId, locale)}</span>
                    {isInstalled ? (
                      <button
                        type="button"
                        className="mb-icon-btn"
                        aria-pressed={isSelected}
                        onClick={() => {
                          void updateSettings({
                            preferredVoices: {
                              ...settings.preferredVoices,
                              [langKey]: { kind: 'kokoro', voiceId },
                              default: { kind: 'kokoro', voiceId },
                            },
                          });
                        }}
                      >
                        {isSelected ? '✓' : t('voice')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="mb-icon-btn"
                        onClick={() => {
                          void modelsApi.download(
                            KOKORO_MODEL_ID,
                            {
                              voices: [voiceId],
                              source: settings.modelDownloadSource,
                              mirrorBaseUrl: settings.modelMirrorBaseUrl,
                            } as never,
                          );
                        }}
                      >
                        {t('get')}
                      </button>
                    )}
                  </div>
                );
              })}

              <button
                type="button"
                className="mb-list-row"
                data-testid="kokoro-more-voices-btn"
                onClick={() => useRouteStore.getState().openSheet('kokoro-voices')}
              >
                <span>{t('moreKokoroVoices', { n: KOKORO_VOICE_IDS.length })}</span>
                <span className="mb-list-row-meta">▸</span>
              </button>
            </div>
          )}
        </Sheet>
      )}

      {/* Kokoro Full 103-Voice Catalog Sheet (`activeSheet === 'kokoro-voices'`, backed by PagedList) */}
      {modelsApi && (
        <Sheet
          open={activeSheet === 'kokoro-voices'}
          label={t('moreKokoroVoices', { n: KOKORO_VOICE_IDS.length })}
          listSheet
          onClose={handleCloseSheet}
        >
          <PagedList
            items={allKokoroCatalogItems}
            isEink={isEink}
            layer="sheet"
            estimatedItemHeight={48}
            fallbackPageSize={6}
            prevLabel={t('prevPage')}
            nextLabel={t('nextPage')}
            ariaLabel={t('moreKokoroVoices', { n: KOKORO_VOICE_IDS.length })}
            onPageTurn={(swap) => {
              void refreshController.runTurn({
                isEink,
                cadence: settings.fullRefreshEvery,
                swap,
              });
            }}
            renderItems={(visible) => (
              <div role="listbox" aria-label={t('voice')}>
                {visible.map((item) => (
                  <button
                    key={item.voiceId}
                    type="button"
                    role="option"
                    aria-selected={item.installed}
                    className="mb-list-row"
                    onClick={() => {
                      if (item.installed) {
                        void updateSettings({
                          preferredVoices: {
                            ...settings.preferredVoices,
                            [item.langKey]: { kind: 'kokoro', voiceId: item.voiceId },
                            default: { kind: 'kokoro', voiceId: item.voiceId },
                          },
                        });
                        useRouteStore.getState().closeSheetWithRefresh();
                      } else {
                        void modelsApi.download(
                          KOKORO_MODEL_ID,
                          {
                            voices: [item.voiceId],
                            source: settings.modelDownloadSource,
                            mirrorBaseUrl: settings.modelMirrorBaseUrl,
                          } as never,
                        );
                      }
                    }}
                  >
                    <span>{item.label}</span>
                    <span className="mb-list-row-meta">
                      {item.installed ? '✓' : t('get')}
                    </span>
                  </button>
                ))}
              </div>
            )}
          />
        </Sheet>
      )}

      {/* Local GPU Server (`mlx-audio` / `Qwen3-TTS` / `vllm-omni`) Sheet (`activeSheet === 'qwen-server'`) */}
      <Sheet
        open={activeSheet === 'qwen-server'}
        label={t('localGpuServer')}
        onClose={handleCloseSheet}
      >
        <div className="mb-sheet-row">
          <span className="mb-sheet-label">{t('preset')}</span>
          <Stepper
            valueLabel={QWEN_PRESETS[qwenPresetIdx]?.label ?? QWEN_PRESETS[0]!.label}
            canDecrement={QWEN_PRESETS.length > 1}
            canIncrement={QWEN_PRESETS.length > 1}
            decrementLabel="Previous preset"
            incrementLabel="Next preset"
            onDecrement={() => applyQwenPreset(qwenPresetIdx - 1)}
            onIncrement={() => applyQwenPreset(qwenPresetIdx + 1)}
          />
        </div>

        <input
          type="url"
          className="mb-input"
          placeholder="http://192.168.1.20:8000"
          aria-label={t('serverUrl')}
          value={qwenUrl}
          onChange={(e) => setQwenUrl(e.target.value)}
        />
        <input
          type="text"
          className="mb-input"
          placeholder="Vivian"
          aria-label={t('voiceName')}
          value={qwenVoice}
          onChange={(e) => setQwenVoice(e.target.value)}
        />
        {qwenProtocol !== 'qwen-native' && (
          <input
            type="text"
            className="mb-input"
            placeholder={QWEN_PRESETS[qwenPresetIdx]?.model ?? 'Qwen3-TTS'}
            aria-label={t('modelName')}
            value={qwenModel}
            onChange={(e) => setQwenModel(e.target.value)}
          />
        )}
        <input
          type="text"
          className="mb-input"
          placeholder={t('styleInstruction')}
          aria-label={t('styleInstruction')}
          value={qwenInstruct}
          onChange={(e) => setQwenInstruct(e.target.value)}
        />
        {qwenProtocol === 'qwen-native' && (
          <>
            <input
              type="text"
              className="mb-input"
              placeholder={t('referenceAudio')}
              aria-label={t('referenceAudio')}
              value={qwenRefAudio}
              onChange={(e) => setQwenRefAudio(e.target.value)}
            />
            <input
              type="text"
              className="mb-input"
              placeholder={t('referenceText')}
              aria-label={t('referenceText')}
              value={qwenRefText}
              onChange={(e) => setQwenRefText(e.target.value)}
            />
          </>
        )}

        <div className="mb-sheet-row">
          <div className="mb-library-actions">
            <button
              type="button"
              className="mb-icon-btn"
              data-testid="qwen-test-btn"
              onClick={() => {
                const targetUrl = qwenUrl.trim() || 'http://127.0.0.1:8000';
                const targetVoice = qwenVoice.trim() || 'Vivian';
                const targetModel = qwenModel.trim() || QWEN_PRESETS[0]!.model;
                void (async () => {
                  try {
                    const res = await host.speech.synthesize({
                      engine: 'qwen',
                      voiceId: targetVoice,
                      model: targetModel,
                      text: '你好，世界。Hello world.',
                      lang: 'zh-CN',
                      baseUrl: targetUrl,
                    });
                    const genSec = (Math.max(100, res.synthMs) / 1000).toFixed(1);
                    const durSec = (Math.max(500, res.durationMs ?? 1600) / 1000).toFixed(1);
                    setQwenTestStatus(t('testOk', { gen: genSec, dur: durSec }));
                  } catch {
                    setQwenTestStatus(t('errNoConnection'));
                  }
                })();
              }}
            >
              {t('test')}
            </button>
            <button
              type="button"
              className="mb-primary-btn"
              data-testid="qwen-save-btn"
              onClick={() => {
                const trimmedUrl = qwenUrl.trim();
                void updateSettings({
                  qwenServer: trimmedUrl
                    ? {
                        baseUrl: trimmedUrl,
                        protocol: qwenProtocol,
                        model: qwenModel.trim() || QWEN_PRESETS[0]!.model,
                        voice: qwenVoice.trim() || 'Vivian',
                        ...(qwenInstruct.trim() ? { instruct: qwenInstruct.trim() } : {}),
                        ...(qwenRefAudio.trim() ? { refAudio: qwenRefAudio.trim() } : {}),
                        ...(qwenRefText.trim() ? { refText: qwenRefText.trim() } : {}),
                      }
                    : null,
                });
                useRouteStore.getState().closeSheetWithRefresh();
              }}
            >
              {t('save')}
            </button>
          </div>
          {settings.qwenServer && (
            <button
              type="button"
              className="mb-icon-btn"
              data-testid="qwen-clear-btn"
              onClick={() => {
                void updateSettings({ qwenServer: null });
                useRouteStore.getState().closeSheetWithRefresh();
              }}
            >
              {t('clear')}
            </button>
          )}
        </div>

        {qwenTestStatus && (
          <div className="mb-list-row-meta" role="status" data-testid="qwen-test-status">
            {qwenTestStatus}
          </div>
        )}

        <div className="mb-list-row-meta" data-testid="qwen-mac-script-hint">
          {t('macScriptHint')}
        </div>
      </Sheet>

      {/* Custom OpenAI-Compatible Speech Server Sheet */}
      <Sheet
        open={activeSheet === 'custom-server'}
        label={t('customSpeechServer')}
        onClose={handleCloseSheet}
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
              useRouteStore.getState().closeSheetWithRefresh();
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
                useRouteStore.getState().closeSheetWithRefresh();
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
