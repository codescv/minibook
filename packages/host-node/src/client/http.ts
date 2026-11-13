import { MiniBookError } from '@minibook/core';
import type { ApiEnvelope } from '../shared/wire.js';

export interface RestClientConfig {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  readonly rawBody?: Uint8Array | ReadableStream<Uint8Array>;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export class RestJsonClient {
  readonly baseUrl: string;
  readonly fetchImpl: typeof fetch;

  constructor(config?: RestClientConfig) {
    this.baseUrl = (config?.baseUrl ?? '').replace(/\/+$/, '');
    this.fetchImpl = config?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  resolveUrl(path: string, query?: Readonly<Record<string, string | number | boolean | undefined>>): string {
    const prefix = this.baseUrl ? `${this.baseUrl}${path}` : path;
    if (!query) return prefix;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) {
        params.set(k, String(v));
      }
    }
    const qs = params.toString();
    return qs ? `${prefix}?${qs}` : prefix;
  }

  async request<T>(method: string, path: string, options?: RequestOptions): Promise<T> {
    const url = this.resolveUrl(path, options?.query);
    const headers: Record<string, string> = {
      ...(options?.headers ?? {}),
    };

    let bodyInit: BodyInit | undefined;
    if (options?.rawBody !== undefined) {
      headers['Content-Type'] = options.contentType ?? 'application/octet-stream';
      bodyInit =
        options.rawBody instanceof Uint8Array
          ? new Uint8Array(options.rawBody)
          : options.rawBody;
    } else if (options?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyInit = JSON.stringify(options.body);
    }

    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method,
        headers,
        ...(bodyInit !== undefined ? { body: bodyInit } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      throw MiniBookError.wrap(err, 'network');
    }

    let parsed: ApiEnvelope<T>;
    try {
      parsed = (await resp.json()) as ApiEnvelope<T>;
    } catch (err) {
      throw new MiniBookError(
        'network',
        `Unexpected non-JSON response (${resp.status}) from ${method} ${path}`,
        { cause: err },
      );
    }

    if (!parsed.ok) {
      throw MiniBookError.fromShape(parsed.error);
    }
    return parsed.data;
  }
}
