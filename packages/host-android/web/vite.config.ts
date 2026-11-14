import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const localPublicDir = fileURLToPath(new URL('./public', import.meta.url));
const publicDir = existsSync(localPublicDir) ? localPublicDir : undefined;
const coreG2pDir = resolve(here, '../../core/assets/kokoro-g2p');
const wwwOutDir = resolve(here, '../www');
const wwwG2pDir = resolve(wwwOutDir, 'kokoro-g2p');

const CLANG_FORMAT_OFF_BANNER = '/* clang-format off */\n';

/**
 * Prepends `/* clang-format off *\/` to every emitted `.js` file under `www/` so Google3's
 * `/usr/bin/google3format` (`jj fix`, `hg fix`, Critique presubmit) leaves minified bundles and
 * regex literals 100% byte-for-byte untouched when synced to `//experimental/users/chii/ios/minibook/Resources/www`.
 */
function guardJsFromClangFormat(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      guardJsFromClangFormat(full);
    } else if (entry.endsWith('.js')) {
      const content = readFileSync(full, 'utf8');
      if (!content.startsWith('/* clang-format off */')) {
        writeFileSync(full, CLANG_FORMAT_OFF_BANNER + content, 'utf8');
      }
    }
  }
}

function kokoroG2pAndFormatGuardPlugin(): Plugin {
  return {
    name: 'minibook-bundle-kokoro-g2p-and-format-guard',
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
      guardJsFromClangFormat(wwwOutDir);
    },
  };
}

/** Builds the shared Capacitor `www/` web bundle for Android and Google3 iOS (`ARCHITECTURE.md` §1, §11). */
export default defineConfig({
  root: here,
  ...(publicDir ? { publicDir } : {}),
  plugins: [react(), kokoroG2pAndFormatGuardPlugin()],
  worker: {
    format: 'es',
  },
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
