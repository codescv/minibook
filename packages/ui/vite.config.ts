import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const here = fileURLToPath(new URL('.', import.meta.url));
const coreG2pDir = resolve(here, '../core/assets/kokoro-g2p');

const COOP_COEP_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function kokoroG2pDevPlugin(): Plugin {
  return {
    name: 'minibook-ui-kokoro-g2p-dev',
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
        res.setHeader(
          'Content-Type',
          filePath.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream',
        );
        res.end(readFileSync(filePath));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), kokoroG2pDevPlugin()],
  worker: {
    format: 'es',
  },
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    headers: COOP_COEP_HEADERS,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    headers: COOP_COEP_HEADERS,
  },
});
