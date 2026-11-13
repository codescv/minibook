import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const localPublicDir = fileURLToPath(new URL('./public', import.meta.url));
const publicDir = existsSync(localPublicDir) ? localPublicDir : undefined;
const coreG2pDir = resolve(here, '../../core/assets/kokoro-g2p');
const wwwG2pDir = resolve(here, '../www/kokoro-g2p');

function kokoroG2pAssetsPlugin(): Plugin {
  return {
    name: 'minibook-bundle-kokoro-g2p',
    configureServer(server) {
      server.middlewares.use('/kokoro-g2p', (req, res, next) => {
        const rel = ((req.url ?? '').split('?')[0] ?? '').replace(/^\/+/, '');
        if (!rel || rel.includes('..') || rel.includes('\\')) {
          next();
          return;
        }
        const filePath = join(coreG2pDir, rel);
        if (!existsSync(filePath)) {
          next();
          return;
        }
        res.setHeader('Content-Type', filePath.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream');
        res.end(readFileSync(filePath));
      });
    },
    closeBundle() {
      if (existsSync(coreG2pDir)) {
        cpSync(coreG2pDir, wwwG2pDir, { recursive: true });
      }
    },
  };
}

/** Builds the shared Capacitor `www/` web bundle for Android and Google3 iOS (`ARCHITECTURE.md` §1, §11). */
export default defineConfig({
  root: here,
  ...(publicDir ? { publicDir } : {}),
  plugins: [react(), kokoroG2pAssetsPlugin()],
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
