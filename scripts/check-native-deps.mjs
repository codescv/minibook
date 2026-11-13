#!/usr/bin/env node
/**
 * Guard: the *runtime* dependency tree of the desktop host and core must contain
 * zero compiled native addons (macOS / Linux / Windows "zero native addons" rule).
 *
 * Scans every package reachable from the production dependencies of
 * `@minibook/host-node` and `@minibook/core` for:
 *   - `binding.gyp`, `*.node` files
 *   - `gypfile: true`, `install`/`postinstall` scripts invoking node-gyp,
 *     `node-gyp-build`, `prebuild-install`, `node-pre-gyp`, `cmake-js`
 *   - a hard dependency on a known native module (see NATIVE_NAMES)
 *
 * Additionally (`TTS_V2_SPEC.md` §5.1), scans ALL workspace packages' prod + dev trees
 * to ensure `onnxruntime-node` is never installed and no `onnxruntime-*` package ships
 * `*.node` or `binding.gyp`.
 *
 * Usage: `pnpm run check:native` (exit code 1 on any finding).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const RUNTIME_PACKAGES = ['@minibook/host-node', '@minibook/core'];
const NATIVE_NAMES = new Set([
  'better-sqlite3',
  'sqlite3',
  'node-datachannel',
  'canvas',
  'sharp',
  'utp-native',
  'bufferutil',
  'utf-8-validate',
  'onnxruntime-node',
  'node-gyp',
  'node-gyp-build',
  'prebuild-install',
  '@mapbox/node-pre-gyp',
  'cmake-js',
  'fsevents',
]);
const SCRIPT_MARKERS = /node-gyp|prebuild-install|node-pre-gyp|cmake-js|node-gyp-build/;

/** @returns {Array<{name:string, version:string, path:string}>} */
function listPackages(args) {
  const out = execFileSync('pnpm', args, { cwd: ROOT, encoding: 'utf8' });
  const seen = new Map();
  const visit = (deps) => {
    if (!deps) return;
    for (const [name, info] of Object.entries(deps)) {
      const key = `${name}@${info.version}`;
      if (seen.has(key)) continue;
      seen.set(key, { name, version: info.version, path: info.path });
      visit(info.dependencies);
      visit(info.optionalDependencies);
    }
  };
  for (const project of JSON.parse(out)) {
    visit(project.dependencies);
    visit(project.devDependencies);
    visit(project.optionalDependencies);
  }
  return [...seen.values()];
}

/** Recursively look for `.node` binaries / binding.gyp under a package dir. */
function findNativeFiles(dir, depth = 0, acc = []) {
  if (depth > 4 || !existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) findNativeFiles(full, depth + 1, acc);
    else if (entry === 'binding.gyp' || entry.endsWith('.node')) acc.push(full);
  }
  return acc;
}

const findings = [];
for (const filter of RUNTIME_PACKAGES) {
  for (const pkg of listPackages(['ls', '--prod', '--depth', 'Infinity', '--json', '--filter', filter])) {
    if (!pkg.path || pkg.name.startsWith('@minibook/')) continue;
    if (NATIVE_NAMES.has(pkg.name)) {
      findings.push(`${filter}: depends on known native module ${pkg.name}@${pkg.version}`);
    }
    const manifestPath = join(pkg.path, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.gypfile) findings.push(`${filter}: ${pkg.name} has gypfile:true`);
      for (const hook of ['install', 'postinstall', 'preinstall']) {
        const script = manifest.scripts?.[hook];
        if (script && SCRIPT_MARKERS.test(script)) {
          findings.push(`${filter}: ${pkg.name} ${hook} script "${script}"`);
        }
      }
    }
    for (const file of findNativeFiles(pkg.path)) {
      findings.push(`${filter}: ${pkg.name} ships ${file.slice(pkg.path.length + 1)}`);
    }
  }
}

// Workspace-wide guard (prod + dev) against native onnxruntime bindings (`TTS_V2_SPEC.md` §5.1)
for (const pkg of listPackages(['ls', '-r', '--depth', 'Infinity', '--json'])) {
  if (!pkg.path || pkg.name.startsWith('@minibook/')) continue;
  if (pkg.name === 'onnxruntime-node') {
    findings.push(`workspace: banned native binding ${pkg.name}@${pkg.version} is installed`);
  } else if (pkg.name.startsWith('onnxruntime-')) {
    for (const file of findNativeFiles(pkg.path)) {
      findings.push(`workspace: ${pkg.name} ships ${file.slice(pkg.path.length + 1)}`);
    }
  }
}

if (findings.length > 0) {
  console.error('✖ Native addon(s) detected in dependency tree:\n  ' + findings.join('\n  '));
  process.exit(1);
}
console.log('✔ No native addons in runtime dependency tree of ' + RUNTIME_PACKAGES.join(', ') + ' (and onnxruntime-* verified clean)');
