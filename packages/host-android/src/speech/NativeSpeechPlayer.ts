/**
 * Native `SpeechPlayer` implementation bridged to Android `ReadAloudService` (Media3)
 * and iOS `MiniBookSpeechEngine` (`AVSpeechSynthesizer` + `AVQueuePlayer`) via `MiniBookPlugin`
 * (`ARCHITECTURE.md` §8.3, §8.5, §8.6).
 */
import {
  MiniBookError,
  type AttachedAudio,
  type SleepTimerConfig,
  type SpeechEvent,
  type SpeechPlayer,
  type SpeechSession,
  type SpeechState,
  type Unsubscribe,
  type Utterance,
  type Voice,
  type VoiceRef,
} from '@minibook/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { createDefaultMiniBookPlugin, type MiniBookPlugin } from '../plugin-types.js';

export class NativeSpeechPlayer implements SpeechPlayer {
  readonly capabilities = {
    nativeQueue: true,
    wordEvents: true,
  } as const;

  private readonly plugin: MiniBookPlugin;
  private readonly listeners = new Set<(event: SpeechEvent) => void>();
  private nativeHandles: PluginListenerHandle[] = [];
  private attached = false;
  private attaching: Promise<void> | null = null;

  constructor(plugin?: MiniBookPlugin) {
    this.plugin = plugin ?? createDefaultMiniBookPlugin();
  }

  async listVoices(): Promise<Voice[]> {
    const voices = await this.plugin.speech.voices();
    return [...voices];
  }

  async load(session: SpeechSession): Promise<void> {
    await this.ensureListenersAttached();
    await this.plugin.speech.load(session);
  }

  enqueue(items: readonly Utterance[], opts?: { readonly replaceFromId?: string }): void {
    void this.ensureListenersAttached()
      .then(() =>
        this.plugin.speech.enqueue({
          items,
          ...(opts?.replaceFromId !== undefined ? { replaceFromId: opts.replaceFromId } : {}),
        }),
      )
      .catch((err) => this.emitError(err));
  }

  attachAudio(id: string, audio: AttachedAudio): void {
    void this.plugin.speech
      .attachAudio({
        id,
        path: audio.ref,
        ...(audio.durationMs !== undefined ? { durationMs: audio.durationMs } : {}),
        ...(audio.marks !== undefined ? { marks: audio.marks } : {}),
      })
      .catch((err) => this.emitError(err));
  }

  play(): void {
    void this.ensureListenersAttached()
      .then(() => this.plugin.speech.play())
      .catch((err) => this.emitError(err));
  }

  pause(): void {
    void this.plugin.speech.pause().catch((err) => this.emitError(err));
  }

  stop(): void {
    void this.plugin.speech.stop().catch((err) => this.emitError(err));
  }

  seekTo(id: string): void {
    void this.plugin.speech.seekTo({ id }).catch((err) => this.emitError(err));
  }

  setRate(rate: number): void {
    void this.plugin.speech.setRate({ rate }).catch((err) => this.emitError(err));
  }

  setVoice(voice: VoiceRef): void {
    void this.plugin.speech.setVoice({ voice }).catch((err) => this.emitError(err));
  }

  setSleepTimer(timer: SleepTimerConfig): void {
    void this.plugin.speech.setSleepTimer(timer).catch((err) => this.emitError(err));
  }

  getState(): Promise<SpeechState> {
    return this.plugin.speech.getState();
  }

  subscribe(listener: (event: SpeechEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    void this.ensureListenersAttached();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        void this.detachListeners();
      }
    };
  }

  private emit(event: SpeechEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // isolate subscriber errors
      }
    }
  }

  private emitError(err: unknown): void {
    const wrapped = MiniBookError.wrap(err, 'speech-unavailable');
    this.emit({ type: 'speech-error', error: wrapped.toShape() });
  }

  private async ensureListenersAttached(): Promise<void> {
    if (this.attached) return;
    if (this.attaching) return this.attaching;

    this.attaching = (async () => {
      const h: PluginListenerHandle[] = [];
      h.push(
        await this.plugin.addListener('speech-state', (state) => {
          this.emit({ type: 'speech-state', state });
        }),
      );
      h.push(
        await this.plugin.addListener('utterance-start', (ev) => {
          this.emit({
            type: 'utterance-start',
            id: ev.id,
            section: ev.section,
            start: ev.start,
            end: ev.end,
            ...(ev.usingFallback !== undefined ? { usingFallback: ev.usingFallback } : {}),
          });
        }),
      );
      h.push(
        await this.plugin.addListener('utterance-word', (ev) => {
          this.emit({
            type: 'utterance-word',
            id: ev.id,
            start: ev.start,
            end: ev.end,
            ...(ev.timeMs !== undefined ? { timeMs: ev.timeMs } : {}),
          });
        }),
      );
      h.push(
        await this.plugin.addListener('utterance-done', (ev) => {
          this.emit({ type: 'utterance-done', id: ev.id });
        }),
      );
      h.push(
        await this.plugin.addListener('queue-low', (ev) => {
          this.emit({ type: 'queue-low', remaining: ev.remaining });
        }),
      );
      h.push(
        await this.plugin.addListener('speech-fallback', (ev) => {
          this.emit({
            type: 'speech-fallback',
            reason: ev.reason,
            ...(ev.utteranceId !== undefined ? { utteranceId: ev.utteranceId } : {}),
          });
        }),
      );
      h.push(
        await this.plugin.addListener('speech-ended', (ev) => {
          this.emit({ type: 'speech-ended', reason: ev.reason });
        }),
      );
      h.push(
        await this.plugin.addListener('sleep-timer', (ev) => {
          this.emit({
            type: 'sleep-timer',
            mode: ev.mode,
            ...(ev.remainingMs !== undefined ? { remainingMs: ev.remainingMs } : {}),
            ...(ev.expired !== undefined ? { expired: ev.expired } : {}),
          });
        }),
      );
      this.nativeHandles = h;
      this.attached = true;
    })().finally(() => {
      this.attaching = null;
    });

    return this.attaching;
  }

  private async detachListeners(): Promise<void> {
    this.attached = false;
    const handles = this.nativeHandles.splice(0, this.nativeHandles.length);
    for (const handle of handles) {
      await handle.remove().catch(() => undefined);
    }
  }
}
