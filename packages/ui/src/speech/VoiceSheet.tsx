import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  KOKORO_MODEL_ID,
  kokoroVoiceLang,
  type SleepTimerConfig,
  type Voice,
  type VoiceRef,
} from '@minibook/core';
import { useRouteStore } from '../app/routes';
import { Sheet } from '../components/Sheet';
import { Stepper } from '../components/Stepper';
import { PagedList } from '../eink/PagedList';
import { useHostContext } from '../host/HostContext';
import { resolveLocale, useT } from '../i18n';
import { useReadAloudStore, type ReadAloudController } from './ReadAloudController';
import {
  formatKokoroVoiceLabel,
  formatModelErrorInfo,
  formatSteppedEinkPct,
  getSpeechModelsApi,
  useSpeechModelStatus,
} from './speech-model-store';

export interface VoiceSheetProps {
  readonly open: boolean;
  readonly controller: ReadAloudController;
  readonly onCloseSheet: (coveredHalf: boolean) => void;
}

type VoiceSheetItem =
  | {
      readonly kind: 'voice';
      readonly key: string;
      readonly name: string;
      readonly engineLabel: string;
      readonly voiceRef: VoiceRef;
    }
  | {
      readonly kind: 'kokoro-download';
      readonly key: string;
      readonly label: string;
      readonly actionLabel: string | null;
      readonly onAction: (() => void) | null;
    };

function voiceMatchesRef(entry: VoiceRef, active: VoiceRef | null): boolean {
  if (!active) return entry.kind === 'system' && entry.voiceId === null;
  if (entry.kind !== active.kind) return false;
  if (entry.kind === 'system' && active.kind === 'system') {
    return entry.voiceId === active.voiceId;
  }
  return entry.voiceId === active.voiceId;
}

/**
 * Voice & Speed Sheet (`PRODUCT_DESIGN.md` §4.6, `UI_SPEC.md` §4.6 & `TTS_V2_SPEC.md` §7.3):
 * 1. Speed stepper `0.5×–3.0×` (`0.1` steps)
 * 2. Flat hairline-divided voice list for the book's language (System -> Kokoro -> Edge -> Local GPU -> Custom server)
 *    plus 1-tap in-app Kokoro download row when Kokoro is not yet installed
 * 3. Single-line slow-voice RTF warning + 1-tap `Use system voice`
 * 4. `More voices…` link to Settings
 */
export function VoiceSheet({
  open,
  controller,
  onCloseSheet,
}: VoiceSheetProps): ReactElement | null {
  const t = useT();
  const locale = useMemo(() => resolveLocale(), []);
  const { host, speechPlayer, settings, isEink, refreshController } = useHostContext();
  const rate = useReadAloudStore((s) => s.rate);
  const selectedVoice = useReadAloudStore((s) => s.voice);
  const bookLang = useReadAloudStore((s) => s.bookLang);
  const slowVoiceRtf = useReadAloudStore((s) => s.slowVoiceRtf);

  const modelsApi = getSpeechModelsApi(host);
  const { status: modelStatus, displayPct } = useSpeechModelStatus(host, isEink);

  const [systemVoices, setSystemVoices] = useState<Voice[]>([]);
  const [edgeVoices, setEdgeVoices] = useState<Voice[]>([]);

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
  const supportsKokoroLang = langPrefix === 'zh' || langPrefix === 'en';

  const entries = useMemo<VoiceSheetItem[]>(() => {
    const matchesBookLang = (v: Voice): boolean => {
      const vl = (v.lang.split('-')[0] ?? '').toLowerCase();
      return !vl || vl === langPrefix;
    };

    const filteredSystem = systemVoices.filter(matchesBookLang);
    const sysSource = filteredSystem.length > 0 ? filteredSystem : systemVoices;

    // Sort system voices so third-party Android neural engines (sherpa-onnx, MultiTTS) appear cleanly grouped
    const sortedSys = [...sysSource].sort((a, b) =>
      (a.engine ?? 'System').localeCompare(b.engine ?? 'System'),
    );

    const list: VoiceSheetItem[] = [];
    if (sortedSys.length === 0) {
      list.push({
        kind: 'voice',
        key: 'sys:default',
        name: t('systemDefault'),
        engineLabel: t('systemDefault'),
        voiceRef: { kind: 'system', voiceId: null },
      });
    } else {
      for (const v of sortedSys) {
        list.push({
          kind: 'voice',
          key: `sys:${v.engine ?? 'System'}:${v.id}`,
          name: v.name,
          engineLabel: v.engine ?? t('systemDefault'),
          voiceRef: {
            kind: 'system',
            voiceId: v.id,
            ...(v.engine ? { engine: v.engine } : {}),
          },
        });
      }
    }

    // 2. Kokoro voices (when model is ready and book language is zh or en)
    if (modelsApi && supportsKokoroLang && modelStatus?.state === 'ready') {
      const kokoroEngineLabel =
        modelStatus.backend === 'webgpu'
          ? `${t('onDevice')} · WebGPU`
          : modelStatus.backend === 'wasm'
            ? `${t('onDevice')} · WASM`
            : t('onDevice');
      for (const voiceId of modelStatus.installedVoices) {
        const vLang = kokoroVoiceLang(voiceId).split('-')[0]?.toLowerCase() ?? 'en';
        if (vLang === langPrefix) {
          list.push({
            kind: 'voice',
            key: `kokoro:${voiceId}`,
            name: formatKokoroVoiceLabel(voiceId, locale),
            engineLabel: kokoroEngineLabel,
            voiceRef: { kind: 'kokoro', voiceId },
          });
        }
      }
    }

    // 3. Edge voices
    if (settings.edgeVoicesEnabled) {
      for (const v of edgeVoices.filter(matchesBookLang)) {
        list.push({
          kind: 'voice',
          key: `edge:${v.id}`,
          name: v.name,
          engineLabel: 'Edge',
          voiceRef: { kind: 'edge', voiceId: v.id },
        });
      }
    }

    // 4. Local GPU server (Qwen3-TTS / mlx-audio / vllm-omni)
    if (settings.qwenServer) {
      const qwen = settings.qwenServer;
      list.push({
        kind: 'voice',
        key: `qwen:${qwen.voice}`,
        name: qwen.voice || 'Vivian',
        engineLabel: t('localGpu'),
        voiceRef: { kind: 'qwen', voiceId: qwen.voice, model: qwen.model },
      });
    }

    // 5. Custom OpenAI-compatible server
    if (settings.customSpeechServer) {
      const srv = settings.customSpeechServer;
      list.push({
        kind: 'voice',
        key: `openai:${srv.voice}`,
        name: srv.voice || 'Custom Voice',
        engineLabel: 'Custom server',
        voiceRef: { kind: 'openai', voiceId: srv.voice, model: srv.model },
      });
    }

    // 1-tap Kokoro download row when Kokoro is not yet installed
    if (modelsApi && supportsKokoroLang && modelStatus?.state !== 'ready') {
      const state = modelStatus?.state ?? 'absent';
      const totalMb = Math.max(
        1,
        Math.round(((modelStatus?.bytesTotal ?? 129_967_797) / (1024 * 1024))),
      );

      if (state === 'absent') {
        list.push({
          kind: 'kokoro-download',
          key: 'kokoro-dl:absent',
          label: `${t('onDeviceNeuralVoice')} · ${t('downloadSizeMb', { mb: totalMb })}`,
          actionLabel: t('get'),
          onAction: () => {
            void modelsApi.download(
              KOKORO_MODEL_ID,
              {
                source: settings.modelDownloadSource,
                mirrorBaseUrl: settings.modelMirrorBaseUrl,
              } as never,
            );
          },
        });
      } else if (state === 'downloading') {
        list.push({
          kind: 'kokoro-download',
          key: `kokoro-dl:downloading:${displayPct}`,
          label: isEink
            ? `${t('onDeviceNeuralVoice')} · ${formatSteppedEinkPct(displayPct)}`
            : t('downloadingPct', { pct: displayPct }),
          actionLabel: t('pause'),
          onAction: () => {
            void modelsApi.pause(KOKORO_MODEL_ID);
          },
        });
      } else if (state === 'paused') {
        list.push({
          kind: 'kokoro-download',
          key: `kokoro-dl:paused:${displayPct}`,
          label: isEink
            ? `${t('onDeviceNeuralVoice')} · ${formatSteppedEinkPct(displayPct)}`
            : t('pausedPct', { pct: displayPct }),
          actionLabel: t('resume'),
          onAction: () => {
            void modelsApi.download(
              KOKORO_MODEL_ID,
              {
                source: settings.modelDownloadSource,
                mirrorBaseUrl: settings.modelMirrorBaseUrl,
              } as never,
            );
          },
        });
      } else if (state === 'verifying') {
        list.push({
          kind: 'kokoro-download',
          key: 'kokoro-dl:verifying',
          label: t('checking'),
          actionLabel: null,
          onAction: null,
        });
      } else if (state === 'error') {
        const errInfo = formatModelErrorInfo(modelStatus, t);
        list.push({
          kind: 'kokoro-download',
          key: 'kokoro-dl:error',
          label: errInfo.message,
          actionLabel: errInfo.actionKind === 'none' ? null : t('retry'),
          onAction:
            errInfo.actionKind === 'none'
              ? null
              : () => {
                  void modelsApi.download(
                    KOKORO_MODEL_ID,
                    {
                      source: settings.modelDownloadSource,
                      mirrorBaseUrl: settings.modelMirrorBaseUrl,
                    } as never,
                  );
                },
        });
      }
    }

    return list;
  }, [
    systemVoices,
    edgeVoices,
    settings.edgeVoicesEnabled,
    settings.qwenServer,
    settings.customSpeechServer,
    settings.modelDownloadSource,
    settings.modelMirrorBaseUrl,
    modelsApi,
    supportsKokoroLang,
    modelStatus,
    displayPct,
    isEink,
    langPrefix,
    locale,
    t,
  ]);

  const showSlowWarning =
    slowVoiceRtf !== null &&
    slowVoiceRtf >= 0.9 &&
    selectedVoice !== null &&
    selectedVoice.kind !== 'system';

  return (
    <Sheet open={open} label={t('voiceAndSpeed')} listSheet onClose={onCloseSheet}>
      <div className="mb-sheet-row">
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

      <div className="mb-voice-section-label">{t('voice')}</div>

      <PagedList
        items={entries}
        isEink={isEink}
        layer="sheet"
        estimatedItemHeight={48}
        fallbackPageSize={6}
        resetKey={langPrefix}
        prevLabel={t('prevPage')}
        nextLabel={t('nextPage')}
        onPageTurn={(swap) => {
          void refreshController.runTurn({
            isEink,
            cadence: settings.fullRefreshEvery,
            swap,
          });
        }}
        renderItems={(visible) => (
          <div role="listbox" aria-label={t('voice')}>
            {visible.map((item) => {
              if (item.kind === 'kokoro-download') {
                return (
                  <div
                    key={item.key}
                    className="mb-sheet-row"
                    data-testid="voice-sheet-kokoro-download"
                  >
                    <span className="mb-list-row-meta">{item.label}</span>
                    {item.actionLabel && item.onAction && (
                      <button
                        type="button"
                        className="mb-icon-btn"
                        onClick={item.onAction}
                      >
                        {item.actionLabel}
                      </button>
                    )}
                  </div>
                );
              }

              const selected = voiceMatchesRef(item.voiceRef, selectedVoice);
              return (
                <button
                  key={item.key}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className="mb-list-row"
                  onClick={() => controller.setVoice(item.voiceRef)}
                >
                  <span>
                    {item.name}{' '}
                    <span className="mb-list-row-meta">{item.engineLabel}</span>
                  </span>
                  <span aria-hidden="true">{selected ? '✓' : ''}</span>
                </button>
              );
            })}
          </div>
        )}
      />

      {showSlowWarning && (
        <div className="mb-slow-voice-line" role="status">
          <span>{t('slowVoiceWarning', { rtf: slowVoiceRtf.toFixed(1) })}</span>
          <button
            type="button"
            className="mb-link-btn"
            onClick={() => controller.setVoice({ kind: 'system', voiceId: null })}
          >
            {t('useSystemVoice')}
          </button>
        </div>
      )}

      <button
        type="button"
        className="mb-more-voices-btn"
        onClick={() => {
          useRouteStore.getState().closeSheetWithRefresh(undefined, () => {
            useRouteStore.getState().openSettings();
          });
        }}
      >
        {t('moreVoices')}
      </button>
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
    <Sheet open={open} label={t('sleepTimer')} onClose={onCloseSheet}>
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
