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
import type { EinkModeSetting, HostPlatform, ReadingTheme } from '@minibook/core';

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
const matchSystem = params.get('theme') ? false : true;
const platform = (params.get('platform') as HostPlatform | null) ?? 'desktop';
const extraBooks = Number(params.get('extraBooks') ?? '0') || 0;
const vendorRefresh = params.get('vendorRefresh') === '1';
const includeSingleFile5 = params.get('singleFile5') === '1';

const host = createMockPlatformHost({
  platform,
  ...(includeSingleFile5
    ? { books: [buildSingleFileFiveChapterFixture(), ...buildDefaultMockFixtures()] }
    : {}),
  capabilities: {
    einkDetected: einkParam === 'on',
    vendorRefresh,
    volumeKeyPaging: platform === 'android',
  },
  initialSettings: {
    einkMode: einkParam,
    theme: themeParam,
    matchSystemTheme: matchSystem,
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
