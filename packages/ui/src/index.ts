import './theme/styles.css';
import { createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { PlatformHost, SpeechPlayer } from '@minibook/core';
import { App, type AppProps } from './app/App';
import { useRouteStore } from './app/routes';
import { useSettingsStore } from './host/HostContext';
import { useImportStore } from './library/ImportController';
import { useReadAloudStore } from './speech/ReadAloudController';
import { useSpeechModelStore } from './speech/speech-model-store';

export interface MountedMiniBookApp {
  unmount(): void;
}

export function mountMiniBookApp(
  container: HTMLElement,
  host: PlatformHost,
  speechPlayer: SpeechPlayer,
): MountedMiniBookApp {
  useRouteStore.getState().reset();
  useSettingsStore.getState().reset();
  useImportStore.getState().reset();
  useReadAloudStore.getState().reset();
  useSpeechModelStore.getState().setStatus(null);

  const root = createRoot(container);
  root.render(createElement(StrictMode, null, createElement(App, { host, speechPlayer })));

  return {
    unmount() {
      root.unmount();
      useRouteStore.getState().reset();
      useSettingsStore.getState().reset();
      useImportStore.getState().reset();
      useReadAloudStore.getState().reset();
      useSpeechModelStore.getState().setStatus(null);
    },
  };
}

export { App, type AppProps };
export {
  HostProvider,
  useHost,
  useHostContext,
  useSpeechPlayer,
  useSettingsStore,
} from './host/HostContext';
export {
  MockPlatformHost,
  createMockPlatformHost,
  MockSpeechPlayer,
  createMockSpeechPlayer,
  buildDefaultMockFixtures,
  buildSingleFileFiveChapterFixture,
  type MockPlatformHostOptions,
  type MockBookFixture,
  type MockSectionFixture,
} from './host/mock-host';
export {
  WebSpeechPlayer,
  createWebSpeechPlayer,
  type WebSpeechPlayerOptions,
} from './speech/WebSpeechPlayer';
export {
  ReadAloudController,
  useReadAloudStore,
  type ReadAloudStoreState,
} from './speech/ReadAloudController';
export {
  KokoroG2PClient,
  isKokoroCompatibleLang,
  type KokoroG2PClientOptions,
  type MinimalWorkerLike,
} from './speech/KokoroG2PClient';
export {
  KokoroWebEngine,
  type KokoroWebEngineOptions,
} from './speech/KokoroWebEngine';
export {
  KokoroSynthesisCore,
  sliceKokoroVoiceStyle,
  KOKORO_SELF_TEST_IDS,
  KOKORO_SELF_TEST_VOICE,
  type KokoroCoreEnv,
  type KokoroSynthesizePayload,
  type KokoroSynthesizeOutput,
  type OrtRuntimeLike,
  type OrtSessionLike,
  type OrtTensorLike,
} from './speech/kokoro.worker';
export {
  useSpeechModelStore,
  useSpeechModelStatus,
  SpeechModelUiThrottle,
  computeModelProgressPct,
  stepEinkPct,
  formatSteppedEinkPct,
  formatKokoroVoiceLabel,
  formatModelBackendBadge,
  formatModelErrorInfo,
  getSpeechModelsApi,
} from './speech/speech-model-store';
export { QWEN_PRESETS, type QwenPresetItem } from './settings/SettingsScreen';
export { AutoPageTurn, type AutoPageTurnViewAdapter } from './speech/AutoPageTurn';
export {
  computePaginationGeometry,
  Paginator,
  type PaginationGeometry,
  type PaginationGeometryInput,
} from './reader/Paginator';
export { TextMap, fnv1aHash, type TextMapEntry } from './reader/TextMap';
export { Highlighter, mergeLineRects, type MergedRect } from './reader/Highlighter';
export {
  SectionFrameManager,
  FRAME_CSP_CONTENT,
  resolveFrameSandboxAttribute,
  type FilledFrameUnit,
  type FrameGestureCallbacks,
} from './reader/SectionFrame';
export { ResourceUrlScope } from './reader/ResourceUrls';
export { buildFrameUserStylesheet, computeBookLineHeight } from './reader/user-stylesheet';
export { RefreshController, type RefreshControllerDeps } from './eink/RefreshController';
export { PagedList, type PagedListProps } from './eink/PagedList';
export { FlashOverlay } from './eink/FlashOverlay';
export { freezeAnimatedImages } from './eink/freeze-images';
export {
  useRouteStore,
  registerPageableHandler,
  computeTopmostLayerIsPageable,
  type ScreenName,
  type ActiveSheetKind,
  type ContentsTab,
} from './app/routes';
export {
  dispatchBackNavigation,
  registerBackInterceptor,
  useBackInterceptor,
  installGlobalBackHandler,
} from './app/back';
export {
  computeKeyPolicyVolumePaging,
  handleHardwareKey,
  handleGlobalKeyDown,
} from './app/keymap';
export {
  applyDocumentTheme,
  computeEffectiveEink,
  computeEffectiveVolumeKeyPaging,
  resolveActiveThemeColors,
} from './theme/theme-manager';
export { resolveLocale, translate, useT, type SupportedLocale, type I18nKey } from './i18n';
