import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const THIS_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const SRC_DIR = resolve(THIS_DIR, '..');
const PKG_JSON_PATH = resolve(SRC_DIR, '..', 'package.json');

function collectProdSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry.endsWith('.test.ts')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectProdSourceFiles(full, acc);
    } else if (entry.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

function stripCommentsAndStrings(src: string): { noComments: string; identifiersOnly: string } {
  let noComments = '';
  let idOnly = '';
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i]!;
    const next = src[i + 1];

    // Block comment `/* ... */`
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      noComments += ' ';
      idOnly += ' ';
      continue;
    }
    // Line comment `// ...`
    if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i + 2);
      i = end < 0 ? n : end;
      continue;
    }
    // String or template literal
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      noComments += quote;
      idOnly += quote;
      i++;
      while (i < n) {
        const c = src[i]!;
        noComments += c;
        if (c === '\\' && i + 1 < n) {
          noComments += src[i + 1]!;
          i += 2;
          continue;
        }
        i++;
        if (c === quote) break;
      }
      idOnly += quote;
      continue;
    }

    noComments += ch;
    idOnly += ch;
    i++;
  }

  return { noComments, identifiersOnly: idOnly };
}

describe('@minibook/core platform-neutral purity & dependency contract', () => {
  it('ships ONLY fflate and parse5 in runtime dependencies (ARCHITECTURE.md §0, §1.1)', () => {
    const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const depNames = Object.keys(pkg.dependencies ?? {}).sort();
    expect(depNames).toEqual(['fflate', 'parse5']);
  });

  it('contains zero node:*, DOM, or Capacitor references in production source files', () => {
    const files = collectProdSourceFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(20);

    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      const { noComments, identifiersOnly } = stripCommentsAndStrings(code);
      expect(noComments, `${file} must not import node:*`).not.toMatch(/from\s+['"]node:/);
      expect(noComments, `${file} must not import @capacitor/*`).not.toMatch(/@capacitor\//);
      expect(identifiersOnly, `${file} must not use window/document DOM globals`).not.toMatch(
        /\b(?:window|document|HTMLElement|DOMParser|localStorage|IndexedDB)\b/,
      );
    }
  });
});
