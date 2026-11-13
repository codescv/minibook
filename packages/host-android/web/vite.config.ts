import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const localPublicDir = fileURLToPath(new URL('./public', import.meta.url));
const publicDir = existsSync(localPublicDir) ? localPublicDir : undefined;

/** Builds the shared Capacitor `www/` web bundle for Android and Google3 iOS (`ARCHITECTURE.md` §1, §11). */
export default defineConfig({
  root: here,
  ...(publicDir ? { publicDir } : {}),
  plugins: [react()],
  resolve: {
    alias: {
      '@minibook/core': resolve(here, '../../core/src/index.ts'),
      '@minibook/ui': resolve(here, '../../ui/src/index.ts'),
    },
  },
  build: {
    outDir: '../www',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
  server: { port: 5176 },
});
