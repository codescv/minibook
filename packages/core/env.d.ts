/**
 * Platform-neutral WinterCG / Web-standard globals allowed in `@minibook/core`
 * (`ARCHITECTURE.md` §0: no `node:*`, no DOM, no Capacitor).
 */

interface TextDecoderOptions {
  fatal?: boolean;
  ignoreBOM?: boolean;
}

interface TextDecodeOptions {
  stream?: boolean;
}

declare class TextDecoder {
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  constructor(label?: string, options?: TextDecoderOptions);
  decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions): string;
}

declare class TextEncoder {
  readonly encoding: string;
  constructor();
  encode(input?: string): Uint8Array;
  encodeInto(source: string, destination: Uint8Array): { read: number; written: number };
}

type AllowSharedBufferSource = ArrayBuffer | ArrayBufferView;

declare class URLSearchParams implements Iterable<[string, string]> {
  constructor(init?: string | Record<string, string> | Iterable<[string, string]> | URLSearchParams);
  append(name: string, value: string): void;
  delete(name: string): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string): boolean;
  set(name: string, value: string): void;
  sort(): void;
  toString(): string;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

declare class URL {
  href: string;
  readonly origin: string;
  protocol: string;
  username: string;
  password: string;
  host: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  readonly searchParams: URLSearchParams;
  hash: string;
  constructor(url: string | URL, base?: string | URL);
  toString(): string;
  toJSON(): string;
}

interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
  throwIfAborted(): void;
}

declare class AbortController {
  readonly signal: AbortSignal;
  constructor();
  abort(reason?: unknown): void;
}

interface SubtleCrypto {
  digest(algorithm: 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512' | { name: string }, data: AllowSharedBufferSource): Promise<ArrayBuffer>;
}

interface Crypto {
  readonly subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  randomUUID(): string;
}

declare const crypto: Crypto;
declare function atob(data: string): string;
declare function btoa(data: string): string;
declare function queueMicrotask(callback: () => void): void;
declare function setTimeout(handler: () => void, timeout?: number): unknown;
declare function clearTimeout(id: unknown): void;
declare const performance: { now(): number };
