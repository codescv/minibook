import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string): MediaQueryList => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }

  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class ResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }

  if (!URL.createObjectURL) {
    let counter = 0;
    URL.createObjectURL = () => `blob:minibook-test/${++counter}`;
    URL.revokeObjectURL = () => {};
  }
}

// Serve bundled `@minibook/core` Kokoro G2P `.gz` dictionaries for relative `/kokoro-g2p/v1/*` fetches in Vitest.
{
  const proc = (globalThis as Record<string, any>).process;
  const nodeFs = proc?.getBuiltinModule?.('node:fs');
  const nodePath = proc?.getBuiltinModule?.('node:path');
  const origFetch = globalThis.fetch;
  if (nodeFs && nodePath && typeof origFetch === 'function') {
    const cwd = typeof proc.cwd === 'function' ? proc.cwd() : '.';
    const g2pDir = [
      nodePath.resolve(cwd, 'packages/core/assets/kokoro-g2p/v1'),
      nodePath.resolve(cwd, '../core/assets/kokoro-g2p/v1'),
    ].find((dir: string) => nodeFs.existsSync(dir));
    if (g2pDir) {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const rawUrl =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const match = /(?:^|\/)kokoro-g2p\/v1\/([A-Za-z0-9._-]+)$/.exec(rawUrl);
        if (match) {
          const filePath = nodePath.join(g2pDir, match[1]);
          if (nodeFs.existsSync(filePath)) {
            const bytes = nodeFs.readFileSync(filePath);
            return new Response(new Uint8Array(bytes), {
              status: 200,
              headers: { 'Content-Type': 'application/gzip' },
            });
          }
        }
        return origFetch(input, init);
      }) as typeof fetch;
    }
  }
}
