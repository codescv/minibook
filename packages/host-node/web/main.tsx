import type {
  AttachedAudio,
  SleepTimerConfig,
  SpeechEvent,
  SpeechPlayer,
  SpeechSession,
  SpeechState,
  Unsubscribe,
  Utterance,
  Voice,
  VoiceRef,
} from '@minibook/core';
import * as UiModule from '@minibook/ui';
import { createRestPlatformHost } from '../src/client/rest-host.js';

/**
 * Fallback browser SpeechPlayer used only if `@minibook/ui` does not export `WebSpeechPlayer`
 * (e.g. during isolated `feat/hosts` builds before `feat/ui` merges).
 */
class FallbackBrowserSpeechPlayer implements SpeechPlayer {
  readonly capabilities = { nativeQueue: false, wordEvents: true } as const;
  private state: SpeechState = {
    status: 'idle',
    bookId: null,
    currentUtteranceId: null,
    section: null,
    offset: null,
    rate: 1.0,
    voice: null,
    usingFallback: false,
    sleepTimer: { mode: 'off' },
  };
  private readonly listeners = new Set<(event: SpeechEvent) => void>();

  async listVoices(): Promise<Voice[]> {
    if (typeof speechSynthesis === 'undefined') return [];
    return speechSynthesis.getVoices().map((v) => ({
      id: v.voiceURI,
      provider: 'system',
      name: v.name,
      lang: v.lang,
      quality: v.localService ? 'enhanced' : 'remote',
      local: v.localService,
    }));
  }

  async load(session: SpeechSession): Promise<void> {
    this.state = {
      ...this.state,
      status: 'paused',
      bookId: session.bookId,
      rate: session.rate,
      voice: session.voice,
    };
  }

  enqueue(_items: readonly Utterance[], _opts?: { readonly replaceFromId?: string }): void {}
  attachAudio(_id: string, _audio: AttachedAudio): void {}
  play(): void {
    this.state = { ...this.state, status: 'playing' };
  }
  pause(): void {
    this.state = { ...this.state, status: 'paused' };
  }
  stop(): void {
    this.state = { ...this.state, status: 'idle', currentUtteranceId: null };
  }
  seekTo(id: string): void {
    this.state = { ...this.state, currentUtteranceId: id };
  }
  setRate(rate: number): void {
    this.state = { ...this.state, rate };
  }
  setVoice(voice: VoiceRef): void {
    this.state = { ...this.state, voice };
  }
  setSleepTimer(timer: SleepTimerConfig): void {
    this.state = { ...this.state, sleepTimer: { mode: timer.mode } };
  }
  async getState(): Promise<SpeechState> {
    return this.state;
  }
  subscribe(listener: (event: SpeechEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function createDesktopSpeechPlayer(): SpeechPlayer {
  const maybeCtor = (UiModule as unknown as { WebSpeechPlayer?: new () => SpeechPlayer })
    .WebSpeechPlayer;
  if (typeof maybeCtor === 'function') {
    return new maybeCtor();
  }
  return new FallbackBrowserSpeechPlayer();
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root mount element');
}

const host = createRestPlatformHost();
const speechPlayer = createDesktopSpeechPlayer();
UiModule.mountMiniBookApp(container, host, speechPlayer);
