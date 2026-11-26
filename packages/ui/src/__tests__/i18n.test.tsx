import { createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, sanitizeAppSettings, type UiLanguage } from '@minibook/core';
import {
  AppErrorBoundary,
  createMockPlatformHost,
  createMockSpeechPlayer,
  mountMiniBookApp,
  resolveActiveLocale,
  resolveLocale,
  useRouteStore,
  useSettingsStore,
} from '../index';
import { en } from '../i18n/en';
import { zhCN } from '../i18n/zh-CN';
import { ja } from '../i18n/ja';
import { ImportController, useImportStore } from '../library/ImportController';

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

describe('MiniBook UI i18n unification', () => {
  afterEach(() => {
    useSettingsStore.getState().reset();
    useRouteStore.getState().reset();
    useImportStore.getState().reset();
    document.documentElement.lang = 'en';
  });

  it('defaults uiLanguage to system and sanitizes valid/invalid values', () => {
    expect(DEFAULT_APP_SETTINGS.uiLanguage).toBe('system');
    expect(sanitizeAppSettings(undefined).uiLanguage).toBe('system');
    expect(sanitizeAppSettings({}).uiLanguage).toBe('system');
    expect(sanitizeAppSettings({ uiLanguage: 'zh-CN' }).uiLanguage).toBe('zh-CN');
    expect(sanitizeAppSettings({ uiLanguage: 'en' }).uiLanguage).toBe('en');
    expect(sanitizeAppSettings({ uiLanguage: 'ja' }).uiLanguage).toBe('ja');
    expect(sanitizeAppSettings({ uiLanguage: 'system' }).uiLanguage).toBe('system');
    expect(sanitizeAppSettings({ uiLanguage: 'fr-FR' }).uiLanguage).toBe('system');
    const zhBase = sanitizeAppSettings({ uiLanguage: 'zh-CN' });
    expect(sanitizeAppSettings({ uiLanguage: 'invalid' }, zhBase).uiLanguage).toBe('zh-CN');
  });

  it('resolves zh*/ja*/other locales cleanly to zh-CN / ja / en', () => {
    expect(resolveLocale('zh-CN')).toBe('zh-CN');
    expect(resolveLocale('zh-Hans')).toBe('zh-CN');
    expect(resolveLocale('zh-TW')).toBe('zh-CN');
    expect(resolveLocale('ja')).toBe('ja');
    expect(resolveLocale('ja-JP')).toBe('ja');
    expect(resolveLocale('en')).toBe('en');
    expect(resolveLocale('en-GB')).toBe('en');
    expect(resolveLocale('fr-FR')).toBe('en');
    expect(resolveLocale('de-DE')).toBe('en');
    expect(resolveLocale('ko-KR')).toBe('en');
  });

  it('enforces 100% key parity across en/zh-CN/ja and zero CJK characters in en.ts', () => {
    const enKeys = Object.keys(en).sort();
    const zhKeys = Object.keys(zhCN).sort();
    const jaKeys = Object.keys(ja).sort();

    expect(zhKeys).toEqual(enKeys);
    expect(jaKeys).toEqual(enKeys);

    for (const key of enKeys) {
      const k = key as keyof typeof en;
      expect(en[k].trim().length, `en.${key} empty`).toBeGreaterThan(0);
      expect(zhCN[k].trim().length, `zhCN.${key} empty`).toBeGreaterThan(0);
      expect(ja[k].trim().length, `ja.${key} empty`).toBeGreaterThan(0);
      expect(CJK_RE.test(en[k]), `CJK leaked in en.${key}: ${en[k]}`).toBe(false);
    }

    expect(zhCN.kokoroTitle).toBe('Kokoro · 中文 + 英文');
    expect(zhCN.ttsTabServer).toBe('服务器');
    expect(zhCN.ttsGuideOnDeviceIos).toContain('「服务器」页');
    expect(ja.kokoroTitle).toBe('Kokoro · 中国語 + 英語');
    expect(ja.ttsTabServer).toBe('サーバー');
    expect(ja.ttsGuideOnDeviceIos).toContain('「サーバー」タブ');
    expect(ja.serverTabLanGpu).toBe('ローカル GPU');
    expect(en.kokoroTitle).toBe('Kokoro · Chinese + English');
  });

  it('reactively switches language across SettingsScreen, document.lang, and host.device.setUiLanguage', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const syncedLanguages: UiLanguage[] = [];
    const host = createMockPlatformHost({
      platform: 'android',
      initialSettings: { einkMode: 'off', uiLanguage: 'system' },
    });
    host.device.setUiLanguage = async (lang) => {
      syncedLanguages.push(lang);
    };
    const mounted = mountMiniBookApp(container, host, createMockSpeechPlayer());

    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await waitFor(() => {
      expect(screen.getByTestId('settings-screen')).toBeInTheDocument();
    });

    // Switch to 中文
    fireEvent.click(screen.getByRole('tab', { name: '中文' }));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('zh-Hans');
      expect(screen.getByRole('heading', { name: '设置' })).toBeInTheDocument();
    });
    expect(resolveActiveLocale()).toBe('zh-CN');
    expect((await host.settings.get()).uiLanguage).toBe('zh-CN');
    expect(syncedLanguages).toContain('zh-CN');

    // Switch to 日本語
    fireEvent.click(screen.getByRole('tab', { name: '日本語' }));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('ja');
      expect(screen.getByRole('heading', { name: '設定' })).toBeInTheDocument();
    });
    expect(resolveActiveLocale()).toBe('ja');
    expect((await host.settings.get()).uiLanguage).toBe('ja');
    expect(syncedLanguages).toContain('ja');

    // Switch to English
    fireEvent.click(screen.getByRole('tab', { name: 'English' }));
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('en');
      expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    });
    expect(resolveActiveLocale()).toBe('en');
    expect((await host.settings.get()).uiLanguage).toBe('en');
    expect(syncedLanguages).toContain('en');

    // Switch back to System Default
    fireEvent.click(screen.getByRole('tab', { name: 'System Default' }));
    await waitFor(() => {
      expect(syncedLanguages[syncedLanguages.length - 1]).toBe('system');
    });
    expect((await host.settings.get()).uiLanguage).toBe('system');

    mounted.unmount();
    container.remove();
  });

  it('localizes ErrorBoundary and ImportController using active uiLanguage setting', async () => {
    useSettingsStore.getState().setSettings({ ...DEFAULT_APP_SETTINGS, uiLanguage: 'ja' });

    const Crash = (): ReactElement => {
      throw new Error('boom');
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const origErr = console.error;
    console.error = () => {};
    try {
      await act(async () => {
        root.render(
          createElement(
            AppErrorBoundary,
            { onResetSettings: () => {} },
            createElement(Crash),
          ),
        );
      });
      expect(container.textContent).toContain(ja.appName);
      expect(container.textContent).toContain(ja.bootErrorDesc);
      expect(container.textContent).toContain(ja.reload);
      expect(container.textContent).toContain(ja.retryWithDefaults);
    } finally {
      console.error = origErr;
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }

    // ImportController uses active uiLanguage (`zh-CN`) for DRM error messaging
    useSettingsStore.getState().setSettings({ ...DEFAULT_APP_SETTINGS, uiLanguage: 'zh-CN' });
    const host = createMockPlatformHost();
    const controller = new ImportController(host);
    const drmBytes = new TextEncoder().encode('DRMBOOK-encrypted');
    await controller.importSources(
      [
        {
          name: 'locked-drm.epub',
          size: drmBytes.byteLength,
          bytes: {
            size: drmBytes.byteLength,
            async read() {
              return drmBytes;
            },
            async readAll() {
              return drmBytes;
            },
          },
        },
      ],
      false,
    );
    const errItem = useImportStore.getState().items[0];
    expect(errItem?.status).toBe('error');
    expect(errItem?.errorMessage).toBe(zhCN.errorDrm);
  });
});
