/**
 * Bundles `@minibook/host-node` server + `@minibook/core` into a self-contained ESM
 * bundle at `dist/server.mjs` (zero native addons) and copies SQLite migrations to
 * `dist/migrations/`.
 */
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

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
