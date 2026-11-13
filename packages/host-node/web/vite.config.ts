import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const webDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: webDir,
  plugins: [react()],
  resolve: {
    alias: {
      '@minibook/core': resolve(webDir, '../../core/src/index.ts'),
      '@minibook/ui': resolve(webDir, '../../ui/src/index.ts'),
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
    proxy: {
      '/api': 'http://127.0.0.1:47822',
    },
  },
  build: {
    outDir: resolve(webDir, '../dist/web'),
    emptyOutDir: true,
    target: 'es2020',
  },
});
