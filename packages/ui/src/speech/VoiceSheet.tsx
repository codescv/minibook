import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { SleepTimerConfig, Voice, VoiceRef } from '@minibook/core';
import { useRouteStore } from '../app/routes';
import { Sheet } from '../components/Sheet';
import { Stepper } from '../components/Stepper';
import { PagedList } from '../eink/PagedList';
import { useHostContext } from '../host/HostContext';
import { useT } from '../i18n';
import { useReadAloudStore, type ReadAloudController } from './ReadAloudController';

export interface VoiceSheetProps {
  readonly open: boolean;
  readonly controller: ReadAloudController;
  readonly onCloseSheet: (coveredHalf: boolean) => void;
}

interface DisplayVoiceEntry {
  readonly key: string;
  readonly name: string;
  readonly engineLabel: string;
  readonly voiceRef: VoiceRef;
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
 * Voice & Speed Sheet (`PRODUCT_DESIGN.md` §4.6 & `UI_SPEC.md` §4.6):
 * 1. Speed stepper `0.5×–3.0×` (`0.1` steps)
 * 2. Flat hairline-divided voice list for the book's language (grouped by engine)
 * 3. Single-line slow-voice RTF warning + 1-tap `Use system voice`
 * 4. `More voices…` link to Settings
 */
export function VoiceSheet({
  open,
  controller,
  onCloseSheet,
}: VoiceSheetProps): ReactElement | null {
  const t = useT();
  const { host, speechPlayer, settings, isEink } = useHostContext();
  const rate = useReadAloudStore((s) => s.rate);
  const selectedVoice = useReadAloudStore((s) => s.voice);
  const bookLang = useReadAloudStore((s) => s.bookLang);
  const slowVoiceRtf = useReadAloudStore((s) => s.slowVoiceRtf);

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

  const entries = useMemo<DisplayVoiceEntry[]>(() => {
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

    const list: DisplayVoiceEntry[] = [];
    if (sortedSys.length === 0) {
      list.push({
        key: 'sys:default',
        name: t('systemDefault'),
        engineLabel: t('systemDefault'),
        voiceRef: { kind: 'system', voiceId: null },
      });
    } else {
      for (const v of sortedSys) {
        list.push({
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

    if (settings.edgeVoicesEnabled) {
      for (const v of edgeVoices.filter(matchesBookLang)) {
        list.push({
          key: `edge:${v.id}`,
          name: v.name,
          engineLabel: 'Edge',
          voiceRef: { kind: 'edge', voiceId: v.id },
        });
      }
    }

    if (settings.customSpeechServer) {
      const srv = settings.customSpeechServer;
      list.push({
        key: `openai:${srv.voice}`,
        name: srv.voice || 'Custom Voice',
        engineLabel: 'Custom server',
        voiceRef: { kind: 'openai', voiceId: srv.voice, model: srv.model },
      });
    }

    return list;
  }, [systemVoices, edgeVoices, settings.edgeVoicesEnabled, settings.customSpeechServer, langPrefix, t]);

  const showSlowWarning =
    slowVoiceRtf !== null &&
    slowVoiceRtf >= 0.9 &&
    selectedVoice !== null &&
    selectedVoice.kind !== 'system';

  return (
    <Sheet open={open} label={t('voiceAndSpeed')} onClose={onCloseSheet}>
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
        fallbackPageSize={5}
        prevLabel={t('prevPage')}
        nextLabel={t('nextPage')}
        renderItems={(visible) => (
          <div role="listbox" aria-label={t('voice')}>
            {visible.map((item) => {
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
          onCloseSheet(false);
          useRouteStore.getState().openSettings();
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
                onCloseSheet(false);
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
