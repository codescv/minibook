/**
 * Bundles `@minibook/host-node` server + `@minibook/core` into a self-contained ESM
 * bundle at `dist/server.mjs` (zero native addons), copies SQLite migrations to
 * `dist/migrations/`, and ensures `onnxruntime-web` `.mjs`/`.wasm` assets are present
 * in `dist/web/ort/` (`TTS_V2_SPEC.md` §5.1).
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { copyOrtAssets } from './scripts/copy-ort-assets.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const distDir = join(root, 'dist');
mkdirSync(distDir, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'server', 'index.ts')],
  outfile: join(distDir, 'server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['node:*'],
  banner: {
    js: [
      '// Bundled @minibook/host-node server (Node >= 22.5, built-in node:sqlite)',
      'import { createRequire as __mbCreateRequire } from "node:module";',
      'const require = __mbCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});

cpSync(join(root, 'src', 'db', 'migrations'), join(distDir, 'migrations'), {
  recursive: true,
});

// Ensure ORT WebGPU/WASM runtime assets are always present in `dist/web/ort/`
copyOrtAssets(join(distDir, 'web', 'ort'));

// Also copy G2P `.gz` dictionaries if present in `@minibook/core`
const coreG2pDir = join(root, '..', 'core', 'assets', 'kokoro-g2p');
if (existsSync(coreG2pDir)) {
  cpSync(coreG2pDir, join(distDir, 'web', 'kokoro-g2p'), { recursive: true });
}
