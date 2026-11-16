import {
  buildDefaultMockFixtures,
  buildSingleFileFiveChapterFixture,
  createMockPlatformHost,
  createMockSpeechPlayer,
  mountMiniBookApp,
  Paginator,
  TextMap,
  computePaginationGeometry,
  type MockPlatformHost,
  type MockSpeechPlayer,
} from './index';
import type { AppearanceMode, EinkModeSetting, HostPlatform, ReadingTheme, SpeechModelState } from '@minibook/core';

declare global {
  interface Window {
    __minibookTestHarness?: {
      readonly host: MockPlatformHost;
      readonly speech: MockSpeechPlayer;
      readonly TextMap: typeof TextMap;
      readonly Paginator: typeof Paginator;
      readonly computePaginationGeometry: typeof computePaginationGeometry;
    };
  }
}

const params = new URLSearchParams(window.location.search);
const einkParam = (params.get('eink') as EinkModeSetting | null) ?? 'auto';
const themeParam = (params.get('theme') as ReadingTheme | null) ?? 'original';
const appearanceRaw = params.get('appearance');
// `?appearance=light|dark|system` wins; legacy `?theme=<id>` alone pins Light (Quiet -> Dark).
const appearanceParam: AppearanceMode =
  appearanceRaw === 'light' || appearanceRaw === 'dark' || appearanceRaw === 'system'
    ? appearanceRaw
    : params.get('theme')
      ? themeParam === 'quiet'
        ? 'dark'
        : 'light'
      : 'system';
const platform = (params.get('platform') as HostPlatform | null) ?? 'desktop';
const extraBooks = Number(params.get('extraBooks') ?? '0') || 0;
const vendorRefresh = params.get('vendorRefresh') === '1';
const includeSingleFile5 = params.get('singleFile5') === '1';
const kokoroStateParam = params.get('kokoroState') as SpeechModelState | null;

const host = createMockPlatformHost({
  platform,
  ...(includeSingleFile5
    ? { books: [buildSingleFileFiveChapterFixture(), ...buildDefaultMockFixtures()] }
    : {}),
  ...(kokoroStateParam
    ? {
        initialModelStatus: {
          state: kokoroStateParam,
          ...(kokoroStateParam === 'downloading' || kokoroStateParam === 'paused'
            ? { bytesDone: Math.round(341_980_642 * 0.45), bytesTotal: 341_980_642 }
            : {}),
        },
      }
    : {}),
  capabilities: {
    einkDetected: einkParam === 'on',
    vendorRefresh,
    volumeKeyPaging: platform === 'android',
  },
  initialSettings: {
    einkMode: einkParam,
    theme: themeParam,
    appearanceMode: appearanceParam,
    matchSystemTheme: appearanceParam === 'system',
  },
  extraShelfBooks: extraBooks,
});

const speech = createMockSpeechPlayer();
window.__minibookTestHarness = {
  host,
  speech,
  TextMap,
  Paginator,
  computePaginationGeometry,
};

const rootEl = document.getElementById('root');
if (rootEl) {
  mountMiniBookApp(rootEl, host, speech);
}

const initialBook = params.get('book');
if (initialBook) {
  import('./app/routes').then(({ useRouteStore }) => {
    useRouteStore.getState().openBook(initialBook);
  });
}
