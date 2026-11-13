import { describe, expect, it } from 'vitest';

const ALL_UI_STYLESHEETS = import.meta.glob<string>('../**/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const TOKEN_LAYER_ALLOWLIST = new Set([
  'theme/tokens.css',
  'theme/themes.css',
  'theme/eink.css',
]);

export interface CssAstDeclaration {
  readonly file: string;
  readonly selectorPath: string;
  readonly property: string;
  readonly value: string;
  readonly line: number;
}

function stripCssCommentsPreserveNewlines(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

/**
 * Pure-TS CSS AST parser handling nested `@media` / `@supports` blocks, strings,
 * parentheses (`var(...)`, `calc(...)`, `rgba(...)`), selectors, and declarations.
 */
export function parseCssDeclarations(css: string, file: string): CssAstDeclaration[] {
  const clean = stripCssCommentsPreserveNewlines(css);
  const declarations: CssAstDeclaration[] = [];
  const selectorStack: string[] = [];

  let i = 0;
  let line = 1;
  let tokenStartLine = 1;
  let buf = '';
  let inQuote: '"' | "'" | null = null;
  let parenDepth = 0;

  const flushDeclaration = (raw: string, declLine: number): void => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('@')) return;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) return;
    const property = trimmed.slice(0, colon).trim().toLowerCase();
    const value = trimmed.slice(colon + 1).trim();
    declarations.push({
      file,
      selectorPath: selectorStack.join(' > ') || ':root',
      property,
      value,
      line: declLine,
    });
  };

  while (i < clean.length) {
    const ch = clean[i]!;

    if (ch === '\n') {
      line += 1;
    }

    if (inQuote) {
      buf += ch;
      if (ch === inQuote && clean[i - 1] !== '\\') {
        inQuote = null;
      }
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      if (buf.trim().length === 0) tokenStartLine = line;
      inQuote = ch;
      buf += ch;
      i += 1;
      continue;
    }

    if (ch === '(') {
      if (buf.trim().length === 0) tokenStartLine = line;
      parenDepth += 1;
      buf += ch;
      i += 1;
      continue;
    }

    if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      buf += ch;
      i += 1;
      continue;
    }

    if (parenDepth === 0 && ch === '{') {
      const sel = buf.trim().replace(/\s+/g, ' ');
      selectorStack.push(sel);
      buf = '';
      tokenStartLine = line;
      i += 1;
      continue;
    }

    if (parenDepth === 0 && ch === '}') {
      if (buf.trim().length > 0) {
        flushDeclaration(buf, tokenStartLine);
      }
      buf = '';
      selectorStack.pop();
      tokenStartLine = line;
      i += 1;
      continue;
    }

    if (parenDepth === 0 && ch === ';') {
      if (buf.trim().length > 0) {
        flushDeclaration(buf, tokenStartLine);
      }
      buf = '';
      tokenStartLine = line;
      i += 1;
      continue;
    }

    if (buf.trim().length === 0 && !/\s/.test(ch)) {
      tokenStartLine = line;
    }
    buf += ch;
    i += 1;
  }

  return declarations;
}

const GUARDED_PROPS = new Set([
  'box-shadow',
  'text-shadow',
  'filter',
  'backdrop-filter',
  '-webkit-backdrop-filter',
  'opacity',
  'transition',
  'transition-duration',
  'transition-property',
  'animation',
  'animation-duration',
  'animation-name',
  'border-radius',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
]);

const GRADIENT_RE = /\b(linear|radial|conic|repeating-linear|repeating-radial)-gradient\s*\(/i;
const ALPHA_COLOR_RE = /\b(rgba|hsla|color-mix)\s*\(|#[0-9a-f]{4}\b|#[0-9a-f]{8}\b/i;
const RAW_HEX_RE = /#[0-9a-f]{3,8}\b/i;

function isNeutralOrTokenValue(prop: string, rawValue: string): boolean {
  const value = rawValue.replace(/\s*!important\s*$/i, '').trim();
  if (/^var\(\s*--mb-[a-z0-9-]+\s*\)$/i.test(value)) {
    return true;
  }
  if (
    (prop === 'box-shadow' ||
      prop === 'text-shadow' ||
      prop === 'filter' ||
      prop === 'backdrop-filter' ||
      prop === '-webkit-backdrop-filter' ||
      prop.startsWith('transition') ||
      prop.startsWith('animation')) &&
    value === 'none'
  ) {
    return true;
  }
  if (
    (prop === 'transition-duration' || prop === 'animation-duration') &&
    (value === '0s' || value === '0ms')
  ) {
    return true;
  }
  if (prop === 'opacity' && value === '1') {
    return true;
  }
  if (prop.includes('radius') && (value === '0' || value === '0px')) {
    return true;
  }
  return false;
}

export function lintComponentCssDeclarations(decls: readonly CssAstDeclaration[]): string[] {
  const violations: string[] = [];

  for (const d of decls) {
    if (d.property.startsWith('--')) continue;

    if (GUARDED_PROPS.has(d.property) && !isNeutralOrTokenValue(d.property, d.value)) {
      violations.push(
        `${d.file}:${d.line} [${d.selectorPath}] forbidden raw '${d.property}: ${d.value}' (must use var(--mb-*))`,
      );
    }

    if (GRADIENT_RE.test(d.value) && !isNeutralOrTokenValue(d.property, d.value)) {
      violations.push(
        `${d.file}:${d.line} [${d.selectorPath}] forbidden raw gradient in '${d.property}: ${d.value}'`,
      );
    }

    if (ALPHA_COLOR_RE.test(d.value)) {
      violations.push(
        `${d.file}:${d.line} [${d.selectorPath}] forbidden alpha colour in '${d.property}: ${d.value}'`,
      );
    }

    if (RAW_HEX_RE.test(d.value)) {
      violations.push(
        `${d.file}:${d.line} [${d.selectorPath}] forbidden raw hex colour in '${d.property}: ${d.value}' (must use var(--mb-*))`,
      );
    }
  }

  return violations;
}

describe('E-Ink Stylesheet AST Lint (ARCHITECTURE.md §9.2)', () => {
  it('enforces zero raw shadow/filter/opacity/transition/animation/radius/gradient/alpha/hex outside theme token files', () => {
    const entries = Object.entries(ALL_UI_STYLESHEETS);
    expect(entries.length).toBeGreaterThanOrEqual(4);

    const allViolations: string[] = [];
    let checkedComponentDeclarations = 0;

    for (const [globPath, content] of entries) {
      const rel = globPath.replace(/^\.\.\//, '');
      const decls = parseCssDeclarations(content, rel);

      if (TOKEN_LAYER_ALLOWLIST.has(rel)) {
        continue;
      }

      checkedComponentDeclarations += decls.length;
      allViolations.push(...lintComponentCssDeclarations(decls));
    }

    expect(checkedComponentDeclarations).toBeGreaterThan(80);
    expect(allViolations).toEqual([]);
  });

  it('verifies eink.css defines strict 1-bit #FFFFFF/#000000 overrides and global guard', () => {
    const einkCss = ALL_UI_STYLESHEETS['../theme/eink.css'] ?? '';
    expect(einkCss.length).toBeGreaterThan(100);
    const decls = parseCssDeclarations(einkCss, 'theme/eink.css');

    const rootProps = new Map<string, string>();
    const starProps = new Map<string, string>();

    for (const d of decls) {
      if (d.selectorPath.includes(':root[data-eink="1"]') && !d.selectorPath.includes('*') && !d.selectorPath.includes('button')) {
        rootProps.set(d.property, d.value);
      }
      if (d.selectorPath.includes(':root[data-eink="1"] *')) {
        starProps.set(d.property, d.value);
      }
    }

    expect(rootProps.get('--mb-bg')).toMatch(/^#FFFFFF/i);
    expect(rootProps.get('--mb-fg')).toMatch(/^#000000/i);
    expect(rootProps.get('--mb-fg-quiet')).toMatch(/^#000000/i);
    expect(rootProps.get('--mb-line')).toMatch(/^#000000/i);
    expect(rootProps.get('--mb-accent')).toMatch(/^#000000/i);
    expect(rootProps.get('--mb-shadow')).toMatch(/^none/i);
    expect(rootProps.get('--mb-scrim')).toMatch(/^transparent/i);
    expect(rootProps.get('--mb-radius')).toMatch(/^0px/i);
    expect(rootProps.get('--mb-dur')).toMatch(/^0s/i);
    expect(rootProps.get('--mb-hl-sentence')).toMatch(/^transparent/i);
    expect(rootProps.get('--mb-hl-word-underline')).toMatch(/^none/i);

    expect(starProps.get('transition')).toContain('none');
    expect(starProps.get('animation')).toContain('none');
    expect(starProps.get('box-shadow')).toContain('none');
    expect(starProps.get('backdrop-filter')).toContain('none');
    expect(starProps.get('filter')).toContain('none');
    expect(starProps.get('opacity')).toContain('1');
    expect(starProps.get('border-radius')).toContain('0');
  });

  it('catches simulated CSS violations reliably', () => {
    const badCss = `
      .bad-card {
        border-radius: 12px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        transition: transform 200ms ease;
        opacity: 0.6;
        background: linear-gradient(90deg, #fff, #000);
      }
    `;
    const decls = parseCssDeclarations(badCss, 'bad.css');
    const violations = lintComponentCssDeclarations(decls);
    expect(violations.length).toBeGreaterThanOrEqual(5);
  });
});
