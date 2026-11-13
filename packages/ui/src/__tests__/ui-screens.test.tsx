import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '@minibook/core';
import {
  computeKeyPolicyVolumePaging,
  createMockPlatformHost,
  createMockSpeechPlayer,
  mountMiniBookApp,
  registerPageableHandler,
  useRouteStore,
} from '../index';

describe('Screens, 11-Row Settings Capability Gating, Back Stack & KeyPolicy', () => {
  it('mounts Library cover tiles, hides search when <= 1 screen, and shows search on large shelves', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const host = createMockPlatformHost();
    const speech = createMockSpeechPlayer();
    const mounted = mountMiniBookApp(container, host, speech);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /A Tale of Two Cities/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.getByText('62%')).toBeInTheDocument();
    expect(screen.getByText('Finished ✓')).toBeInTheDocument();

    // Right-click opens Book info / Mark as finished / Remove… sheet
    const tile = screen.getByRole('button', { name: /A Tale of Two Cities/i });
    fireEvent.contextMenu(tile);
    expect(await screen.findByRole('dialog', { name: /Book info/i })).toBeInTheDocument();
    expect(screen.getByText(/Mark as finished/i)).toBeInTheDocument();
    expect(screen.getByText(/Remove…/i)).toBeInTheDocument();

    mounted.unmount();
    container.remove();

    // Large shelf (> 1 screen) reveals search box; in E-Ink mode PagedList paginates with Next ›
    const container2 = document.createElement('div');
    document.body.appendChild(container2);
    const largeHost = createMockPlatformHost({
      extraShelfBooks: 18,
      initialSettings: { einkMode: 'on' },
    });
    const mounted2 = mountMiniBookApp(container2, largeHost, speech);
    expect(await screen.findByRole('searchbox')).toBeInTheDocument();
    expect(screen.getByText(/1 \//)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next ›' }));
    expect(await screen.findByText(/2 \//)).toBeInTheDocument();
    mounted2.unmount();
    container2.remove();
  });

  it('keeps Settings strictly <= 11 honest rows and gates rows by host capabilities and E-Ink mode', async () => {
    // 1. Desktop Normal Mode: 8 rows (no volume keys, no E-Ink refresh/boldness)
    const c1 = document.createElement('div');
    document.body.appendChild(c1);
    const desktopHost = createMockPlatformHost({
      platform: 'desktop',
      initialSettings: { einkMode: 'off' },
    });
    const m1 = mountMiniBookApp(c1, desktopHost, createMockSpeechPlayer());

    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await waitFor(() => {
      expect(screen.getByTestId('settings-screen')).toBeInTheDocument();
    });

    const desktopRows = [...c1.querySelectorAll('[data-setting-row]')].map((el) =>
      el.getAttribute('data-setting-row'),
    );
    expect(desktopRows).toEqual([
      'eink-mode',
      'keep-screen-on',
      'voice',
      'edge-voices',
      'custom-server',
      'fallback-system',
      'storage',
      'version-licenses',
    ]);
    expect(desktopRows.length).toBeLessThanOrEqual(11);
    m1.unmount();
    c1.remove();

    // 2. Android E-Ink Mode: 10 rows (volume keys + full refresh + text boldness shown; keep-screen-on hidden)
    const c2 = document.createElement('div');
    document.body.appendChild(c2);
    const androidEinkHost = createMockPlatformHost({
      platform: 'android',
      capabilities: { einkDetected: true, volumeKeyPaging: true },
      initialSettings: { einkMode: 'on' },
    });
    const m2 = mountMiniBookApp(c2, androidEinkHost, createMockSpeechPlayer());

    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await waitFor(() => {
      expect(screen.getByTestId('settings-screen')).toBeInTheDocument();
    });

    const einkRows = [...c2.querySelectorAll('[data-setting-row]')].map((el) =>
      el.getAttribute('data-setting-row'),
    );
    expect(einkRows).toEqual([
      'eink-mode',
      'volume-keys',
      'full-refresh',
      'text-boldness',
      'voice',
      'edge-voices',
      'custom-server',
      'fallback-system',
      'storage',
      'version-licenses',
    ]);
    expect(einkRows.length).toBeLessThanOrEqual(11);

    // Distinct union of all settings rows across both modes is EXACTLY 11!
    const allDistinctRows = new Set([...desktopRows, ...einkRows]);
    expect(allDistinctRows.size).toBe(11);

    // E-Ink toggles use 2px-bordered On/Off group (`role="group"`), zero switch sliders
    expect(c2.querySelectorAll('[role="switch"]')).toHaveLength(0);
    expect(c2.querySelectorAll('.mb-eink-toggle-group').length).toBeGreaterThanOrEqual(3);

    m2.unmount();
    c2.remove();
  });

  it('unwinds LIFO back stack via window.__minibookHandleBack accurately', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const host = createMockPlatformHost();
    const mounted = mountMiniBookApp(container, host, createMockSpeechPlayer());

    await waitFor(() => {
      expect(window.__minibookHandleBack).toBeTypeOf('function');
    });

    // At root Library with no sheet -> returns false
    expect(window.__minibookHandleBack!()).toBe(false);

    act(() => {
      useRouteStore.getState().openBook('b_dickens');
      useRouteStore.getState().setChromeOpen(true);
      useRouteStore.getState().openSheet('appearance');
    });

    // 1st back closes Appearance sheet
    expect(window.__minibookHandleBack!()).toBe(true);
    expect(useRouteStore.getState().activeSheet).toBeNull();
    expect(useRouteStore.getState().chromeOpen).toBe(true);

    // 2nd back hides Reader chrome
    expect(window.__minibookHandleBack!()).toBe(true);
    expect(useRouteStore.getState().chromeOpen).toBe(false);
    expect(useRouteStore.getState().screen).toBe('reader');

    // 3rd back returns to Library
    expect(window.__minibookHandleBack!()).toBe(true);
    expect(useRouteStore.getState().screen).toBe('library');

    // 4th back at root returns false
    expect(window.__minibookHandleBack!()).toBe(false);

    mounted.unmount();
    container.remove();
  });

  it('computes keyPolicy.volumePaging accurately across layer stack, focus, and visibility (§9.5)', () => {
    const androidHost = createMockPlatformHost({
      platform: 'android',
      capabilities: { volumeKeyPaging: true, einkDetected: true },
    });
    const einkSettings = { ...DEFAULT_APP_SETTINGS, einkMode: 'on' as const, volumeKeyPaging: null };

    const unregisterScreen = registerPageableHandler({
      id: 'test-screen',
      layer: 'screen',
      nextPage: () => {},
      prevPage: () => {},
    });
    const unregisterSheet = registerPageableHandler({
      id: 'test-sheet',
      layer: 'sheet',
      nextPage: () => {},
      prevPage: () => {},
    });

    try {
      // Bare reader -> true
      expect(
        computeKeyPolicyVolumePaging(einkSettings, androidHost, {
          screen: 'reader',
          activeSheet: null,
          imagePreviewUrl: null,
          goToPercentOpen: false,
          textInputFocused: false,
          appVisible: true,
        }),
      ).toBe(true);

      // Contents PagedList sheet in E-Ink -> true
      expect(
        computeKeyPolicyVolumePaging(einkSettings, androidHost, {
          screen: 'reader',
          activeSheet: 'contents',
          imagePreviewUrl: null,
          goToPercentOpen: false,
          textInputFocused: false,
          appVisible: true,
        }),
      ).toBe(true);

      // Non-list Appearance sheet -> false!
      expect(
        computeKeyPolicyVolumePaging(einkSettings, androidHost, {
          screen: 'reader',
          activeSheet: 'appearance',
          imagePreviewUrl: null,
          goToPercentOpen: false,
          textInputFocused: false,
          appVisible: true,
        }),
      ).toBe(false);

      // Focused Search / Go-to-% input -> false!
      expect(
        computeKeyPolicyVolumePaging(einkSettings, androidHost, {
          screen: 'reader',
          activeSheet: 'contents',
          imagePreviewUrl: null,
          goToPercentOpen: false,
          textInputFocused: true,
          appVisible: true,
        }),
      ).toBe(false);

      // Hidden app -> false!
      expect(
        computeKeyPolicyVolumePaging(einkSettings, androidHost, {
          screen: 'reader',
          activeSheet: null,
          imagePreviewUrl: null,
          goToPercentOpen: false,
          textInputFocused: false,
          appVisible: false,
        }),
      ).toBe(false);
    } finally {
      unregisterSheet();
      unregisterScreen();
    }
  });
});
