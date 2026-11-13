/**
 * Copies the exact `onnxruntime-web` runtime assets required by `kokoro.worker.ts`
 * (`TTS_V2_SPEC.md` §5.1) into `web/public/ort/` so Vite serves/bundles them cleanly
 * without bundling `.wasm` into JS chunks.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const ORT_FILES = [
  'ort.webgpu.min.mjs',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
];

export function copyOrtAssets(targetDir = join(pkgRoot, 'web', 'public', 'ort')) {
  const localDist = join(pkgRoot, 'node_modules', 'onnxruntime-web', 'dist');
  const ortDist = existsSync(localDist) ? localDist : dirname(require.resolve('onnxruntime-web'));
  mkdirSync(targetDir, { recursive: true });

  for (const fileName of ORT_FILES) {
    const src = join(ortDist, fileName);
    if (!existsSync(src)) {
      throw new Error(`Missing onnxruntime-web asset: ${src}`);
    }
    copyFileSync(src, join(targetDir, fileName));
  }
  return targetDir;
}

const isDirectEntry =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectEntry) {
  const out = copyOrtAssets();
  process.stdout.write(`[host-node] Copied ${ORT_FILES.length} ORT assets to ${out}\n`);
}
