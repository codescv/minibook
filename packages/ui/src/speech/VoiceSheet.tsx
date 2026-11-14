import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  KOKORO_CURATED_VOICES,
  KOKORO_MODEL_ID,
  KOKORO_VOICE_IDS,
  kokoroVoiceLang,
  type ModelDownloadSource,
  type QwenProtocol,
  type SleepTimerConfig,
  type Voice,
  type VoiceRef,
} from '@minibook/core';
import { useRouteStore } from '../app/routes';
import { Segmented } from '../components/Segmented';
import { Sheet } from '../components/Sheet';
import { Stepper } from '../components/Stepper';
import { Toggle } from '../components/Toggle';
import { PagedList } from '../eink/PagedList';
import { useHostContext } from '../host/HostContext';
import { resolveLocale, useT } from '../i18n';
import { useReadAloudStore, type ReadAloudController } from './ReadAloudController';
import {
  formatKokoroVoiceLabel,
  formatModelBackendBadge,
  formatModelErrorInfo,
  formatSteppedEinkPct,
  getSpeechModelsApi,
  resolveEffectiveModelSourceHost,
  useSpeechModelStatus,
  useSpeechModelStore,
} from './speech-model-store';

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

export interface VoiceSheetProps {
  readonly open: boolean;
  readonly controller: ReadAloudController;
  readonly onCloseSheet: (coveredHalf: boolean) => void;
}

export type TtsCategoryTab = 'system' | 'on-device' | 'server';
export type ServerSubTab = 'qwen' | 'openai' | 'edge';

interface VoiceTabRowItem {
  readonly key: string;
  readonly render: () => ReactElement;
}

function voiceMatchesRef(entry: VoiceRef, active: VoiceRef | null): boolean {
  if (!active) return entry.kind === 'system' && entry.voiceId === null;
  if (entry.kind !== active.kind) return false;
  if (entry.kind === 'system' && active.kind === 'system') {
    return entry.voiceId === active.voiceId;
  }
  return entry.voiceId === active.voiceId;
}

/**
 * Guided 3-Tab Voice & Speed Sheet (`v0.2.3`):
 * Popped up directly from `ReadAloudBar` (`activeSheet === 'voice'`).
 * - Top row: Speed Stepper (`0.5×–3.0×`)
 * - Second row: 3-way Segmented tabs (`系统原生` / `本地模型` / `Server`)
 * - Plain-language guide card at the top of every tab
 * - Explicit field labels + self-explanatory placeholders on every Server input
 * - Constant-geometry Kokoro model card (`0px` vertical layout shift across download states)
 * - Backed by `PagedList` (`layer="sheet"`) for smooth scroll in normal mode & zero-scroll E-Ink pagination
 */
export function VoiceSheet({
  open,
  controller,
  onCloseSheet,
}: VoiceSheetProps): ReactElement | null {
  const t = useT();
  const locale = useMemo(() => resolveLocale(), []);
  const { host, speechPlayer, settings, isEink, refreshController, updateSettings } =
    useHostContext();
  const rate = useReadAloudStore((s) => s.rate);
  const selectedVoice = useReadAloudStore((s) => s.voice);
  const bookLang = useReadAloudStore((s) => s.bookLang);
  const slowVoiceRtf = useReadAloudStore((s) => s.slowVoiceRtf);

  const modelsApi = getSpeechModelsApi(host);
  const { status: modelStatus, displayPct } = useSpeechModelStatus(host, isEink);

  const [activeTab, setActiveTab] = useState<TtsCategoryTab>('system');
  const [serverSubTab, setServerSubTab] = useState<ServerSubTab>('qwen');
  const [showAllSystemVoices, setShowAllSystemVoices] = useState(false);
  const [showAllKokoroVoices, setShowAllKokoroVoices] = useState(false);
  const [showCloneFields, setShowCloneFields] = useState(false);

  const [systemVoices, setSystemVoices] = useState<Voice[]>([]);
  const [edgeVoices, setEdgeVoices] = useState<Voice[]>([]);

  // Kokoro custom mirror input, voice-pack fetch indicator & 2-tap delete confirmation
  const [customMirrorUrl, setCustomMirrorUrl] = useState(settings.modelMirrorBaseUrl ?? '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [fetchingVoiceId, setFetchingVoiceId] = useState<string | null>(null);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Local GPU Server (Qwen3-TTS / mlx-audio / vllm-omni) draft state
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

  // OpenAI-compatible Server draft state
  const [srvUrl, setSrvUrl] = useState(settings.customSpeechServer?.baseUrl ?? '');
  const [srvModel, setSrvModel] = useState(settings.customSpeechServer?.model ?? 'tts-1');
  const [srvVoice, setSrvVoice] = useState(settings.customSpeechServer?.voice ?? 'alloy');
  const [srvApiKey, setSrvApiKey] = useState('');

  const wasOpenRef = useRef(false);

  useEffect(() => {
    return () => {
      if (deleteTimerRef.current !== null) {
        clearTimeout(deleteTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setConfirmingDelete(false);
    if (modelStatus?.state === 'ready' || modelStatus?.state === 'absent' || modelStatus?.state === 'error') {
      setFetchingVoiceId(null);
    }
    if (deleteTimerRef.current !== null) {
      clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = null;
    }
  }, [modelStatus?.state, open, activeTab]);

  // Sync active tab and form inputs when sheet transitions closed -> open
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const kind = selectedVoice?.kind ?? 'system';
      if (kind === 'kokoro' && modelsApi) {
        setActiveTab('on-device');
      } else if (kind === 'qwen' || kind === 'openai' || kind === 'edge') {
        setActiveTab('server');
        setServerSubTab(kind === 'openai' ? 'openai' : kind === 'edge' ? 'edge' : 'qwen');
      } else {
        setActiveTab('system');
        if (!settings.qwenServer && settings.customSpeechServer) {
          setServerSubTab('openai');
        } else if (!settings.qwenServer && !settings.customSpeechServer && settings.edgeVoicesEnabled) {
          setServerSubTab('edge');
        } else {
          setServerSubTab('qwen');
        }
      }

      setCustomMirrorUrl(settings.modelMirrorBaseUrl ?? '');
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
        setShowCloneFields(Boolean(q.refAudio || q.refText));
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
        setShowCloneFields(false);
      }
      setQwenTestStatus(null);

      setSrvUrl(settings.customSpeechServer?.baseUrl ?? '');
      setSrvModel(settings.customSpeechServer?.model ?? 'tts-1');
      setSrvVoice(settings.customSpeechServer?.voice ?? 'alloy');
      setSrvApiKey('');
    }
    wasOpenRef.current = open;
  }, [
    open,
    selectedVoice,
    modelsApi,
    settings.modelMirrorBaseUrl,
    settings.qwenServer,
    settings.customSpeechServer,
    settings.edgeVoicesEnabled,
  ]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void speechPlayer
      .listVoices()
      .then((v) => {
        if (!cancelled) setSystemVoices(v);
      })
      .catch(() => {});

    if (settings.edgeVoicesEnabled) {
      void host.speech
        .listRemoteVoices('edge')
        .then((v) => {
          if (!cancelled) setEdgeVoices(v);
        })
        .catch(() => {});
    } else {
      setEdgeVoices([]);
    }
    return () => {
      cancelled = true;
    };
  }, [open, speechPlayer, host, settings.edgeVoicesEnabled]);

  const langPrefix = (bookLang?.split('-')[0] ?? 'en').toLowerCase();

  const selectAndPersistVoice = (ref: VoiceRef, targetLangKey = langPrefix): void => {
    void updateSettings({
      preferredVoices: {
        ...settings.preferredVoices,
        [targetLangKey]: ref,
        default: ref,
      },
    });
    controller.setVoice(ref);
  };

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

  const backendBadge = formatModelBackendBadge(
    modelStatus,
    host.info.platform,
    t('onDevice'),
  );
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

  const allKokoroCatalogItems = useMemo(() => {
    const preferZh = locale.toLowerCase().startsWith('zh') || langPrefix === 'zh';
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
  }, [locale, langPrefix, modelStatus?.installedVoices]);

  const tabItems = useMemo<VoiceTabRowItem[]>(() => {
    const rows: VoiceTabRowItem[] = [];

    if (activeTab === 'system') {
      rows.push({
        key: 'sys-guide',
        render: () => (
          <div className="mb-tts-guide" data-testid="tts-guide-system">
            {t('ttsGuideSystem')}
          </div>
        ),
      });

      const matchesBookLang = (v: Voice): boolean => {
        const vl = (v.lang.split('-')[0] ?? '').toLowerCase();
        return !vl || vl === langPrefix;
      };
      const filteredSystem = systemVoices.filter(matchesBookLang);
      const hasFilteredSubset =
        filteredSystem.length > 0 && filteredSystem.length < systemVoices.length;
      const sysSource =
        showAllSystemVoices || filteredSystem.length === 0 ? systemVoices : filteredSystem;
      const sortedSys = [...sysSource].sort((a, b) =>
        (a.engine ?? 'System').localeCompare(b.engine ?? 'System'),
      );

      const defaultSysRef: VoiceRef = { kind: 'system', voiceId: null };
      const defaultSelected = voiceMatchesRef(defaultSysRef, selectedVoice);
      rows.push({
        key: 'sys:default',
        render: () => (
          <button
            type="button"
            role="option"
            aria-selected={defaultSelected}
            className="mb-list-row"
            onClick={() => selectAndPersistVoice(defaultSysRef)}
          >
            <span>{t('systemDefault')}</span>
            <span aria-hidden="true">{defaultSelected ? '✓' : ''}</span>
          </button>
        ),
      });

      for (const v of sortedSys) {
        const ref: VoiceRef = {
          kind: 'system',
          voiceId: v.id,
          ...(v.engine ? { engine: v.engine } : {}),
        };
        const selected = voiceMatchesRef(ref, selectedVoice);
        const vLangKey = (v.lang.split('-')[0] ?? langPrefix).toLowerCase() || langPrefix;
        rows.push({
          key: `sys:${v.engine ?? 'System'}:${v.id}`,
          render: () => (
            <button
              type="button"
              role="option"
              aria-selected={selected}
              className="mb-list-row"
              onClick={() => selectAndPersistVoice(ref, vLangKey)}
            >
              <span>
                {v.name}{' '}
                <span className="mb-list-row-meta">{v.engine ?? v.lang}</span>
              </span>
              <span aria-hidden="true">{selected ? '✓' : ''}</span>
            </button>
          ),
        });
      }

      if (hasFilteredSubset) {
        rows.push({
          key: 'sys:toggle-all',
          render: () => (
            <button
              type="button"
              className="mb-list-row"
              data-testid="system-show-all-btn"
              onClick={() => setShowAllSystemVoices((prev) => !prev)}
            >
              <span className="mb-list-row-meta">
                {showAllSystemVoices
                  ? t('showBookLangVoicesOnly')
                  : t('showAllSystemVoices', { n: systemVoices.length })}
              </span>
              <span className="mb-list-row-meta">{showAllSystemVoices ? '▴' : '▾'}</span>
            </button>
          ),
        });
      }

      return rows;
    }

    if (activeTab === 'on-device' && modelsApi) {
      rows.push({
        key: 'kokoro-guide',
        render: () => (
          <div className="mb-tts-guide" data-testid="tts-guide-on-device">
            {t('ttsGuideOnDevice', { mb: totalModelMb })}
          </div>
        ),
      });

      const showProgressBar =
        modelState === 'downloading' || modelState === 'paused' || modelState === 'verifying';
      const progressWidth = modelState === 'verifying' ? 100 : displayPct;

      rows.push({
        key: 'kokoro-model-card',
        render: () => (
          <div className="mb-kokoro-card" data-testid="kokoro-model-card">
            <div className="mb-kokoro-card-head">
              <div className="mb-kokoro-card-title">
                <span className="mb-sheet-label">{t('kokoroTitle')}</span>{' '}
                {host.info.platform === 'ios' && (
                  <span className="mb-badge">{t('beta')}</span>
                )}
              </div>
              <span className="mb-badge" data-testid="kokoro-backend-badge">
                {backendBadge}
              </span>
            </div>

            <div className="mb-kokoro-status-row" data-testid="kokoro-model-status-row">
              {modelState === 'absent' && (
                <>
                  <span className="mb-kokoro-status-label" data-testid="kokoro-status-text">
                    {t('kokoroSizeAndVoices', {
                      mb: totalModelMb,
                      count: 5,
                    })}
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
                  <span className="mb-kokoro-status-label" data-testid="kokoro-status-text">
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
                  <span className="mb-kokoro-status-label" data-testid="kokoro-status-text">
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
                <span className="mb-kokoro-status-label" data-testid="kokoro-status-text">
                  {t('checking')}
                </span>
              )}

              {modelState === 'ready' && (
                <>
                  <span className="mb-kokoro-status-label" data-testid="kokoro-status-text">
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
                      if (selectedVoice?.kind === 'kokoro') {
                        selectAndPersistVoice({ kind: 'system', voiceId: null });
                      }
                      void modelsApi.remove(KOKORO_MODEL_ID);
                    }}
                  >
                    {confirmingDelete ? t('deleteConfirm') : t('delete')}
                  </button>
                </>
              )}

              {modelState === 'error' && errorInfo && (
                <>
                  <span className="mb-kokoro-status-label" data-testid="kokoro-status-text">
                    {errorInfo.message}
                  </span>
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

            <div className="mb-kokoro-progress-slot">
              {showProgressBar && (
                <div
                  className="mb-progress-track"
                  data-block="true"
                  data-testid="kokoro-progress-track"
                >
                  <div
                    className="mb-progress-fill"
                    style={{ width: `${progressWidth}%` }}
                  />
                </div>
              )}
            </div>
          </div>
        ),
      });

      rows.push({
        key: 'kokoro-source-seg',
        render: () => (
          <div className="mb-field" data-testid="kokoro-download-from-row">
            <span className="mb-field-label">{t('downloadFrom')}</span>
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
                  const latestState =
                    useSpeechModelStore.getState().status?.state ?? modelStatus?.state;
                  if (latestState === 'downloading' || latestState === 'verifying') {
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
        ),
      });

      rows.push({
        key: 'kokoro-custom-mirror',
        render: () => (
          <label className="mb-field">
            <span className="mb-field-label">{t('customMirror')}</span>
            <span className="mb-field-caption">{t('customMirrorHint')}</span>
            <input
              type="url"
              className="mb-input"
              placeholder={t('customMirrorPlaceholder')}
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
                  const latestState =
                    useSpeechModelStore.getState().status?.state ?? modelStatus?.state;
                  if (latestState === 'downloading' || latestState === 'verifying') {
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
          </label>
        ),
      });

      // Keep voice list mounted once the base Kokoro model is installed so fetching an extra voice (`获取`) never flickers/unmounts the list!
      const hasInstalledKokoroCore =
        modelState === 'ready' || (modelStatus?.installedVoices?.length ?? 0) > 0;
      const isModelBusy = modelState === 'downloading' || modelState === 'verifying';

      if (hasInstalledKokoroCore) {
        const voiceList = showAllKokoroVoices
          ? allKokoroCatalogItems
          : KOKORO_CURATED_VOICES.map((voiceId) => ({
              voiceId,
              label: formatKokoroVoiceLabel(voiceId, locale),
              installed: modelStatus?.installedVoices.includes(voiceId) ?? false,
              langKey: kokoroVoiceLang(voiceId).split('-')[0]?.toLowerCase() ?? 'en',
            }));

        for (const item of voiceList) {
          const ref: VoiceRef = { kind: 'kokoro', voiceId: item.voiceId };
          const isSelected = voiceMatchesRef(ref, selectedVoice);
          const isThisVoiceFetching = isModelBusy && fetchingVoiceId === item.voiceId;
          rows.push({
            key: `kokoro-voice:${item.voiceId}`,
            render: () => (
              <div className="mb-sheet-row">
                <span>
                  {item.label}{' '}
                  {isSelected && (
                    <span className="mb-badge">{t('activeNow')}</span>
                  )}
                </span>
                {item.installed ? (
                  <button
                    type="button"
                    className="mb-icon-btn"
                    aria-pressed={isSelected}
                    onClick={() => selectAndPersistVoice(ref, item.langKey)}
                  >
                    {isSelected ? '✓' : t('useVoice')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="mb-icon-btn"
                    disabled={isModelBusy}
                    onClick={() => {
                      setFetchingVoiceId(item.voiceId);
                      void modelsApi.download(
                        KOKORO_MODEL_ID,
                        {
                          voices: [item.voiceId],
                          source: settings.modelDownloadSource,
                          mirrorBaseUrl: settings.modelMirrorBaseUrl,
                        } as never,
                      );
                    }}
                  >
                    {isThisVoiceFetching ? t('checking') : t('get')}
                  </button>
                )}
              </div>
            ),
          });
        }

        rows.push({
          key: 'kokoro-toggle-all',
          render: () => (
            <button
              type="button"
              className="mb-list-row"
              data-testid="kokoro-more-voices-btn"
              onClick={() => setShowAllKokoroVoices((prev) => !prev)}
            >
              <span>
                {showAllKokoroVoices
                  ? t('collapseVoices')
                  : t('allKokoroVoices', { n: KOKORO_VOICE_IDS.length })}
              </span>
              <span className="mb-list-row-meta">{showAllKokoroVoices ? '▴' : '▾'}</span>
            </button>
          ),
        });
      }

      return rows;
    }

    // Tab 3: Server (`qwen` | `openai` | `edge`)
    rows.push({
      key: 'srv-guide',
      render: () => (
        <div className="mb-tts-guide" data-testid="tts-guide-server">
          {t('ttsGuideServer')}
        </div>
      ),
    });

    rows.push({
      key: 'srv-subtabs',
      render: () => (
        <div className="mb-voice-subtabs" data-testid="tts-server-subtabs">
          <Segmented<ServerSubTab>
            label={t('ttsTabServer')}
            value={serverSubTab}
            options={[
              { value: 'qwen', label: t('serverTabLanGpu') },
              { value: 'openai', label: t('serverTabOpenAi') },
              { value: 'edge', label: t('serverTabEdge') },
            ]}
            onChange={(next) => setServerSubTab(next)}
          />
        </div>
      ),
    });

    if (serverSubTab === 'qwen') {
      const qwenActive = selectedVoice?.kind === 'qwen';
      const protocolHint =
        qwenProtocol === 'qwen-native'
          ? t('protocolHintQwenNative')
          : qwenProtocol === 'vllm-omni'
            ? t('protocolHintVllm')
            : t('protocolHintMlx');

      rows.push({
        key: 'qwen-hint',
        render: () => (
          <div className="mb-server-subhint" data-testid="qwen-mac-script-hint">
            <span>{t('macScriptHint')}</span>
            {qwenActive && <span className="mb-badge">{t('activeNow')} ✓</span>}
          </div>
        ),
      });

      rows.push({
        key: 'qwen-preset',
        render: () => (
          <div className="mb-field">
            <span className="mb-field-label">{t('preset')}</span>
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
        ),
      });

      rows.push({
        key: 'qwen-url',
        render: () => (
          <label className="mb-field">
            <span className="mb-field-label">{t('serverUrl')}</span>
            <span className="mb-field-caption">{t('qwenUrlHint')}</span>
            <input
              type="url"
              className="mb-input"
              data-testid="qwen-url-input"
              placeholder={t('qwenUrlPlaceholder')}
              aria-label={t('serverUrl')}
              value={qwenUrl}
              onChange={(e) => setQwenUrl(e.target.value)}
            />
          </label>
        ),
      });

      rows.push({
        key: 'qwen-protocol',
        render: () => (
          <div className="mb-field">
            <span className="mb-field-label">{t('protocolLabel')}</span>
            <Segmented<QwenProtocol>
              label={t('protocolLabel')}
              value={qwenProtocol}
              options={[
                { value: 'mlx-audio', label: 'mlx-audio' },
                { value: 'qwen-native', label: 'qwen-tts' },
                { value: 'vllm-omni', label: 'vLLM-Omni' },
              ]}
              onChange={(nextProto) => setQwenProtocol(nextProto)}
            />
            <div className="mb-field-caption">{protocolHint}</div>
          </div>
        ),
      });

      rows.push({
        key: 'qwen-model',
        render: () => (
          <label className="mb-field">
            <span className="mb-field-label">{t('modelName')}</span>
            <span className="mb-field-caption">{t('qwenModelHint')}</span>
            <input
              type="text"
              className="mb-input"
              data-testid="qwen-model-input"
              placeholder={t('qwenModelPlaceholder')}
              aria-label={t('modelName')}
              value={qwenModel}
              onChange={(e) => setQwenModel(e.target.value)}
            />
          </label>
        ),
      });

      rows.push({
        key: 'qwen-voice',
        render: () => (
          <label className="mb-field">
            <span className="mb-field-label">{t('voiceName')}</span>
            <span className="mb-field-caption">{t('qwenVoiceHint')}</span>
            <input
              type="text"
              className="mb-input"
              data-testid="qwen-voice-input"
              placeholder={t('qwenVoicePlaceholder')}
              aria-label={t('voiceName')}
              value={qwenVoice}
              onChange={(e) => setQwenVoice(e.target.value)}
            />
          </label>
        ),
      });

      rows.push({
        key: 'qwen-instruct',
        render: () => (
          <label className="mb-field">
            <span className="mb-field-label">{t('styleInstruction')}</span>
            <span className="mb-field-caption">{t('qwenInstructHint')}</span>
            <input
              type="text"
              className="mb-input"
              data-testid="qwen-instruct-input"
              placeholder={t('qwenInstructPlaceholder')}
              aria-label={t('styleInstruction')}
              value={qwenInstruct}
              onChange={(e) => setQwenInstruct(e.target.value)}
            />
          </label>
        ),
      });

      const cloneExpanded = qwenProtocol === 'qwen-native' || showCloneFields;
      if (qwenProtocol !== 'qwen-native') {
        rows.push({
          key: 'qwen-clone-toggle',
          render: () => (
            <button
              type="button"
              className="mb-list-row"
              data-testid="qwen-clone-toggle"
              onClick={() => setShowCloneFields((prev) => !prev)}
            >
              <span className="mb-list-row-meta">{t('advancedVoiceClone')}</span>
              <span className="mb-list-row-meta">{showCloneFields ? '▴' : '▾'}</span>
            </button>
          ),
        });
      }

      if (cloneExpanded) {
        rows.push({
          key: 'qwen-ref-audio',
          render: () => (
            <label className="mb-field">
              <span className="mb-field-label">{t('referenceAudio')}</span>
              <span className="mb-field-caption">{t('qwenRefAudioHint')}</span>
              <input
                type="text"
                className="mb-input"
                data-testid="qwen-ref-audio-input"
                placeholder={t('qwenRefAudioPlaceholder')}
                aria-label={t('referenceAudio')}
                value={qwenRefAudio}
                onChange={(e) => setQwenRefAudio(e.target.value)}
              />
            </label>
          ),
        });

        rows.push({
          key: 'qwen-ref-text',
          render: () => (
            <label className="mb-field">
              <span className="mb-field-label">{t('referenceText')}</span>
              <span className="mb-field-caption">{t('qwenRefTextHint')}</span>
              <input
                type="text"
                className="mb-input"
                data-testid="qwen-ref-text-input"
                placeholder={t('qwenRefTextPlaceholder')}
                aria-label={t('referenceText')}
                value={qwenRefText}
                onChange={(e) => setQwenRefText(e.target.value)}
              />
            </label>
          ),
        });
      }

      rows.push({
        key: 'qwen-actions',
        render: () => (
          <div className="mb-server-actions-wrap">
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
                  {t('testConnection')}
                </button>
                <button
                  type="button"
                  className="mb-primary-btn"
                  data-testid="qwen-save-btn"
                  onClick={() => {
                    const effectiveUrl =
                      qwenUrl.trim() ||
                      QWEN_PRESETS[qwenPresetIdx]?.defaultUrl ||
                      'http://127.0.0.1:8000';
                    const finalModel = qwenModel.trim() || QWEN_PRESETS[0]!.model;
                    const finalVoice = qwenVoice.trim() || 'Vivian';
                    const qwenRef: VoiceRef = {
                      kind: 'qwen',
                      voiceId: finalVoice,
                      model: finalModel,
                    };
                    setQwenUrl(effectiveUrl);
                    void updateSettings({
                      qwenServer: {
                        baseUrl: effectiveUrl,
                        protocol: qwenProtocol,
                        model: finalModel,
                        voice: finalVoice,
                        ...(qwenInstruct.trim() ? { instruct: qwenInstruct.trim() } : {}),
                        ...(qwenRefAudio.trim() ? { refAudio: qwenRefAudio.trim() } : {}),
                        ...(qwenRefText.trim() ? { refText: qwenRefText.trim() } : {}),
                      },
                      preferredVoices: {
                        ...settings.preferredVoices,
                        [langPrefix]: qwenRef,
                        default: qwenRef,
                      },
                    });
                    controller.setVoice(qwenRef);
                  }}
                >
                  {t('saveAndUse')}
                </button>
              </div>
              {settings.qwenServer && (
                <button
                  type="button"
                  className="mb-icon-btn"
                  data-testid="qwen-clear-btn"
                  onClick={() => {
                    void updateSettings({ qwenServer: null });
                    setQwenUrl('');
                    if (selectedVoice?.kind === 'qwen') {
                      selectAndPersistVoice({ kind: 'system', voiceId: null });
                    }
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
          </div>
        ),
      });
    } else if (serverSubTab === 'openai') {
      const openaiActive = selectedVoice?.kind === 'openai';

      rows.push({
        key: 'openai-hint',
        render: () => (
          <div className="mb-server-subhint" data-testid="openai-subhint">
            <span>{t('openaiSubHint')}</span>
            {openaiActive && <span className="mb-badge">{t('activeNow')} ✓</span>}
          </div>
        ),
      });

      rows.push({
        key: 'openai-url',
        render: () => (
          <label className="mb-field">
            <span className="mb-field-label">{t('serverUrl')}</span>
            <span className="mb-field-caption">{t('openaiUrlHint')}</span>
            <input
              type="url"
              className="mb-input"
              data-testid="openai-url-input"
              placeholder={t('openaiUrlPlaceholder')}
              aria-label={t('serverUrl')}
              value={srvUrl}
              onChange={(e) => setSrvUrl(e.target.value)}
            />
          </label>
        ),
      });

      rows.push({
        key: 'openai-model',
        render: () => (
          <label className="mb-field">
            <span className="mb-field-label">{t('modelName')}</span>
            <span className="mb-field-caption">{t('openaiModelHint')}</span>
            <input
              type="text"
              className="mb-input"
              data-testid="openai-model-input"
              placeholder={t('openaiModelPlaceholder')}
              aria-label={t('modelName')}
              value={srvModel}
              onChange={(e) => setSrvModel(e.target.value)}
            />
          </label>
        ),
      });

      rows.push({
        key: 'openai-voice',
        render: () => (
          <label className="mb-field">
            <span className="mb-field-label">{t('voiceName')}</span>
            <span className="mb-field-caption">{t('openaiVoiceHint')}</span>
            <input
              type="text"
              className="mb-input"
              data-testid="openai-voice-input"
              placeholder={t('openaiVoicePlaceholder')}
              aria-label={t('voiceName')}
              value={srvVoice}
              onChange={(e) => setSrvVoice(e.target.value)}
            />
          </label>
        ),
      });

      rows.push({
        key: 'openai-key',
        render: () => (
          <label className="mb-field">
            <span className="mb-field-label">{t('apiKey')}</span>
            <span className="mb-field-caption">{t('openaiKeyHint')}</span>
            <input
              type="password"
              className="mb-input"
              data-testid="openai-key-input"
              placeholder={t('openaiKeyPlaceholder')}
              aria-label={t('apiKey')}
              value={srvApiKey}
              onChange={(e) => setSrvApiKey(e.target.value)}
            />
          </label>
        ),
      });

      rows.push({
        key: 'openai-actions',
        render: () => (
          <div className="mb-sheet-row">
            <button
              type="button"
              className="mb-primary-btn"
              data-testid="openai-save-btn"
              onClick={() => {
                if (srvApiKey.trim()) {
                  void host.settings.setSecret('openai-api-key', srvApiKey.trim());
                }
                const effectiveUrl = srvUrl.trim() || 'https://api.openai.com';
                const finalModel = srvModel.trim() || 'tts-1';
                const finalVoice = srvVoice.trim() || 'alloy';
                const openaiRef: VoiceRef = {
                  kind: 'openai',
                  voiceId: finalVoice,
                  model: finalModel,
                };
                setSrvUrl(effectiveUrl);
                void updateSettings({
                  customSpeechServer: {
                    baseUrl: effectiveUrl,
                    model: finalModel,
                    voice: finalVoice,
                  },
                  preferredVoices: {
                    ...settings.preferredVoices,
                    [langPrefix]: openaiRef,
                    default: openaiRef,
                  },
                });
                controller.setVoice(openaiRef);
              }}
            >
              {t('saveAndUse')}
            </button>
            {settings.customSpeechServer && (
              <button
                type="button"
                className="mb-icon-btn"
                data-testid="openai-clear-btn"
                onClick={() => {
                  void host.settings.setSecret('openai-api-key', null);
                  void updateSettings({ customSpeechServer: null });
                  setSrvUrl('');
                  setSrvApiKey('');
                  if (selectedVoice?.kind === 'openai') {
                    selectAndPersistVoice({ kind: 'system', voiceId: null });
                  }
                }}
              >
                {t('clear')}
              </button>
            )}
          </div>
        ),
      });
    } else {
      // `edge` sub-tab
      rows.push({
        key: 'edge-hint',
        render: () => (
          <div className="mb-server-subhint" data-testid="edge-subhint">
            <span>{t('edgeSubHint')}</span>
          </div>
        ),
      });

      rows.push({
        key: 'edge-toggle',
        render: () => (
          <div className="mb-sheet-row" data-testid="edge-enable-row">
            <span className="mb-sheet-label">{t('enableEdgeVoices')}</span>
            <Toggle
              label={t('enableEdgeVoices')}
              checked={settings.edgeVoicesEnabled}
              isEink={isEink}
              onText={t('on')}
              offText={t('off')}
              onChange={(edgeVoicesEnabled) => {
                void updateSettings({ edgeVoicesEnabled });
                if (!edgeVoicesEnabled && selectedVoice?.kind === 'edge') {
                  selectAndPersistVoice({ kind: 'system', voiceId: null });
                }
              }}
            />
          </div>
        ),
      });

      if (settings.edgeVoicesEnabled) {
        const matchesBookLang = (v: Voice): boolean => {
          const vl = (v.lang.split('-')[0] ?? '').toLowerCase();
          return !vl || vl === langPrefix;
        };
        const filteredEdge = edgeVoices.filter(matchesBookLang);
        const edgeSource = filteredEdge.length > 0 ? filteredEdge : edgeVoices;

        for (const v of edgeSource) {
          const ref: VoiceRef = { kind: 'edge', voiceId: v.id };
          const selected = voiceMatchesRef(ref, selectedVoice);
          const vLangKey = (v.lang.split('-')[0] ?? langPrefix).toLowerCase() || langPrefix;
          rows.push({
            key: `edge:${v.id}`,
            render: () => (
              <button
                type="button"
                role="option"
                aria-selected={selected}
                className="mb-list-row"
                onClick={() => selectAndPersistVoice(ref, vLangKey)}
              >
                <span>
                  {v.name} <span className="mb-list-row-meta">Edge</span>
                </span>
                <span aria-hidden="true">{selected ? '✓' : ''}</span>
              </button>
            ),
          });
        }
      }
    }

    rows.push({
      key: 'srv-fallback',
      render: () => (
        <div className="mb-field" data-testid="server-fallback-row">
          <div className="mb-sheet-row mb-sheet-row-compact">
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
          <div className="mb-field-caption">{t('fallbackToSystemHint')}</div>
        </div>
      ),
    });

    return rows;
  }, [
    activeTab,
    serverSubTab,
    systemVoices,
    edgeVoices,
    showAllSystemVoices,
    showAllKokoroVoices,
    showCloneFields,
    selectedVoice,
    settings,
    modelsApi,
    modelState,
    modelStatus,
    displayPct,
    totalModelMb,
    installedModelMb,
    backendBadge,
    errorInfo,
    confirmingDelete,
    customMirrorUrl,
    allKokoroCatalogItems,
    qwenPresetIdx,
    qwenUrl,
    qwenProtocol,
    qwenModel,
    qwenVoice,
    qwenInstruct,
    qwenRefAudio,
    qwenRefText,
    qwenTestStatus,
    srvUrl,
    srvModel,
    srvVoice,
    srvApiKey,
    isEink,
    langPrefix,
    locale,
    host,
    controller,
    updateSettings,
    t,
  ]);

  const categoryOptions = useMemo(() => {
    const opts: Array<{ readonly value: TtsCategoryTab; readonly label: string }> = [
      { value: 'system', label: t('ttsTabSystem') },
    ];
    if (modelsApi) {
      opts.push({ value: 'on-device', label: t('ttsTabOnDevice') });
    }
    opts.push({ value: 'server', label: t('ttsTabServer') });
    return opts;
  }, [modelsApi, t]);

  const showSlowWarning =
    slowVoiceRtf !== null &&
    slowVoiceRtf >= 0.9 &&
    selectedVoice !== null &&
    selectedVoice.kind !== 'system';

  return (
    <Sheet
      open={open}
      label={t('voiceAndSpeed')}
      popoverOnDesktop={false}
      listSheet
      className="mb-voice-sheet"
      onClose={onCloseSheet}
    >
      <div className="mb-sheet-row mb-sheet-row-compact">
        <span className="mb-sheet-label">{t('speed')}</span>
        <Stepper
          valueLabel={`${rate.toFixed(1)}×`}
          canDecrement={rate > 0.51}
          canIncrement={rate < 2.99}
          decrementLabel="Decrease speed"
          incrementLabel="Increase speed"
          onDecrement={() => controller.setRate(rate - 0.1)}
          onIncrement={() => controller.setRate(rate + 0.1)}
        />
      </div>

      <div className="mb-voice-tabs" data-testid="tts-category-tabs">
        <Segmented<TtsCategoryTab>
          label={t('voice')}
          value={activeTab}
          options={categoryOptions}
          onChange={(nextTab) => setActiveTab(nextTab)}
        />
      </div>

      {showSlowWarning && (
        <div className="mb-slow-voice-line" role="status">
          <span>{t('slowVoiceWarning', { rtf: slowVoiceRtf.toFixed(1) })}</span>
          <button
            type="button"
            className="mb-link-btn"
            onClick={() => selectAndPersistVoice({ kind: 'system', voiceId: null })}
          >
            {t('useSystemVoice')}
          </button>
        </div>
      )}

      <PagedList
        items={tabItems}
        isEink={isEink}
        layer="sheet"
        estimatedItemHeight={56}
        fallbackPageSize={5}
        resetKey={`${activeTab}:${serverSubTab}:${showAllSystemVoices ? 1 : 0}:${showAllKokoroVoices ? 1 : 0}:${showCloneFields ? 1 : 0}:${langPrefix}`}
        prevLabel={t('prevPage')}
        nextLabel={t('nextPage')}
        ariaLabel={t('voiceAndSpeed')}
        onPageTurn={(swap) => {
          void refreshController.runTurn({
            isEink,
            cadence: settings.fullRefreshEvery,
            swap,
          });
        }}
        renderItems={(visible) => (
          <div className="mb-voice-tab-list" role="region" aria-label={t('voice')}>
            {visible.map((item) => (
              <div key={item.key} className="mb-voice-tab-item">
                {item.render()}
              </div>
            ))}
          </div>
        )}
      />
    </Sheet>
  );
}

export interface SleepTimerSheetProps {
  readonly open: boolean;
  readonly controller: ReadAloudController;
  readonly onCloseSheet: (coveredHalf: boolean) => void;
}

const SLEEP_OPTIONS: ReadonlyArray<{ key: string; config: SleepTimerConfig }> = [
  { key: 'off', config: { mode: 'off' } },
  { key: '15', config: { mode: 'minutes', minutes: 15 } },
  { key: '30', config: { mode: 'minutes', minutes: 30 } },
  { key: '45', config: { mode: 'minutes', minutes: 45 } },
  { key: '60', config: { mode: 'minutes', minutes: 60 } },
  { key: 'chapter', config: { mode: 'endOfSection' } },
];

export function SleepTimerSheet({
  open,
  controller,
  onCloseSheet,
}: SleepTimerSheetProps): ReactElement | null {
  const t = useT();
  const current = useReadAloudStore((s) => s.sleepTimer);

  return (
    <Sheet open={open} label={t('sleepTimer')} popoverOnDesktop={false} onClose={onCloseSheet}>
      <div role="listbox" aria-label={t('sleepTimer')}>
        {SLEEP_OPTIONS.map((opt) => {
          const active =
            opt.config.mode === current.mode &&
            (opt.config.mode !== 'minutes' || opt.config.minutes === current.minutes);
          const label =
            opt.config.mode === 'off'
              ? t('sleepOff')
              : opt.config.mode === 'endOfSection'
                ? t('sleepEndOfChapter')
                : t('sleepMinutes', { n: opt.config.minutes ?? 15 });
          return (
            <button
              key={opt.key}
              type="button"
              role="option"
              aria-selected={active}
              className="mb-list-row"
              onClick={() => {
                controller.setSleepTimer(opt.config);
                useRouteStore.getState().closeSheetWithRefresh();
              }}
            >
              <span>{label}</span>
              <span aria-hidden="true">{active ? '✓' : ''}</span>
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}
