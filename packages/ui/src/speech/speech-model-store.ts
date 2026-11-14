import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type {
  ModelDownloadSource,
  PlatformHost,
  SpeechModelStatus,
  Voice,
  VoiceRef,
} from '@minibook/core';
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

const KOKORO_CURATED_STYLE_LABELS: Readonly<
  Record<string, { readonly zh: string; readonly en: string; readonly ja: string }>
> = {
  zf_018: {
    zh: 'Kokoro · 女声 18（温柔叙事 ★）',
    en: 'Kokoro · Female 18 · Warm ★',
    ja: 'Kokoro · 女性 18（やさしい語り ★）',
  },
  zf_004: {
    zh: 'Kokoro · 女声 04（清亮播音 ★）',
    en: 'Kokoro · Female 04 · Clear ★',
    ja: 'Kokoro · 女性 04（クリア ★）',
  },
  zf_028: {
    zh: 'Kokoro · 女声 28（自然舒缓）',
    en: 'Kokoro · Female 28 · Soft',
    ja: 'Kokoro · 女性 28（穏やか）',
  },
  zf_001: {
    zh: 'Kokoro · 女声 01（标准）',
    en: 'Kokoro · Female 01',
    ja: 'Kokoro · 女性 01（標準）',
  },
  zm_010: {
    zh: 'Kokoro · 男声 10（沉稳有声书 ★）',
    en: 'Kokoro · Male 10 · Narrator ★',
    ja: 'Kokoro · 男性 10（ナレーター ★）',
  },
  zm_029: {
    zh: 'Kokoro · 男声 29（温和自然）',
    en: 'Kokoro · Male 29 · Warm',
    ja: 'Kokoro · 男性 29（温和）',
  },
};

/**
 * Formats a Kokoro voice ID per `TTS_V2_SPEC.md` §7.2 & §8.2, including descriptive
 * studio style labels for curated Mandarin voices:
 * - `zf_018` -> `Kokoro · 女声 18（温柔叙事 ★）` / `Kokoro · Female 18 · Warm ★`
 * - `zf_004` -> `Kokoro · 女声 04（清亮播音 ★）` / `Kokoro · Female 04 · Clear ★`
 * - `zf_028` -> `Kokoro · 女声 28（自然舒缓）` / `Kokoro · Female 28 · Soft`
 * - `zf_001` -> `Kokoro · 女声 01（标准）` / `Kokoro · Female 01`
 * - `zm_010` -> `Kokoro · 男声 10（沉稳有声书 ★）` / `Kokoro · Male 10 · Narrator ★`
 * - `zm_029` -> `Kokoro · 男声 29（温和自然）` / `Kokoro · Male 29 · Warm`
 * - `af_maple` -> `Kokoro · Maple (US)`
 * - `af_sol` -> `Kokoro · Sol (US)`
 * - `bf_vale` -> `Kokoro · Vale (UK)`
 */
export function formatKokoroVoiceLabel(voiceId: string, uiLocale = 'en'): string {
  if (voiceId === 'af_maple') return 'Kokoro · Maple (US)';
  if (voiceId === 'af_sol') return 'Kokoro · Sol (US)';
  if (voiceId === 'bf_vale') return 'Kokoro · Vale (UK)';
  const loc = uiLocale.toLowerCase();
  const isZh = loc.startsWith('zh');
  const isJa = loc.startsWith('ja');
  const curated = KOKORO_CURATED_STYLE_LABELS[voiceId];
  if (curated) {
    return isZh ? curated.zh : isJa ? curated.ja : curated.en;
  }
  const m = voiceId.match(/^(zf|zm)_(\d+)$/);
  if (m) {
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
  private lastVariant = '';

  shouldRepaint(next: SpeechModelStatus, isEink: boolean, nowMs = Date.now()): {
    repaint: boolean;
    displayPct: number;
  } {
    const rawPct = computeModelProgressPct(next);
    const displayPct = isEink ? stepEinkPct(rawPct) : rawPct;
    const voicesKey = next.installedVoices.join(',');
    const sourceKey = next.source ?? '';
    const variantKey = next.variant ?? '';

    if (
      this.lastState !== next.state ||
      this.lastVoicesKey !== voicesKey ||
      this.lastSource !== sourceKey ||
      this.lastVariant !== variantKey ||
      next.state !== 'downloading'
    ) {
      this.lastState = next.state;
      this.lastDisplayedPct = displayPct;
      this.lastRepaintAtMs = nowMs;
      this.lastVoicesKey = voicesKey;
      this.lastSource = sourceKey;
      this.lastVariant = variantKey;
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

// ---------------------------------------------------------------------------
// System TTS Natural-Voice Filtering, Deduplication & Localized Metadata (`v0.2.5`)
// ---------------------------------------------------------------------------

const SOUND_EFFECT_NOVELTY_NAMES = new Set([
  'albert',
  'bad news',
  'bahh',
  'bells',
  'boing',
  'bubbles',
  'cellos',
  'good news',
  'jester',
  'organ',
  'superstar',
  'trinoids',
  'whisper',
  'wobble',
  'zarvox',
]);

const LEGACY_SYNTHETIC_SPEAKER_NAMES = new Set([
  'eddy',
  'flo',
  'grandma',
  'grandpa',
  'reed',
  'rocko',
  'sandy',
  'shelley',
  'fred',
  'junior',
  'kathy',
  'ralph',
]);

export function isThirdPartyAndroidTtsEngine(engine: string | undefined): boolean {
  if (!engine) return false;
  const trimmed = engine.trim();
  if (!trimmed || trimmed === 'System') return false;
  const lower = trimmed.toLowerCase();
  if (lower === 'com.google.android.tts' || lower.startsWith('com.apple.')) {
    return false;
  }
  return true;
}

function cleanSpeakerBaseName(rawName: string): string {
  const withoutParen = rawName.replace(/\s*[\(（].*$/, '').trim();
  return withoutParen.toLowerCase();
}

function stripQualitySuffix(rawName: string): string {
  return rawName
    .trim()
    .replace(
      /(?:\s*[\(（](?:enhanced|premium|compact|default|增强型?|高音质|高品质|拡張|プレミアム)[\)）])+\s*$/i,
      '',
    )
    .trim();
}

/**
 * Rejects 1990s DECTalk/Eloquence (`Eddy`, `Flo`, `Grandma`, `Rocko`, etc.) and Apple
 * sound-effect novelty voices (`Zarvox`, `Boing`, `Trinoids`, `Fred`, etc.) across iOS and
 * macOS Web `speechSynthesis`, while preserving 100% of third-party Android TTS engines
 * (`MultiTTS`, `sherpa-onnx`, OEM engines) and Apple Personal Voices.
 */
export function isNaturalSystemVoiceEntry(v: {
  readonly id: string;
  readonly name: string;
  readonly engine?: string | undefined;
}): boolean {
  if (isThirdPartyAndroidTtsEngine(v.engine)) return true;
  const idLower = (v.id ?? '').trim().toLowerCase();
  if (!idLower) return false;
  if (idLower.includes('personalvoice')) return true;
  if (idLower.includes('.eloquence.') || idLower.includes('.speech.synthesis.voice.')) {
    return false;
  }

  const baseName = cleanSpeakerBaseName(v.name ?? '');
  if (baseName) {
    if (SOUND_EFFECT_NOVELTY_NAMES.has(baseName)) {
      return false;
    }
    const isModernAppleVoiceBundle =
      idLower.includes('.voice.compact.') ||
      idLower.includes('.voice.enhanced.') ||
      idLower.includes('.voice.premium.') ||
      idLower.includes('.voice.super-compact.');
    if (!isModernAppleVoiceBundle && LEGACY_SYNTHETIC_SPEAKER_NAMES.has(baseName)) {
      return false;
    }
  }
  return true;
}

/**
 * Normalizes bare or Android-specific BCP-47 tags (`"zh"`, `"cmn-Hans-CN"`, `"yue-Hant-HK"`, `"en"`)
 * into canonical regional tags (`"zh-CN"`, `"zh-TW"`, `"zh-HK"`, `"en-US"`, `"ja-JP"`, etc.).
 */
export function canonicalizeSystemVoiceLang(
  rawLang: string | null | undefined,
  fallbackLocale = 'en',
): string {
  const cleaned = (rawLang ?? '').trim().replace(/_/g, '-');
  const locClean = (fallbackLocale || 'en').trim().replace(/_/g, '-').toLowerCase();
  if (!cleaned) {
    return canonicalizeSystemVoiceLang(fallbackLocale || 'en-US', 'en-US');
  }
  const lower = cleaned.toLowerCase();
  if (lower === 'und' || lower === 'mul' || lower === 'zxx' || lower === 'unknown') {
    return 'und';
  }
  if (lower === 'zh') {
    if (locClean.startsWith('zh-tw') || locClean.startsWith('zh-hant')) return 'zh-TW';
    if (locClean.startsWith('zh-hk') || locClean.startsWith('yue')) return 'zh-HK';
    return 'zh-CN';
  }
  if (
    lower === 'zh-cn' ||
    lower === 'zh-hans' ||
    lower === 'zh-hans-cn' ||
    lower === 'zh-sg' ||
    lower === 'zh-hans-sg' ||
    lower === 'cmn' ||
    lower === 'cmn-cn' ||
    lower === 'cmn-hans' ||
    lower === 'cmn-hans-cn'
  ) {
    return 'zh-CN';
  }
  if (
    lower === 'zh-tw' ||
    lower === 'zh-hant' ||
    lower === 'zh-hant-tw' ||
    lower === 'cmn-tw' ||
    lower === 'cmn-hant' ||
    lower === 'cmn-hant-tw'
  ) {
    return 'zh-TW';
  }
  if (
    lower === 'zh-hk' ||
    lower === 'zh-hant-hk' ||
    lower === 'zh-mo' ||
    lower === 'zh-hant-mo' ||
    lower === 'yue' ||
    lower === 'zh-yue' ||
    lower === 'yue-hk' ||
    lower === 'yue-hant' ||
    lower === 'yue-hant-hk'
  ) {
    return 'zh-HK';
  }
  if (lower === 'en') {
    if (locClean.startsWith('en-') && locClean.length >= 5) {
      const region = locClean.split('-')[1] ?? 'us';
      return region.length === 2 ? `en-${region.toUpperCase()}` : 'en-US';
    }
    return 'en-US';
  }
  if (lower === 'ja') return 'ja-JP';
  if (lower === 'ko') return 'ko-KR';
  if (lower === 'fr') return 'fr-FR';
  if (lower === 'de') return 'de-DE';
  if (lower === 'es') return 'es-ES';
  if (lower === 'ru') return 'ru-RU';
  if (lower === 'pt') return 'pt-BR';
  if (lower === 'it') return 'it-IT';

  const parts = cleaned.split('-');
  const first = parts[0]!.toLowerCase();
  if (parts.length === 1) return first;
  return [
    first,
    ...parts.slice(1).map((sub) => {
      if (sub.length === 4 && /^[a-z]+$/i.test(sub)) {
        return sub[0]!.toUpperCase() + sub.slice(1).toLowerCase();
      }
      if (sub.length === 2 && /^[a-z]+$/i.test(sub)) {
        return sub.toUpperCase();
      }
      return sub.toLowerCase();
    }),
  ].join('-');
}

function voiceQualityScore(v: Voice): number {
  switch (v.quality) {
    case 'neural':
      return 4;
    case 'enhanced':
      return 3;
    case 'compact':
      return 2;
    case 'remote':
      return 1;
    default:
      return v.local ? 2 : 1;
  }
}

function matchesSelectedSystemVoice(v: Voice, selected: VoiceRef | null | undefined): boolean {
  if (!selected || selected.kind !== 'system' || !selected.voiceId) return false;
  if (v.id !== selected.voiceId) return false;
  if (selected.engine && v.engine && selected.engine !== v.engine) return false;
  return true;
}

function matchesSelectedSystemVoiceOrTierStem(
  v: Voice,
  selected: VoiceRef | null | undefined,
): boolean {
  if (matchesSelectedSystemVoice(v, selected)) return true;
  if (!selected || selected.kind !== 'system' || !selected.voiceId) return false;
  if (selected.engine && v.engine && selected.engine !== v.engine) return false;
  // Match upgraded Apple tier stems (e.g. `com.apple.voice.compact.zh-CN.Tingting` -> `com.apple.voice.enhanced.zh-CN.Tingting`)
  const appleStem = (id: string): string | null => {
    const m = id
      .trim()
      .toLowerCase()
      .match(/^com\.apple\.voice\.(?:compact|enhanced|premium|super-compact)\.(.+)$/);
    return m ? m[1]! : null;
  };
  const vStem = appleStem(v.id);
  const sStem = appleStem(selected.voiceId);
  return Boolean(vStem && sStem && vStem === sStem);
}

export function systemVoiceRowMatchesSelection(
  v: Voice,
  selected: VoiceRef | null | undefined,
): boolean {
  return matchesSelectedSystemVoiceOrTierStem(v, selected);
}
export interface FilteredSystemVoices {
  /** Clean primary-dialect voices (+ 3rd-party TTS engines & any active non-primary selection). */
  readonly primary: Voice[];
  /** Remaining clean voices (other regional dialects & languages) behind the expand toggle. */
  readonly secondary: Voice[];
  /** Complete deduplicated natural voice list (`[...primary, ...secondary]`). */
  readonly all: Voice[];
}

const GOOGLE_TTS_COLLAPSED_X_CAP = 6;

/**
 * Strips robotic Eloquence & sound-effect novelty voices, deduplicates multi-tier same-speaker
 * entries (`compact` / `enhanced` / `neural`) and Android Google TTS `-local` / `-network` pairs,
 * and splits voices into `primary` (exact target regional dialect, e.g. `zh-CN` ahead of `zh-TW`/`zh-HK`,
 * `en-US` ahead of `en-ZA`) vs `secondary` ("More system voices").
 */
export function filterAndRankSystemVoices(
  voices: readonly Voice[],
  targetBcp47: string,
  locale = 'en',
  selectedVoice: VoiceRef | null = null,
): FilteredSystemVoices {
  const targetNorm = canonicalizeSystemVoiceLang(targetBcp47 || locale || 'en-US', locale);
  const targetNormFinal = targetNorm === 'und' ? 'en-US' : targetNorm;
  const targetLower = targetNormFinal.toLowerCase();
  const targetPrefix = targetLower.split('-')[0] || 'en';

  // 1. Strip Eloquence & novelty voices + deduplicate quality tiers / Google TTS -local vs -network pairs.
  const byDedupKey = new Map<string, Voice>();
  for (const v of voices) {
    if (!isNaturalSystemVoiceEntry(v)) continue;

    const vCanonLang = canonicalizeSystemVoiceLang(v.lang, locale).toLowerCase();
    let dedupKey: string;
    if (isThirdPartyAndroidTtsEngine(v.engine)) {
      dedupKey = `3p:${v.engine}:${v.id}`;
    } else if ((v.engine ?? '').toLowerCase() === 'com.google.android.tts') {
      const stem = v.id.replace(/-(local|network)$/i, '').toLowerCase();
      dedupKey = `gtts:${vCanonLang}|${stem}`;
    } else if (v.id.toLowerCase().includes('personalvoice')) {
      dedupKey = `personal:${v.id}`;
    } else {
      const speaker = stripQualitySuffix(v.name).toLowerCase() || v.id.toLowerCase();
      dedupKey = `apple:${vCanonLang}|${speaker}`;
    }

    const existing = byDedupKey.get(dedupKey);
    if (!existing) {
      byDedupKey.set(dedupKey, v);
      continue;
    }

    // For Google TTS `-local` vs `-network`, allow an explicitly selected `-network` entry to stay;
    // for Apple multi-tier speakers (`compact` vs `enhanced`/`neural`), ALWAYS keep the highest quality tier.
    if (dedupKey.startsWith('gtts:')) {
      const candSelected = matchesSelectedSystemVoice(v, selectedVoice);
      const existSelected = matchesSelectedSystemVoice(existing, selectedVoice);
      if (candSelected !== existSelected) {
        if (candSelected) byDedupKey.set(dedupKey, v);
        continue;
      }
    }

    const candScore = voiceQualityScore(v);
    const existScore = voiceQualityScore(existing);
    if (candScore !== existScore) {
      if (candScore > existScore) byDedupKey.set(dedupKey, v);
      continue;
    }
    if (v.local !== existing.local) {
      if (v.local) byDedupKey.set(dedupKey, v);
      continue;
    }
    if (v.id.toLowerCase().includes('.voice.') && !existing.id.toLowerCase().includes('.voice.')) {
      byDedupKey.set(dedupKey, v);
    }
  }

  const deduped = [...byDedupKey.values()];
  if (deduped.length === 0) {
    return { primary: [], secondary: [], all: [] };
  }

  const canonLangOf = (v: Voice): string =>
    canonicalizeSystemVoiceLang(v.lang, locale).toLowerCase();
  const prefixOf = (v: Voice): string => {
    const cl = canonLangOf(v);
    return cl === 'und' ? '' : (cl.split('-')[0] ?? '');
  };

  const sortVoices = (list: Voice[]): Voice[] =>
    [...list].sort((a, b) => {
      const a3p = isThirdPartyAndroidTtsEngine(a.engine) ? 1 : 0;
      const b3p = isThirdPartyAndroidTtsEngine(b.engine) ? 1 : 0;
      if (a3p !== b3p) return b3p - a3p;

      const aLang = canonLangOf(a);
      const bLang = canonLangOf(b);
      const aExact = aLang === targetLower ? 1 : 0;
      const bExact = bLang === targetLower ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;

      const aPref = prefixOf(a) === targetPrefix ? 1 : 0;
      const bPref = prefixOf(b) === targetPrefix ? 1 : 0;
      if (aPref !== bPref) return bPref - aPref;

      const aQ = voiceQualityScore(a);
      const bQ = voiceQualityScore(b);
      if (aQ !== bQ) return bQ - aQ;

      if (a.local !== b.local) return a.local ? -1 : 1;

      if (aLang !== bLang) return aLang.localeCompare(bLang);
      return a.name.localeCompare(b.name);
    });

  const isExactPrimaryMatch = (v: Voice): boolean => {
    const cl = canonLangOf(v);
    if (cl === targetLower) return true;
    if (isThirdPartyAndroidTtsEngine(v.engine)) {
      const p = prefixOf(v);
      if (!p || p === targetPrefix) return true;
    }
    return false;
  };

  const isPrefixMatch = (v: Voice): boolean => {
    const p = prefixOf(v);
    return !p || p === targetPrefix;
  };

  const hasExactMatches = deduped.some(isExactPrimaryMatch);
  const hasPrefixMatches = hasExactMatches || deduped.some(isPrefixMatch);

  let rawPrimary: Voice[];
  let rawSecondary: Voice[];

  if (hasExactMatches) {
    rawPrimary = deduped.filter(
      (v) => isExactPrimaryMatch(v) || matchesSelectedSystemVoiceOrTierStem(v, selectedVoice),
    );
    const primarySet = new Set(rawPrimary);
    rawSecondary = deduped.filter((v) => !primarySet.has(v));
  } else if (hasPrefixMatches) {
    rawPrimary = deduped.filter(
      (v) => isPrefixMatch(v) || matchesSelectedSystemVoiceOrTierStem(v, selectedVoice),
    );
    const primarySet = new Set(rawPrimary);
    rawSecondary = deduped.filter((v) => !primarySet.has(v));
  } else {
    rawPrimary = [...deduped];
    rawSecondary = [];
  }

  const sortedPrimary = sortVoices(rawPrimary);
  const sortedSecondary = sortVoices(rawSecondary);

  // Cap excessive raw `com.google.android.tts` `x-*` variants in the collapsed view to 6,
  // while keeping 100% of third-party engines (`MultiTTS`, `sherpa-onnx`, OEM TTS) and active voice.
  const finalPrimary: Voice[] = [];
  const overflowGoogleVariants: Voice[] = [];
  let googleXCount = 0;
  for (const v of sortedPrimary) {
    const isGoogleXVariant =
      (v.engine ?? '').toLowerCase() === 'com.google.android.tts' &&
      /-x-/i.test(v.id) &&
      !matchesSelectedSystemVoice(v, selectedVoice);
    if (isGoogleXVariant) {
      googleXCount += 1;
      if (googleXCount > GOOGLE_TTS_COLLAPSED_X_CAP) {
        overflowGoogleVariants.push(v);
        continue;
      }
    }
    finalPrimary.push(v);
  }

  const finalSecondary =
    overflowGoogleVariants.length > 0
      ? [...overflowGoogleVariants, ...sortedSecondary]
      : sortedSecondary;

  return {
    primary: finalPrimary,
    secondary: finalSecondary,
    all: [...finalPrimary, ...finalSecondary],
  };
}

const DIALECT_LABELS: Readonly<
  Record<string, { readonly zh: string; readonly en: string; readonly ja: string }>
> = {
  'zh-cn': { zh: '普通话', en: 'Mandarin', ja: '中国語（普通話）' },
  'zh-tw': { zh: '台湾普通话', en: 'Taiwan Mandarin', ja: '中国語（台湾）' },
  'zh-hk': { zh: '粤语', en: 'Cantonese', ja: '広東語' },
  'en-us': { zh: '美式英语', en: 'US English', ja: '英語（米国）' },
  'en-gb': { zh: '英式英语', en: 'UK English', ja: '英語（英国）' },
  'en-au': { zh: '澳式英语', en: 'AU English', ja: '英語（豪州）' },
  'en-ie': { zh: '爱尔兰英语', en: 'IE English', ja: '英語（アイルランド）' },
  'en-in': { zh: '印度英语', en: 'IN English', ja: '英語（インド）' },
  'en-za': { zh: '南非英语', en: 'ZA English', ja: '英語（南アフリカ）' },
  'ja-jp': { zh: '日语', en: 'Japanese', ja: '日本語' },
  'ko-kr': { zh: '韩语', en: 'Korean', ja: '韓国語' },
  'fr-fr': { zh: '法语', en: 'French', ja: 'フランス語' },
  'fr-ca': { zh: '加拿大法语', en: 'CA French', ja: 'フランス語（カナダ）' },
  'de-de': { zh: '德语', en: 'German', ja: 'ドイツ語' },
  'es-es': { zh: '西班牙语', en: 'Spanish', ja: 'スペイン語' },
  'es-mx': { zh: '墨西哥西语', en: 'MX Spanish', ja: 'スペイン語（メキシコ）' },
  'ru-ru': { zh: '俄语', en: 'Russian', ja: 'ロシア語' },
  'pt-br': { zh: '巴西葡语', en: 'BR Portuguese', ja: 'ポルトガル語' },
  'it-it': { zh: '意大利语', en: 'Italian', ja: 'イタリア語' },
};

/**
 * Formats localized human metadata for a `System` voice row (`VoiceSheet`), e.g.:
 * - `zh`: `普通话 · 高音质`, `普通话 · 增强`, `普通话`, `台湾普通话`, `粤语`, `sherpa-onnx · 普通话 · 高音质`
 * - `en`: `Mandarin · Premium`, `US English · Enhanced`, `UK English`
 * - `ja`: `中国語（普通話） · 高音質`, `日本語 · 拡張`
 */
export function formatSystemVoiceMeta(v: Voice, locale = 'en'): string {
  const loc = (locale || 'en').toLowerCase();
  const langGroup: 'zh' | 'ja' | 'en' = loc.startsWith('zh')
    ? 'zh'
    : loc.startsWith('ja')
      ? 'ja'
      : 'en';

  const canon = canonicalizeSystemVoiceLang(v.lang, locale).toLowerCase();
  const dialectEntry = DIALECT_LABELS[canon];
  const rawLangClean = (v.lang || '').trim();
  const dialectLabel = dialectEntry
    ? dialectEntry[langGroup]
    : canon === 'und' || rawLangClean.toLowerCase() === 'und'
      ? ''
      : rawLangClean;

  let qualityBadge = '';
  if (v.quality === 'neural') {
    qualityBadge = langGroup === 'zh' ? '高音质' : langGroup === 'ja' ? '高音質' : 'Premium';
  } else if (v.quality === 'enhanced') {
    qualityBadge = langGroup === 'zh' ? '增强' : langGroup === 'ja' ? '拡張' : 'Enhanced';
  } else if (v.quality === 'remote' || !v.local) {
    qualityBadge = langGroup === 'zh' ? '在线' : langGroup === 'ja' ? 'オンライン' : 'Online';
  }

  let engineBadge = '';
  if (v.engine && v.engine !== 'System' && !v.engine.toLowerCase().startsWith('com.apple.')) {
    const engineLower = v.engine.toLowerCase();
    if (engineLower === 'com.google.android.tts') {
      if (!v.name.toLowerCase().startsWith('google')) {
        engineBadge = 'Google TTS';
      }
    } else if (!v.name.includes(' · ') && !v.engine.includes('.')) {
      // Friendly non-package engine labels (e.g. `sherpa-onnx`) when `v.name` doesn't already carry `Label · Voice`.
      if (!v.name.toLowerCase().startsWith(engineLower)) {
        engineBadge = v.engine;
      }
    }
  }

  const parts: string[] = [];
  if (engineBadge) parts.push(engineBadge);
  if (dialectLabel) parts.push(dialectLabel);
  if (qualityBadge) parts.push(qualityBadge);
  return parts.join(' · ');
}
