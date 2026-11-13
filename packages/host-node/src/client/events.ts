/**
 * Browser / test SSE subscriber for `/api/events`.
 */
import type { HostEvent, Unsubscribe } from '@minibook/core';

export interface HostEventStreamOptions {
  readonly url: string;
  readonly fetchImpl?: typeof fetch;
  readonly enabled?: boolean;
}

export class HostEventStream {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly enabled: boolean;
  private readonly listeners = new Set<(event: HostEvent) => void>();
  private eventSource: EventSource | null = null;
  private abortController: AbortController | null = null;

  constructor(options: HostEventStreamOptions) {
    this.url = options.url;
    this.fetchImpl = options.fetchImpl;
    this.enabled = options.enabled ?? true;
  }

  subscribe(listener: (event: HostEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    if (this.enabled && this.listeners.size === 1) {
      this.start();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stop();
      }
    };
  }

  emitLocal(event: HostEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore listener failure
      }
    }
  }

  private start(): void {
    if (!this.fetchImpl && typeof EventSource !== 'undefined') {
      const es = new EventSource(this.url);
      es.onmessage = (ev) => {
        this.dispatchRawData(ev.data);
      };
      this.eventSource = es;
      return;
    }

    const fetchFn = this.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
    if (!fetchFn) return;
    const controller = new AbortController();
    this.abortController = controller;
    void this.consumeFetchSse(fetchFn, controller.signal);
  }

  private async consumeFetchSse(fetchFn: typeof fetch, signal: AbortSignal): Promise<void> {
    try {
      const resp = await fetchFn(this.url, {
        headers: { Accept: 'text/event-stream' },
        signal,
      });
      if (!resp.ok || !resp.body) return;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sepIdx: number;
        while ((sepIdx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('data:')) {
              this.dispatchRawData(line.slice(5).trim());
            }
          }
        }
      }
    } catch {
      // ignore stream close / abort
    }
  }

  private dispatchRawData(raw: string): void {
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as HostEvent;
      if (parsed && typeof parsed.type === 'string') {
        this.emitLocal(parsed);
      }
    } catch {
      // ignore malformed SSE frame
    }
  }

  private stop(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}
