import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { ModelDownloadSource, PlatformHost, SpeechModelStatus } from '@minibook/core';
import { KOKORO_MODEL_ID } from '@minibook/core';
import type { I18nKey } from '../i18n/en';

export function resolveEffectiveModelSourceHost(
  statusSource: string | undefined,
  sourceSetting: ModelDownloadSource,
  mirrorBaseUrl: string | null,
): string | undefined {
  if (sourceSetting === 'huggingface') return 'huggingface.co';
  if (sourceSetting === 'hf-mirror') return 'hf-mirror.com';
  if (sourceSetting === 'custom' && mirrorBaseUrl) {
    try {
      return new URL(mirrorBaseUrl).host || mirrorBaseUrl;
    } catch {
      return mirrorBaseUrl;
    }
  }
  return statusSource;
}

interface SpeechModelStoreState {
  /** Always holds the latest unthrottled status for non-UI logic (e.g. ReadAloudController). */
  status: SpeechModelStatus | null;
  setStatus: (status: SpeechModelStatus | null) => void;
  refreshFromHost: (host: PlatformHost) => Promise<SpeechModelStatus | null>;
}

export function getSpeechModelsApi(host: PlatformHost) {
  return host.speech.models ?? host.models;
}

export const useSpeechModelStore = create<SpeechModelStoreState>((set) => ({
  status: null,
  setStatus: (status) => set({ status }),
  refreshFromHost: async (host) => {
    const models = getSpeechModelsApi(host);
    if (!models) {
      set({ status: null });
      return null;
    }
    try {
      const status = await models.status(KOKORO_MODEL_ID);
      set({ status });
      return status;
    } catch {
      return null;
    }
  },
}));

export function getModelBytesDone(status: SpeechModelStatus | null | undefined): number {
  if (!status) return 0;
  return status.bytesDone ?? (status as unknown as { bytesDownloaded?: number }).bytesDownloaded ?? 0;
}

export function computeModelProgressPct(status: SpeechModelStatus | null | undefined): number {
  if (!status || status.bytesTotal <= 0) return 0;
  const done = getModelBytesDone(status);
  return Math.max(0, Math.min(100, Math.round((done / status.bytesTotal) * 100)));
}

export function stepEinkPct(pct: number): number {
  const clamped = Math.max(0, Math.min(100, Math.floor(pct)));
  return Math.floor(clamped / 5) * 5;
}

export function formatSteppedEinkPct(pct: number): string {
  return `[ ${stepEinkPct(pct)}% ]`;
}

/**
 * Formats a Kokoro voice ID per `TTS_V2_SPEC.md` §7.2 & §8.2:
 * - `zf_001 .. zf_099` -> `Kokoro · 女声 01` (`zh-CN`) / `Kokoro · Female 01` (`en`) / `Kokoro · 女性 01` (`ja`)
 * - `zm_009 .. zm_100` -> `Kokoro · 男声 09 .. 100` / `Kokoro · Male 09 .. 100` / `Kokoro · 男性 09 .. 100`
 * - `af_maple` -> `Kokoro · Maple (US)`
 * - `af_sol` -> `Kokoro · Sol (US)`
 * - `bf_vale` -> `Kokoro · Vale (UK)`
 */
export function formatKokoroVoiceLabel(voiceId: string, uiLocale = 'en'): string {
  if (voiceId === 'af_maple') return 'Kokoro · Maple (US)';
  if (voiceId === 'af_sol') return 'Kokoro · Sol (US)';
  if (voiceId === 'bf_vale') return 'Kokoro · Vale (UK)';
  const m = voiceId.match(/^(zf|zm)_(\d+)$/);
  if (m) {
    const loc = uiLocale.toLowerCase();
    const isZh = loc.startsWith('zh');
    const isJa = loc.startsWith('ja');
    const gender =
      m[1] === 'zf'
        ? isZh
          ? '女声'
          : isJa
            ? '女性'
            : 'Female'
        : isZh
          ? '男声'
          : isJa
            ? '男性'
            : 'Male';
    const numStr = String(Number(m[2])).padStart(2, '0');
    return `Kokoro · ${gender} ${numStr}`;
  }
  return `Kokoro · ${voiceId}`;
}

export function formatModelBackendBadge(
  status: SpeechModelStatus | null | undefined,
  platform: string,
  onDeviceLabel = 'On-device',
): string {
  switch (status?.backend) {
    case 'webgpu':
      return 'WebGPU';
    case 'wasm':
      return 'WASM';
    case 'coreml-cpu':
      return 'Core ML';
    case 'ort-cpu':
      return onDeviceLabel;
    default:
      return platform === 'ios' ? 'Core ML' : onDeviceLabel;
  }
}

export function formatModelErrorInfo(
  status: SpeechModelStatus | null | undefined,
  t: (key: I18nKey, vars?: Record<string, string | number>) => string,
): { message: string; actionKind: 'retry' | 'try-again' | 'none' } {
  const errField = status?.error as unknown;
  const rawText =
    typeof errField === 'string'
      ? errField
      : errField && typeof errField === 'object'
        ? `${(errField as { code?: string; message?: string }).code ?? ''} ${(errField as { message?: string }).message ?? ''}`
        : '';
  const raw = rawText.toLowerCase();
  const mb = Math.max(1, Math.round((status?.bytesTotal || 121_000_000) / 1_000_000));
  if (raw.includes('enospc') || raw.includes('storage') || raw.includes('space') || raw.includes('quota')) {
    return { message: t('errStorage', { mb }), actionKind: 'retry' };
  }
  if (
    raw.includes('sha') ||
    raw.includes('hash') ||
    raw.includes('corrupt') ||
    raw.includes('damaged') ||
    raw.includes('integrity') ||
    raw.includes('self-test') ||
    raw.includes('verify')
  ) {
    return { message: t('errDamaged'), actionKind: 'try-again' };
  }
  if (raw.includes('unsupported') || raw.includes('not supported')) {
    return { message: t('errUnsupported'), actionKind: 'none' };
  }
  if (raw.includes('unstable') || raw.includes('crash') || raw.includes('sentinel')) {
    return { message: t('errUnstable'), actionKind: 'try-again' };
  }
  return { message: t('errNoConnection'), actionKind: 'retry' };
}

export class SpeechModelUiThrottle {
  private lastState: SpeechModelStatus['state'] | null = null;
  private lastDisplayedPct = -1;
  private lastRepaintAtMs = -Infinity;
  private lastVoicesKey = '';
  private lastSource = '';

  shouldRepaint(next: SpeechModelStatus, isEink: boolean, nowMs = Date.now()): {
    repaint: boolean;
    displayPct: number;
  } {
    const rawPct = computeModelProgressPct(next);
    const displayPct = isEink ? stepEinkPct(rawPct) : rawPct;
    const voicesKey = next.installedVoices.join(',');
    const sourceKey = next.source ?? '';

    if (
      this.lastState !== next.state ||
      this.lastVoicesKey !== voicesKey ||
      this.lastSource !== sourceKey ||
      next.state !== 'downloading'
    ) {
      this.lastState = next.state;
      this.lastDisplayedPct = displayPct;
      this.lastRepaintAtMs = nowMs;
      this.lastVoicesKey = voicesKey;
      this.lastSource = sourceKey;
      return { repaint: true, displayPct };
    }

    if (isEink) {
      const crossedStep = Math.abs(displayPct - this.lastDisplayedPct) >= 5;
      const elapsedEnough = nowMs - this.lastRepaintAtMs >= 3000;
      if (crossedStep && elapsedEnough) {
        this.lastDisplayedPct = displayPct;
        this.lastRepaintAtMs = nowMs;
        return { repaint: true, displayPct };
      }
      return { repaint: false, displayPct: Math.max(0, this.lastDisplayedPct) };
    }

    // Normal mode: at most 1 update / s during downloading (or on 100% completion).
    const changed = displayPct !== this.lastDisplayedPct;
    const elapsedEnough = nowMs - this.lastRepaintAtMs >= 1000 || displayPct === 100;
    if (changed && elapsedEnough) {
      this.lastDisplayedPct = displayPct;
      this.lastRepaintAtMs = nowMs;
      return { repaint: true, displayPct };
    }
    return { repaint: false, displayPct: Math.max(0, this.lastDisplayedPct) };
  }
}

export interface UseSpeechModelStatusResult {
  status: SpeechModelStatus | null;
  displayPct: number;
  refresh: () => Promise<SpeechModelStatus | null>;
}

/**
 * Subscribes to `kokoro-v1.1-zh` status and applies strict E-Ink / normal-mode
 * progress throttling so E-Ink panels never flash on intermediate percentages.
 */
export function useSpeechModelStatus(host: PlatformHost, isEink: boolean): UseSpeechModelStatusResult {
  const throttleRef = useRef<SpeechModelUiThrottle | null>(null);
  if (!throttleRef.current) {
    throttleRef.current = new SpeechModelUiThrottle();
  }

  const initialStatus = useSpeechModelStore.getState().status;
  const [uiState, setUiState] = useState<{ status: SpeechModelStatus | null; displayPct: number }>(() => {
    if (!initialStatus) return { status: null, displayPct: 0 };
    const { displayPct } = throttleRef.current!.shouldRepaint(initialStatus, isEink, Date.now());
    return { status: initialStatus, displayPct };
  });

  const isEinkRef = useRef(isEink);
  isEinkRef.current = isEink;

  useEffect(() => {
    const models = getSpeechModelsApi(host);
    if (!models) {
      useSpeechModelStore.getState().setStatus(null);
      setUiState({ status: null, displayPct: 0 });
      return;
    }

    let cancelled = false;
    const applyIncoming = (incoming: SpeechModelStatus) => {
      useSpeechModelStore.getState().setStatus(incoming);
      if (cancelled) return;
      const decision = throttleRef.current!.shouldRepaint(incoming, isEinkRef.current, Date.now());
      if (decision.repaint) {
        setUiState({ status: incoming, displayPct: decision.displayPct });
      }
    };

    void models.status(KOKORO_MODEL_ID).then((s) => {
      if (!cancelled && s) {
        applyIncoming(s);
      }
    }).catch(() => {});

    const unsub = host.subscribe((ev) => {
      const modelId = ev.type === 'speech-model' ? (ev.status.id ?? (ev.status as unknown as { modelId?: string }).modelId) : null;
      if (ev.type === 'speech-model' && modelId === KOKORO_MODEL_ID) {
        applyIncoming(ev.status);
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [host]);

  const refresh = async () => {
    const s = await useSpeechModelStore.getState().refreshFromHost(host);
    if (s) {
      const decision = throttleRef.current!.shouldRepaint(s, isEinkRef.current, Date.now());
      setUiState({ status: s, displayPct: decision.displayPct });
    }
    return s;
  };

  return {
    status: uiState.status,
    displayPct: uiState.displayPct,
    refresh,
  };
}
