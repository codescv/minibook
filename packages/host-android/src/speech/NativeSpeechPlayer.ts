/**
 * Native `SpeechPlayer` implementation bridged to Android `ReadAloudService` (Media3)
 * and iOS `MiniBookSpeechEngine` (`AVSpeechSynthesizer` + `AVQueuePlayer`) via `MiniBookPlugin`
 * (`ARCHITECTURE.md` §8.3, §8.5, §8.6).
 *
 * Every bridge command runs through a single serialized promise chain (`cmdChain`) after
 * ensuring native event listeners are attached, preventing microtask reordering between
 * `enqueue`/`play` and `seekTo`/`pause`/`stop`/`attachAudio`.
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
  private cmdChain: Promise<void> = Promise.resolve();

  constructor(plugin?: MiniBookPlugin) {
    this.plugin = plugin ?? createDefaultMiniBookPlugin();
  }

  private runSerialized(op: () => Promise<void>): Promise<void> {
    const next = this.cmdChain
      .catch(() => undefined)
      .then(() => this.ensureListenersAttached())
      .then(op);
    this.cmdChain = next.catch((err) => {
      this.emitError(err);
    });
    return next;
  }

  async listVoices(): Promise<Voice[]> {
    const voices = await this.plugin.speech.voices();
    return [...voices];
  }

  async load(session: SpeechSession): Promise<void> {
    await this.runSerialized(() => this.plugin.speech.load(session));
  }

  enqueue(items: readonly Utterance[], opts?: { readonly replaceFromId?: string }): void {
    void this.runSerialized(() =>
      this.plugin.speech.enqueue({
        items,
        ...(opts?.replaceFromId !== undefined ? { replaceFromId: opts.replaceFromId } : {}),
      }),
    ).catch(() => undefined);
  }

  attachAudio(id: string, audio: AttachedAudio): void {
    void this.runSerialized(() =>
      this.plugin.speech.attachAudio({
        id,
        path: audio.ref,
        ...(audio.durationMs !== undefined ? { durationMs: audio.durationMs } : {}),
        ...(audio.marks !== undefined ? { marks: audio.marks } : {}),
      }),
    ).catch(() => undefined);
  }

  play(): void {
    void this.runSerialized(() => this.plugin.speech.play()).catch(() => undefined);
  }

  pause(): void {
    void this.runSerialized(() => this.plugin.speech.pause()).catch(() => undefined);
  }

  stop(): void {
    void this.runSerialized(() => this.plugin.speech.stop()).catch(() => undefined);
  }

  seekTo(id: string): void {
    void this.runSerialized(() => this.plugin.speech.seekTo({ id })).catch(() => undefined);
  }

  setRate(rate: number): void {
    void this.runSerialized(() => this.plugin.speech.setRate({ rate })).catch(() => undefined);
  }

  setVoice(voice: VoiceRef): void {
    void this.runSerialized(() => this.plugin.speech.setVoice({ voice })).catch(() => undefined);
  }

  setSleepTimer(timer: SleepTimerConfig): void {
    void this.runSerialized(() => this.plugin.speech.setSleepTimer(timer)).catch(() => undefined);
  }

  async getState(): Promise<SpeechState> {
    await this.cmdChain.catch(() => undefined);
    return this.plugin.speech.getState();
  }

  subscribe(listener: (event: SpeechEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    void this.ensureListenersAttached().catch(() => undefined);
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
      h.push(
        await this.plugin.addListener('engine-slow', (ev) => {
          this.emit({
            type: 'engine-slow',
            rtf: ev.rtf,
            engine: ev.engine ?? 'kokoro',
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
