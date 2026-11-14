import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '@minibook/core';
import {
  computeKeyPolicyVolumePaging,
  createMockPlatformHost,
  createMockSpeechPlayer,
  formatKokoroVoiceLabel,
  mountMiniBookApp,
  normalizeAndDetectSectionLang,
  registerPageableHandler,
  resolveBookSansStack,
  resolveBookSerifStack,
  syncDocumentLang,
  useReadAloudStore,
  useRouteStore,
} from '../index';

describe('Screens, 11-Row Settings Capability Gating, Back Stack & KeyPolicy', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

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

    // Right-click opens Book info / Share or Download file / Mark as finished / Remove… sheet
    const tile = screen.getByRole('button', { name: /A Tale of Two Cities/i });
    fireEvent.contextMenu(tile);
    expect(await screen.findByRole('dialog', { name: /Book info/i })).toBeInTheDocument();
    expect(screen.getByTestId('book-info-share-btn')).toHaveTextContent(/Download file/i);
    expect(screen.getByText(/Mark as finished/i)).toBeInTheDocument();
    expect(screen.getByText(/Remove…/i)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('book-info-share-btn'));
    await waitFor(() => {
      expect(host.sharedBookIds).toEqual(['b_dickens']);
    });

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

  it('keeps Settings focused on READING and ABOUT only (zero TTS rows in Settings) and gates rows by host capabilities and E-Ink mode', async () => {
    // 1. Desktop Normal Mode: 4 rows (READING: eink-mode, keep-screen-on; ABOUT: storage, version-licenses)
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
      'storage',
      'version-licenses',
    ]);
    expect(c1.textContent).not.toContain('READ ALOUD');
    m1.unmount();
    c1.remove();

    // 2. Android E-Ink Mode: 6 rows (volume keys + full refresh + text boldness shown; keep-screen-on hidden; zero TTS rows)
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
      'storage',
      'version-licenses',
    ]);

    // Distinct union of all settings rows across both modes is 7 (READING 5 + ABOUT 2)
    const allDistinctRows = new Set([...desktopRows, ...einkRows]);
    expect(allDistinctRows.size).toBe(7);

    // E-Ink toggles use 2px-bordered On/Off group (`role="group"`), zero switch sliders
    expect(c2.querySelectorAll('[role="switch"]')).toHaveLength(0);
    expect(c2.querySelectorAll('.mb-eink-toggle-group').length).toBeGreaterThanOrEqual(1);

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
          screen: 'reader',
          activeSheet: 'voice',
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

  it('renders guided On-Device Kokoro tab inside Reader VoiceSheet, 2-tap Delete confirmation, and E-Ink stepped progress throttling (§7.2 & §8.2)', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const host = createMockPlatformHost({
      platform: 'android',
      capabilities: { einkDetected: true, volumeKeyPaging: true },
      initialSettings: { einkMode: 'on' },
    });
    const mounted = mountMiniBookApp(container, host, createMockSpeechPlayer());

    // Open Chinese book ('b_luxun') -> start Read Aloud -> tap Voice button in ReadAloudBar -> switch to On-Device tab
    act(() => {
      useRouteStore.getState().openBook('b_luxun');
    });
    await waitFor(() => {
      expect(container.querySelector('iframe.mb-reader-frame')).not.toBeNull();
    });
    act(() => {
      useRouteStore.getState().setChromeOpen(true);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Read aloud' }));
    const barVoiceBtn = await screen.findByTestId('tts-bar-voice-btn');
    fireEvent.click(barVoiceBtn);

    expect(await screen.findByTestId('tts-guide-system')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'On-Device' }));

    expect(await screen.findByTestId('tts-guide-on-device')).toBeInTheDocument();
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
      expect(screen.getByTestId('kokoro-progress-track')).toBeInTheDocument();

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

  it('[v0.2.3] supports guided 3-tab VoiceSheet (System / On-Device / Server: LAN GPU, OpenAI API, Edge Online) with descriptive placeholders and immediate Save & Use activation', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const host = createMockPlatformHost({
      platform: 'desktop',
      initialSettings: { einkMode: 'off' },
    });
    const speech = createMockSpeechPlayer();
    const mounted = mountMiniBookApp(container, host, speech);

    // Open Chinese book ('b_luxun') -> start Read Aloud -> open VoiceSheet via ReadAloudBar `Voice` button
    act(() => {
      useRouteStore.getState().openBook('b_luxun');
    });
    await waitFor(() => {
      expect(container.querySelector('iframe.mb-reader-frame')).not.toBeNull();
    });
    act(() => {
      useRouteStore.getState().setChromeOpen(true);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Read aloud' }));
    fireEvent.click(await screen.findByTestId('tts-bar-voice-btn'));

    // 1. On-Device tab: guide card + Download -> Kokoro voices appear and `Use` activates zf_001!
    fireEvent.click(screen.getByRole('tab', { name: 'On-Device' }));
    expect(screen.getByTestId('tts-guide-on-device')).toHaveTextContent(/Kokoro-82M/i);
    expect(screen.getByLabelText('Custom mirror').getAttribute('placeholder')).toMatch(
      /https:\/\/hf-mirror\.com/i,
    );
    fireEvent.click(screen.getByTestId('kokoro-download-btn'));
    await waitFor(() => {
      expect(screen.getByText(/Kokoro · Female 01/i)).toBeInTheDocument();
    });
    const useButtons = screen.getAllByRole('button', { name: 'Use' });
    fireEvent.click(useButtons[0]!);
    expect(useReadAloudStore.getState().voice).toEqual({ kind: 'kokoro', voiceId: 'zf_001' });

    // [P2-2] Fetching an extra voice (`state: 'downloading'` while `installedVoices` is non-empty) keeps voice rows mounted with zero jump!
    act(() => {
      host.setModelStatus({
        state: 'downloading',
        bytesDone: 50_000,
        bytesTotal: 100_000,
        installedBytes: 129_967_797,
        installedVoices: ['zf_001'],
        source: 'hf-mirror.com',
      });
    });
    expect(screen.getByText(/Kokoro · Female 01/i)).toBeInTheDocument();
    act(() => {
      host.setModelStatus({
        state: 'ready',
        bytesDone: 100_000,
        bytesTotal: 100_000,
        installedBytes: 129_967_797,
        installedVoices: ['zf_001', 'zm_010'],
      });
    });

    // 2. Server tab -> LAN GPU (Qwen/MLX): descriptive placeholders on every field + Test + Save & Use activates qwen immediately!
    fireEvent.click(screen.getByRole('tab', { name: 'Server' }));
    expect(screen.getByTestId('tts-guide-server')).toBeInTheDocument();
    expect(screen.getByTestId('qwen-mac-script-hint')).toHaveTextContent(
      /scripts\/mac-gpu-tts-server\.sh/i,
    );
    expect(screen.getByTestId('qwen-url-input').getAttribute('placeholder')).toMatch(
      /http:\/\/192\.168\.1\.10:8000/i,
    );
    expect(screen.getByTestId('qwen-model-input').getAttribute('placeholder')).toMatch(
      /Qwen3-TTS/i,
    );
    expect(screen.getByTestId('qwen-voice-input').getAttribute('placeholder')).toMatch(/Vivian/i);
    expect(screen.getByTestId('qwen-instruct-input').getAttribute('placeholder')).toMatch(
      /Optional:/i,
    );

    // Expand advanced voice clone fields -> verify descriptive placeholders on Ref Audio & Ref Text too!
    fireEvent.click(screen.getByTestId('qwen-clone-toggle'));
    expect(screen.getByTestId('qwen-ref-audio-input').getAttribute('placeholder')).toMatch(
      /cloning/i,
    );
    expect(screen.getByTestId('qwen-ref-text-input').getAttribute('placeholder')).toMatch(
      /transcript/i,
    );

    // Cycle preset stepper -> switches to 1.7B preset
    fireEvent.click(screen.getByRole('button', { name: 'Next preset' }));
    expect(screen.getByDisplayValue(/Qwen3-TTS-12Hz-1\.7B/i)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('qwen-test-btn'));
    expect(await screen.findByTestId('qwen-test-status')).toHaveTextContent(/OK ·/i);

    fireEvent.change(screen.getByTestId('qwen-url-input'), {
      target: { value: 'http://192.168.1.20:8000' },
    });
    fireEvent.click(screen.getByTestId('qwen-save-btn'));
    await waitFor(() => {
      expect(useReadAloudStore.getState().voice?.kind).toBe('qwen');
      expect(useReadAloudStore.getState().voice?.voiceId).toBe('Vivian');
    });

    // 3. Server tab -> OpenAI API sub-tab: descriptive placeholders + Save & Use activates openai immediately!
    fireEvent.click(screen.getByRole('tab', { name: 'OpenAI API' }));
    expect(screen.getByTestId('openai-url-input').getAttribute('placeholder')).toMatch(
      /https:\/\/api\.openai\.com/i,
    );
    expect(screen.getByTestId('openai-model-input').getAttribute('placeholder')).toMatch(/tts-1/i);
    expect(screen.getByTestId('openai-voice-input').getAttribute('placeholder')).toMatch(/alloy/i);
    expect(screen.getByTestId('openai-key-input').getAttribute('placeholder')).toMatch(/sk-/i);

    fireEvent.change(screen.getByTestId('openai-url-input'), {
      target: { value: 'http://127.0.0.1:9090' },
    });
    fireEvent.change(screen.getByTestId('openai-voice-input'), {
      target: { value: 'nova' },
    });
    fireEvent.click(screen.getByTestId('openai-save-btn'));
    await waitFor(() => {
      expect(useReadAloudStore.getState().voice).toEqual({
        kind: 'openai',
        voiceId: 'nova',
        model: 'tts-1',
      });
    });

    mounted.unmount();
    container.remove();
  });

  it('[v0.2.3] resolves language-aware CJK font stacks (PingFang SC before serif, zero Japanese Hiragino leak on zh) and auto-detects section lang', () => {
    const zhSerif = resolveBookSerifStack('zh-CN');
    expect(zhSerif.indexOf('"PingFang SC"')).toBeGreaterThan(0);
    expect(zhSerif.indexOf('"PingFang SC"')).toBeLessThan(zhSerif.lastIndexOf('serif'));
    expect(zhSerif).not.toContain('Hiragino Mincho');
    expect(zhSerif).not.toContain('Noto Serif CJK JP');

    const jaSerif = resolveBookSerifStack('ja-JP');
    expect(jaSerif.indexOf('"Hiragino Mincho ProN"')).toBeGreaterThan(0);
    expect(jaSerif.indexOf('"Hiragino Mincho ProN"')).toBeLessThan(
      jaSerif.indexOf('"PingFang SC"'),
    );

    const hantSerif = resolveBookSerifStack('zh-TW');
    expect(hantSerif.indexOf('"Songti TC"')).toBeGreaterThan(0);
    expect(hantSerif.indexOf('"PingFang TC"')).toBeLessThan(hantSerif.indexOf('"PingFang SC"'));

    const zhSans = resolveBookSansStack('zh-Hans');
    expect(zhSans.indexOf('"PingFang SC"')).toBeLessThan(zhSans.indexOf('system-ui'));

    expect(normalizeAndDetectSectionLang('zh-CN', '')).toBe('zh-Hans');
    expect(normalizeAndDetectSectionLang('zh-HK', '')).toBe('zh-Hant');
    expect(normalizeAndDetectSectionLang('ja-JP', '')).toBe('ja');
    expect(
      normalizeAndDetectSectionLang(null, '我们在这里说话，没有觉得奇怪，还会继续前进。'),
    ).toBe('zh-Hans');
    // Mis-tagged Calibre/Sigil `lang="en"` Chinese EPUB & Chinese text with occasional `の` override to `zh-Hans`
    expect(
      normalizeAndDetectSectionLang('en', '第一章 科学边界\n汪淼觉得自己最近遇到的事情有些奇怪。'),
    ).toBe('zh-Hans');
    expect(
      normalizeAndDetectSectionLang('en', '我们在这里说话の没有觉得奇怪，还会继续前进。'),
    ).toBe('zh-Hans');
    expect(normalizeAndDetectSectionLang('en', 'It was the best of times, it was the worst of times.')).toBe('en');
    expect(normalizeAndDetectSectionLang('und', '吾輩は猫である。名前はまだ無い。')).toBe('ja');
    expect(normalizeAndDetectSectionLang(null, 'It was the best of times.')).toBeNull();

    expect(syncDocumentLang('zh-CN')).toBe('zh-Hans');
    expect(document.documentElement.lang).toBe('zh-Hans');
    expect(syncDocumentLang('en')).toBe('en');
  });

  it('[v0.2.1] live-switches active Kokoro download from hf-mirror.com to huggingface.co when clicking Hugging Face and supports Sheet grabber pull-down-to-dismiss', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const host = createMockPlatformHost({
      platform: 'desktop',
      initialSettings: {
        einkMode: 'off',
        modelDownloadSource: 'hf-mirror',
        modelMirrorBaseUrl: 'https://custom-mirror.example.com',
      },
      initialModelStatus: {
        state: 'downloading',
        bytesDone: 25_000_000,
        bytesTotal: 100_000_000,
        source: 'hf-mirror.com',
      },
    });
    const speech = createMockSpeechPlayer();
    const mounted = mountMiniBookApp(container, host, speech);

    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await waitFor(() => {
      expect(screen.getByTestId('settings-screen')).toBeInTheDocument();
    });

    // Library layer remains mounted underneath with inert + aria-hidden in normal mode
    const libLayer = container.querySelector('.mb-screen-layer.mb-screen-library');
    expect(libLayer).not.toBeNull();
    expect(libLayer?.getAttribute('aria-hidden')).toBe('true');
    expect(libLayer?.hasAttribute('inert')).toBe('' === '' ? true : false);

    // Return to Reader -> open VoiceSheet -> On-Device tab -> initially shows 'via hf-mirror.com'
    act(() => {
      useRouteStore.getState().openBook('b_dickens');
    });
    await waitFor(() => {
      expect(container.querySelector('iframe.mb-reader-frame')).not.toBeNull();
    });
    act(() => {
      useRouteStore.getState().setChromeOpen(true);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Read aloud' }));
    fireEvent.click(await screen.findByTestId('tts-bar-voice-btn'));
    fireEvent.click(screen.getByRole('tab', { name: 'On-Device' }));
    expect(await screen.findByTestId('kokoro-status-text')).toHaveTextContent(/via hf-mirror\.com/i);

    // Click 'Hugging Face' in 'Download from' Segmented control -> clears custom mirror URL and live-switches active download to huggingface.co!
    const hfTab = screen.getByRole('tab', { name: 'Hugging Face' });
    await act(async () => {
      fireEvent.click(hfTab);
    });

    await waitFor(() => {
      expect(screen.getByTestId('kokoro-status-text')).toHaveTextContent(/via huggingface\.co/i);
    });
    expect((await host.settings.get()).modelDownloadSource).toBe('huggingface');
    expect((await host.settings.get()).modelMirrorBaseUrl).toBeNull();

    // Test Sheet grabber pull-down-to-dismiss: < 56px springs back, >= 56px closes sheet
    const grabber = container.querySelector('.mb-sheet-grabber')!;
    expect(grabber).not.toBeNull();
    fireEvent.touchStart(grabber, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(grabber, { touches: [{ clientY: 130 }] });
    fireEvent.touchEnd(grabber);
    expect(screen.getByRole('dialog', { name: /Voice and speed/i })).toBeInTheDocument();

    fireEvent.touchStart(grabber, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(grabber, { touches: [{ clientY: 180 }] });
    fireEvent.touchEnd(grabber);
    expect(screen.queryByRole('dialog', { name: /Voice and speed/i })).toBeNull();

    mounted.unmount();
    container.remove();
  });

  it('[v0.2.2] guards worker modules on window, sanitizes legacy/malformed settings & books, and renders AppErrorBoundary recovery card instead of white screen', async () => {
    window.onmessage = null;
    await import('../speech/kokoro.worker');
    await import('../speech/kokoro-g2p.worker');
    expect(window.onmessage).toBeNull();

    const { sanitizeAppSettings } = await import('@minibook/core');
    const sanitized = sanitizeAppSettings({
      theme: 'sepia-legacy',
      fontScale: 9999,
      speechRate: -5,
      preferredVoices: { default: null, zh: { kind: 'kokoro', voiceId: 'zf_001' }, bad: { foo: 1 } },
      qwenServer: 'not-an-object',
      customSpeechServer: { baseUrl: 'http://127.0.0.1:9000' },
    });
    expect(sanitized.theme).toBe('original');
    expect(sanitized.fontScale).toBe(200);
    expect(sanitized.speechRate).toBe(1.0);
    expect(sanitized.preferredVoices).toEqual({ zh: { kind: 'kokoro', voiceId: 'zf_001' } });
    expect(sanitized.qwenServer).toBeNull();
    expect(sanitized.customSpeechServer).toEqual({
      baseUrl: 'http://127.0.0.1:9000',
      model: 'tts-1',
      voice: 'alloy',
    });

    // Mount App with malformed legacy settings + book missing authors array
    const container = document.createElement('div');
    document.body.appendChild(container);
    const host = createMockPlatformHost({
      platform: 'ios',
      initialSettings: {
        preferredVoices: null as unknown as Record<string, never>,
      },
    });
    const origList = host.library.list.bind(host.library);
    host.library.list = async () => {
      const base = await origList();
      return [
        {
          ...base[0]!,
          authors: undefined as unknown as readonly string[],
          fraction: Number.NaN,
        },
      ];
    };
    const speech = createMockSpeechPlayer();
    const mounted = mountMiniBookApp(container, host, speech);
    expect(await screen.findByRole('heading', { name: 'Library' })).toBeInTheDocument();
    expect((window as unknown as { __minibookMounted?: boolean }).__minibookMounted).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByTestId('settings-screen')).toBeInTheDocument();
    mounted.unmount();

    // Verify AppErrorBoundary catches render crash and displays visible recovery card
    const { createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { AppErrorBoundary } = await import('../app/ErrorBoundary');
    let shouldThrow = true;
    function Boom() {
      if (shouldThrow) {
        throw new Error('Synthetic render explosion');
      }
      return createElement('div', { 'data-testid': 'recovered-view' }, 'Recovered');
    }
    (window as unknown as { __minibookBootErrors?: string[] }).__minibookBootErrors = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const errRoot = createRoot(container);
    await act(async () => {
      errRoot.render(
        createElement(
          AppErrorBoundary,
          {
            onResetSettings: () => {
              shouldThrow = false;
            },
          },
          createElement(Boom),
        ),
      );
    });
    expect(screen.getByTestId('boot-error-card')).toBeInTheDocument();
    expect(screen.getByText(/Synthetic render explosion/)).toBeInTheDocument();
    expect(
      (window as unknown as { __minibookBootErrors?: string[] }).__minibookBootErrors,
    ).toContain('react:Synthetic render explosion');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry with defaults/i }));
    });
    expect(screen.getByTestId('recovered-view')).toBeInTheDocument();
    errRoot.unmount();
    errSpy.mockRestore();
    container.remove();
  });
});
