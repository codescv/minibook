import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '@minibook/core';
import {
  computeKeyPolicyVolumePaging,
  createMockPlatformHost,
  createMockSpeechPlayer,
  formatKokoroVoiceLabel,
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

  it('keeps Settings strictly <= 13 honest rows and gates rows by host capabilities and E-Ink mode', async () => {
    // 1. Desktop Normal Mode: 10 rows (no volume keys, no E-Ink refresh/boldness)
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
      'on-device-neural-voice',
      'edge-voices',
      'local-gpu-server',
      'custom-server',
      'fallback-system',
      'storage',
      'version-licenses',
    ]);
    expect(desktopRows.length).toBeLessThanOrEqual(13);
    m1.unmount();
    c1.remove();

    // 2. Android E-Ink Mode: 12 rows (volume keys + full refresh + text boldness shown; keep-screen-on hidden)
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
      'on-device-neural-voice',
      'edge-voices',
      'local-gpu-server',
      'custom-server',
      'fallback-system',
      'storage',
      'version-licenses',
    ]);
    expect(einkRows.length).toBeLessThanOrEqual(13);

    // Distinct union of all settings rows across both modes is EXACTLY 13!
    const allDistinctRows = new Set([...desktopRows, ...einkRows]);
    expect(allDistinctRows.size).toBe(13);

    // E-Ink toggles use 2px-bordered On/Off group (`role="group"`), zero switch sliders
    expect(c2.querySelectorAll('[role="switch"]')).toHaveLength(0);
    expect(c2.querySelectorAll('.mb-eink-toggle-group').length).toBeGreaterThanOrEqual(3);

    m2.unmount();
    c2.remove();

    // 3. Capability gating: when host.speech.models is absent (onDeviceNeuralSpeech: false), on-device-neural-voice is hidden!
    const c3 = document.createElement('div');
    document.body.appendChild(c3);
    const noModelsHost = createMockPlatformHost({
      platform: 'desktop',
      capabilities: { onDeviceNeuralSpeech: false },
      initialSettings: { einkMode: 'off' },
    });
    const m3 = mountMiniBookApp(c3, noModelsHost, createMockSpeechPlayer());
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await waitFor(() => {
      expect(screen.getByTestId('settings-screen')).toBeInTheDocument();
    });
    expect(c3.querySelector('[data-setting-row="on-device-neural-voice"]')).toBeNull();
    m3.unmount();
    c3.remove();
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

      // Contents / Voice / Settings-Voice PagedList sheets in E-Ink -> true
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

      expect(
        computeKeyPolicyVolumePaging(einkSettings, androidHost, {
          screen: 'settings',
          activeSheet: 'settings-voice',
          imagePreviewUrl: null,
          goToPercentOpen: false,
          textInputFocused: false,
          appVisible: true,
        }),
      ).toBe(true);

      // Non-list Appearance & Custom-Server sheets -> false!
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
    } finally {
      unregisterSheet();
      unregisterScreen();
    }
  });

  it('formats Kokoro voice labels accurately across locales (§7.2 & §8.2)', () => {
    expect(formatKokoroVoiceLabel('zf_001', 'zh-CN')).toBe('Kokoro · 女声 01');
    expect(formatKokoroVoiceLabel('zf_001', 'en')).toBe('Kokoro · Female 01');
    expect(formatKokoroVoiceLabel('zm_100', 'zh-CN')).toBe('Kokoro · 男声 100');
    expect(formatKokoroVoiceLabel('zm_009', 'en')).toBe('Kokoro · Male 09');
    expect(formatKokoroVoiceLabel('af_maple', 'en')).toBe('Kokoro · Maple (US)');
    expect(formatKokoroVoiceLabel('af_sol', 'zh-CN')).toBe('Kokoro · Sol (US)');
    expect(formatKokoroVoiceLabel('bf_vale', 'en')).toBe('Kokoro · Vale (UK)');
  });

  it('renders On-device neural voice sheet states, 2-tap Delete confirmation, and E-Ink stepped progress throttling (§7.2 & §8.2)', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const host = createMockPlatformHost({
      platform: 'android',
      capabilities: { einkDetected: true, volumeKeyPaging: true },
      initialSettings: { einkMode: 'on' },
    });
    const mounted = mountMiniBookApp(container, host, createMockSpeechPlayer());

    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await waitFor(() => {
      expect(screen.getByTestId('settings-screen')).toBeInTheDocument();
    });

    // Open On-device neural voice sheet (starts in 'absent')
    fireEvent.click(container.querySelector('[data-setting-row="on-device-neural-voice"]')!);
    expect(await screen.findByTestId('kokoro-download-btn')).toBeInTheDocument();
    expect(screen.getByTestId('kokoro-status-text').textContent).toMatch(/124 MB · 5 voices/i);

    // E-Ink progress throttling: 100 progress events from 1% to 100% over 10 s -> <= 20 DOM text updates (>= 5% step AND >= 3s interval)
    vi.useFakeTimers();
    try {
      const total = 100_000_000;
      const seenStatusTexts: string[] = [];
      let lastText = '';

      for (let i = 1; i <= 100; i++) {
        vi.advanceTimersByTime(100); // 100ms per event -> 10s total
        act(() => {
          host.setModelStatus({
            state: 'downloading',
            bytesDone: i * 1_000_000,
            bytesTotal: total,
            source: 'hf-mirror.com',
          });
        });
        const curText = screen.getByTestId('kokoro-status-text').textContent ?? '';
        if (curText !== lastText) {
          seenStatusTexts.push(curText);
          lastText = curText;
        }
      }

      expect(seenStatusTexts.length).toBeGreaterThanOrEqual(2);
      expect(seenStatusTexts.length).toBeLessThanOrEqual(20);
      expect(seenStatusTexts[0]).toContain('[ 0% ]');
      expect(seenStatusTexts.some((s) => s.includes('[ 30% ]'))).toBe(true);

      // Transition to paused -> verifying -> error -> ready
      act(() => {
        host.setModelStatus({
          state: 'paused',
          bytesDone: 45_000_000,
          bytesTotal: total,
        });
      });
      expect(screen.getByTestId('kokoro-resume-btn')).toBeInTheDocument();

      act(() => {
        host.setModelStatus({ state: 'verifying' });
      });
      expect(screen.getByTestId('kokoro-status-text').textContent).toBe('Checking…');

      act(() => {
        host.setModelStatus({
          state: 'error',
          error: { code: 'speech-unavailable', message: 'sha256 integrity mismatch' },
        });
      });
      expect(screen.getByTestId('kokoro-status-text').textContent).toMatch(/Model file is damaged/i);
      expect(screen.getByTestId('kokoro-retry-btn').textContent).toBe('Try again');

      act(() => {
        host.setModelStatus({
          state: 'ready',
          bytesDone: total,
          installedBytes: total,
          installedVoices: ['zf_001', 'zm_010', 'af_maple', 'af_sol', 'bf_vale'],
          rtf: 0.25,
        });
      });
      expect(screen.getByTestId('kokoro-status-text').textContent).toMatch(/Ready · 95 MB/i);

      // 2-tap Delete confirmation: 1st tap shows 'Delete?'; after 4s without 2nd tap it resets to 'Delete'
      const delBtn = screen.getByTestId('kokoro-delete-btn');
      expect(delBtn.textContent).toBe('Delete');
      fireEvent.click(delBtn);
      expect(delBtn.textContent).toBe('Delete?');

      act(() => {
        vi.advanceTimersByTime(4100);
      });
      expect(delBtn.textContent).toBe('Delete');

      // 2nd tap within 4s deletes the model and returns state to 'absent'
      fireEvent.click(delBtn);
      expect(delBtn.textContent).toBe('Delete?');
      await act(async () => {
        fireEvent.click(delBtn);
      });
      expect(host.getModelStatus().state).toBe('absent');
    } finally {
      vi.useRealTimers();
    }

    mounted.unmount();
    container.remove();
  });

  it('supports VoiceSheet 1-tap Kokoro Get download and Local GPU server preset/test/save flow (§7.3 & §7.4)', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const host = createMockPlatformHost({
      platform: 'desktop',
      initialSettings: { einkMode: 'off' },
    });
    const speech = createMockSpeechPlayer();
    const mounted = mountMiniBookApp(container, host, speech);

    // 1. Configure Local GPU Server in Settings
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await waitFor(() => {
      expect(screen.getByTestId('settings-screen')).toBeInTheDocument();
    });
    fireEvent.click(container.querySelector('[data-setting-row="local-gpu-server"]')!);

    expect(await screen.findByTestId('qwen-mac-script-hint')).toHaveTextContent(
      /scripts\/mac-gpu-tts-server\.sh/i,
    );
    // Cycle preset stepper -> switches to 1.7B preset
    fireEvent.click(screen.getByRole('button', { name: 'Next preset' }));
    expect(screen.getByDisplayValue(/Qwen3-TTS-12Hz-1\.7B/i)).toBeInTheDocument();

    // Test connection button
    fireEvent.click(screen.getByTestId('qwen-test-btn'));
    expect(await screen.findByTestId('qwen-test-status')).toHaveTextContent(/OK ·/i);

    // Save Local GPU Server
    const urlInput = screen.getByLabelText('Server URL');
    fireEvent.change(urlInput, { target: { value: 'http://192.168.1.20:8000' } });
    fireEvent.click(screen.getByTestId('qwen-save-btn'));

    await waitFor(() => {
      expect(
        container.querySelector('[data-setting-row="local-gpu-server"]')?.textContent,
      ).toContain('Vivian');
    });

    // 2. Open Chinese book ('b_luxun') -> start Read Aloud -> open VoiceSheet
    act(() => {
      useRouteStore.getState().openBook('b_luxun');
    });
    await waitFor(() => {
      expect(container.querySelector('.mb-reader')).not.toBeNull();
    });
    act(() => {
      useRouteStore.getState().setChromeOpen(true);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Read aloud' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Voice and speed/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Voice and speed/i }));

    // Initially Kokoro is 'absent' -> shows 1-tap download row with 'Get' AND Local GPU 'Vivian'
    const dlRow = await screen.findByTestId('voice-sheet-kokoro-download');
    expect(dlRow.textContent).toMatch(/On-device neural voice/i);
    expect(screen.getByRole('option', { name: /Vivian/i })).toBeInTheDocument();

    // Tap 'Get' inside VoiceSheet -> downloads Kokoro and replaces download row with installed zh Kokoro voices!
    const getBtn = dlRow.querySelector('button')!;
    fireEvent.click(getBtn);
    await waitFor(() => {
      expect(screen.queryByTestId('voice-sheet-kokoro-download')).toBeNull();
      expect(screen.getByRole('option', { name: /Kokoro · Female 01/i })).toBeInTheDocument();
    });

    mounted.unmount();
    container.remove();
  });
});
