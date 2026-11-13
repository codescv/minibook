import { isSafeDataImageUri, resolveArchiveHref } from '../util/path.js';

export interface CssSanitizeOptions {
  /** Archive path of the stylesheet (or XHTML document for inline styles), e.g. `OEBPS/Styles/main.css`. */
  readonly basePath: string;
  /** Optional loader for local `@import` sheets (`depth <= 4`). */
  readonly loadSheet?: (archivePath: string) => Promise<string | null>;
  /** Custom resource URL resolver (defaults to `mb-res:<resolvedArchivePath>`). */
  readonly resolveResourceUrl?: (rawUrl: string, basePath: string) => { placeholder: string; resourcePath?: string } | null;
  /** Collected archive resource paths referenced via `mb-res:<path>`. */
  readonly resources: Set<string>;
  readonly depth?: number;
}

const USER_OWNED_IMPORTANT_PROPS = new Set([
  'color',
  'background',
  'background-color',
  'font-family',
  'font-size',
  'line-height',
  'text-align',
  'hyphens',
  '-webkit-hyphens',
  'widows',
  'orphans',
]);

const FORBIDDEN_COLUMN_PROPS = new Set([
  'columns',
  'column-width',
  'column-count',
  'column-gap',
  'column-rule',
  'column-rule-color',
  'column-rule-style',
  'column-rule-width',
  'column-span',
  'column-fill',
  '-webkit-columns',
  '-webkit-column-width',
  '-webkit-column-count',
  '-webkit-column-gap',
]);

function defaultResolveResource(
  rawUrl: string,
  basePath: string,
): { placeholder: string; resourcePath?: string } | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  if (isSafeDataImageUri(trimmed)) {
    return { placeholder: trimmed };
  }
  if (trimmed.startsWith('#')) {
    return { placeholder: trimmed };
  }
  const resolved = resolveArchiveHref(basePath, trimmed);
  if (!resolved || !resolved.path) return null;
  const suffix = resolved.fragment ? `#${resolved.fragment}` : '';
  return {
    placeholder: `mb-res:${resolved.path}${suffix}`,
    resourcePath: resolved.path,
  };
}

function stripCssComments(css: string): string {
  let out = '';
  let i = 0;
  let quote = 0;
  while (i < css.length) {
    const ch = css.charCodeAt(i);
    if (quote !== 0) {
      out += css[i]!;
      if (ch === 0x5c && i + 1 < css.length) {
        out += css[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === quote) quote = 0;
      i++;
      continue;
    }
    if (ch === 0x22 || ch === 0x27) {
      quote = ch;
      out += css[i]!;
      i++;
      continue;
    }
    if (ch === 0x2f && css.charCodeAt(i + 1) === 0x2a) {
      const end = css.indexOf('*/', i + 2);
      if (end < 0) break;
      out += ' ';
      i = end + 2;
      continue;
    }
    out += css[i]!;
    i++;
  }
  return out;
}

interface TopLevelCssItem {
  readonly kind: 'at' | 'rule';
  readonly prelude: string;
  readonly block: string | null;
}

function parseTopLevelCss(input: string): TopLevelCssItem[] {
  const css = stripCssComments(input);
  const items: TopLevelCssItem[] = [];
  let i = 0;
  const n = css.length;

  const skipWs = () => {
    while (i < n && /\s/.test(css[i]!)) i++;
  };

  while (i < n) {
    skipWs();
    if (i >= n) break;
    // Skip stray `}` or `;`
    if (css[i] === '}' || css[i] === ';') {
      i++;
      continue;
    }

    const start = i;
    const isAt = css[i] === '@';
    let quote = 0;
    let parenDepth = 0;
    let preludeEnd = n;
    let terminator: '{' | ';' | 'eof' = 'eof';

    while (i < n) {
      const c = css.charCodeAt(i);
      if (quote !== 0) {
        if (c === 0x5c && i + 1 < n) {
          i += 2;
          continue;
        }
        if (c === quote) quote = 0;
        i++;
        continue;
      }
      if (c === 0x22 || c === 0x27) {
        quote = c;
        i++;
        continue;
      }
      if (c === 0x28) {
        parenDepth++;
        i++;
        continue;
      }
      if (c === 0x29) {
        if (parenDepth > 0) parenDepth--;
        i++;
        continue;
      }
      if (parenDepth === 0 && c === 0x7b) {
        // `{`
        preludeEnd = i;
        terminator = '{';
        i++;
        break;
      }
      if (parenDepth === 0 && isAt && c === 0x3b) {
        // `;`
        preludeEnd = i;
        terminator = ';';
        i++;
        break;
      }
      i++;
    }

    const prelude = css.slice(start, preludeEnd).trim();
    if (terminator === ';') {
      if (prelude) items.push({ kind: 'at', prelude, block: null });
      continue;
    }
    if (terminator === 'eof') {
      break;
    }

    // Read balanced `{ ... }` block
    const blockStart = i;
    let braceDepth = 1;
    quote = 0;
    while (i < n && braceDepth > 0) {
      const c = css.charCodeAt(i);
      if (quote !== 0) {
        if (c === 0x5c && i + 1 < n) {
          i += 2;
          continue;
        }
        if (c === quote) quote = 0;
        i++;
        continue;
      }
      if (c === 0x22 || c === 0x27) {
        quote = c;
        i++;
        continue;
      }
      if (c === 0x7b) braceDepth++;
      else if (c === 0x7d) braceDepth--;
      i++;
    }
    const blockEnd = braceDepth === 0 ? i - 1 : i;
    const block = css.slice(blockStart, blockEnd);
    items.push({ kind: isAt ? 'at' : 'rule', prelude, block });
  }

  return items;
}

function splitDeclarations(block: string): string[] {
  const decls: string[] = [];
  let start = 0;
  let quote = 0;
  let parenDepth = 0;
  for (let i = 0; i < block.length; i++) {
    const c = block.charCodeAt(i);
    if (quote !== 0) {
      if (c === 0x5c && i + 1 < block.length) {
        i++;
        continue;
      }
      if (c === quote) quote = 0;
      continue;
    }
    if (c === 0x22 || c === 0x27) {
      quote = c;
      continue;
    }
    if (c === 0x28) {
      parenDepth++;
      continue;
    }
    if (c === 0x29) {
      if (parenDepth > 0) parenDepth--;
      continue;
    }
    if (parenDepth === 0 && c === 0x3b) {
      const part = block.slice(start, i).trim();
      if (part) decls.push(part);
      start = i + 1;
    }
  }
  const tail = block.slice(start).trim();
  if (tail) decls.push(tail);
  return decls;
}

function rewriteCssUrls(
  value: string,
  basePath: string,
  resolver: NonNullable<CssSanitizeOptions['resolveResourceUrl']>,
  resources: Set<string>,
): { readonly rewritten: string; readonly hadRemovedRemoteUrl: boolean } {
  let hadRemovedRemoteUrl = false;
  let out = '';
  let i = 0;
  const n = value.length;

  while (i < n) {
    // Match case-insensitive `url(` outside quotes
    const ch = value.charCodeAt(i);
    if (ch === 0x22 || ch === 0x27) {
      const q = ch;
      out += value[i++];
      while (i < n) {
        const c = value.charCodeAt(i);
        out += value[i++];
        if (c === 0x5c && i < n) {
          out += value[i++];
          continue;
        }
        if (c === q) break;
      }
      continue;
    }

    if (
      (ch === 0x75 || ch === 0x55) &&
      value.slice(i, i + 4).toLowerCase() === 'url(' &&
      (i === 0 || !/[a-zA-Z0-9_-]/.test(value[i - 1]!))
    ) {
      let j = i + 4;
      while (j < n && /\s/.test(value[j]!)) j++;
      let rawUrl = '';
      if (j < n && (value[j] === '"' || value[j] === "'")) {
        const q = value[j]!;
        j++;
        while (j < n && value[j] !== q) {
          if (value[j] === '\\' && j + 1 < n) {
            rawUrl += value[j + 1]!;
            j += 2;
          } else {
            rawUrl += value[j++]!;
          }
        }
        if (j < n && value[j] === q) j++;
        while (j < n && /\s/.test(value[j]!)) j++;
        if (j < n && value[j] === ')') j++;
      } else {
        while (j < n && value[j] !== ')') {
          rawUrl += value[j++]!;
        }
        if (j < n && value[j] === ')') j++;
      }

      const resolved = resolver(rawUrl.trim(), basePath);
      if (resolved) {
        if (resolved.resourcePath) resources.add(resolved.resourcePath);
        out += `url("${resolved.placeholder.replace(/"/g, '%22')}")`;
      } else {
        hadRemovedRemoteUrl = true;
      }
      i = j;
      continue;
    }

    out += value[i++]!;
  }

  return { rewritten: out, hadRemovedRemoteUrl };
}

function normalizeFontSizeValue(val: string): string {
  // Convert absolute `px` / `pt` font sizes to `em` so publisher CSS scales with user font-size (`§6.4`)
  return val.replace(/(^|\s)(\d+(?:\.\d+)?)(px|pt)\b/gi, (_m, lead: string, numStr: string, unit: string) => {
    const num = Number.parseFloat(numStr);
    if (!Number.isFinite(num) || num <= 0) return `${lead}1em`;
    const em = unit.toLowerCase() === 'pt' ? num / 12 : num / 16;
    const rounded = Math.round(em * 1000) / 1000;
    return `${lead}${rounded}em`;
  });
}

function sanitizeDeclarationsBlock(
  block: string,
  basePath: string,
  resolver: NonNullable<CssSanitizeOptions['resolveResourceUrl']>,
  resources: Set<string>,
  isFontFace = false,
): string {
  const decls = splitDeclarations(block);
  const kept: string[] = [];

  for (const decl of decls) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx <= 0) continue;
    let prop = decl.slice(0, colonIdx).trim().toLowerCase();
    let val = decl.slice(colonIdx + 1).trim();
    if (!prop || !val) continue;

    // Dangerous legacy CSS script vectors (`§5.2`)
    const lowerVal = val.toLowerCase();
    if (
      lowerVal.includes('expression(') ||
      lowerVal.includes('javascript:') ||
      lowerVal.includes('vbscript:') ||
      lowerVal.includes('-moz-binding') ||
      prop === 'behavior' ||
      prop === '-moz-binding'
    ) {
      continue;
    }

    // Forbidden multi-column properties (`§5.2`)
    if (FORBIDDEN_COLUMN_PROPS.has(prop)) {
      continue;
    }

    // Vertical writing-mode dropped in v1 (`§5.2`)
    if ((prop === 'writing-mode' || prop === '-webkit-writing-mode' || prop === '-epub-writing-mode') && /vertical|tb|sideways/i.test(val)) {
      continue;
    }

    // Strip `!important` from properties owned by the user stylesheet
    let important = false;
    if (/!\s*important\s*$/i.test(val)) {
      val = val.replace(/!\s*important\s*$/i, '').trim();
      if (!USER_OWNED_IMPORTANT_PROPS.has(prop)) {
        important = true;
      }
    }

    // `position: fixed | sticky` -> `static` (`§5.2`)
    if (prop === 'position' && /^(?:fixed|sticky)$/i.test(val)) {
      val = 'static';
    }

    // Page-break normalization (`§5.2`)
    if (prop === 'page-break-before' && /^(?:always|left|right|recto|verso)$/i.test(val)) {
      prop = 'break-before';
      val = 'column';
    } else if (prop === 'page-break-after' && /^(?:always|left|right|recto|verso)$/i.test(val)) {
      prop = 'break-after';
      val = 'column';
    } else if ((prop === 'break-before' || prop === 'break-after') && /^(?:page|left|right|recto|verso)$/i.test(val)) {
      val = 'column';
    }

    if (prop === 'font-size' && !isFontFace) {
      val = normalizeFontSizeValue(val);
    }

    if (/url\s*\(/i.test(val)) {
      if (isFontFace && prop === 'src') {
        // Filter comma-separated `@font-face src` items individually so removing a remote fallback preserves local fonts
        const parts = val.split(',');
        const validParts: string[] = [];
        for (const p of parts) {
          if (/url\s*\(/i.test(p)) {
            const rw = rewriteCssUrls(p, basePath, resolver, resources);
            if (!rw.hadRemovedRemoteUrl && rw.rewritten.trim()) {
              validParts.push(rw.rewritten.trim());
            }
          } else if (/local\s*\(/i.test(p)) {
            validParts.push(p.trim());
          }
        }
        if (validParts.length === 0) continue;
        val = validParts.join(', ');
      } else {
        const rw = rewriteCssUrls(val, basePath, resolver, resources);
        if (rw.hadRemovedRemoteUrl) continue;
        val = rw.rewritten.trim();
        if (!val) continue;
      }
    }

    kept.push(`${prop}: ${val}${important ? ' !important' : ''}`);
  }

  return kept.join('; ');
}

function extractImportTarget(prelude: string): { readonly url: string; readonly media: string } | null {
  const rest = prelude.replace(/^@import\b/i, '').trim();
  if (!rest) return null;

  if (/^url\s*\(/i.test(rest)) {
    const closeIdx = rest.indexOf(')');
    if (closeIdx < 0) return null;
    let inner = rest.slice(rest.indexOf('(') + 1, closeIdx).trim();
    if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
      inner = inner.slice(1, -1);
    }
    const media = rest.slice(closeIdx + 1).trim();
    return { url: inner.trim(), media };
  }

  if (rest.startsWith('"') || rest.startsWith("'")) {
    const q = rest[0]!;
    const endIdx = rest.indexOf(q, 1);
    if (endIdx < 0) return null;
    const inner = rest.slice(1, endIdx);
    const media = rest.slice(endIdx + 1).trim();
    return { url: inner.trim(), media };
  }

  return null;
}

/**
 * Tokenizes and sanitizes a publisher CSS stylesheet (`ARCHITECTURE.md` §5.2):
 *   - Resolves `@import` and `url(...)` against `options.basePath` (the stylesheet's own path!).
 *   - Inlines local `@import` up to depth 4; drops remote `@import`, `@page`, `@namespace`.
 *   - Rewrites `position: fixed|sticky`, `page-break-*`, absolute `px`/`pt` `font-size`, and strips `column-*`.
 */
export async function sanitizeStylesheet(
  rawCss: string,
  options: CssSanitizeOptions,
): Promise<string> {
  const depth = options.depth ?? 0;
  const resolver = options.resolveResourceUrl ?? defaultResolveResource;
  const items = parseTopLevelCss(rawCss);
  const outRules: string[] = [];

  for (const item of items) {
    if (item.kind === 'at') {
      const lowerPrelude = item.prelude.toLowerCase();
      if (lowerPrelude.startsWith('@import')) {
        if (depth >= 4 || !options.loadSheet) continue;
        const target = extractImportTarget(item.prelude);
        if (!target || !target.url) continue;
        const resolved = resolveArchiveHref(options.basePath, target.url);
        if (!resolved || !resolved.path) continue; // Remote `@import` dropped!
        const importedCss = await options.loadSheet(resolved.path);
        if (!importedCss) continue;
        const sanitizedImported = await sanitizeStylesheet(importedCss, {
          ...options,
          basePath: resolved.path,
          depth: depth + 1,
        });
        if (!sanitizedImported) continue;
        if (target.media) {
          outRules.push(`@media ${target.media} {\n${sanitizedImported}\n}`);
        } else {
          outRules.push(sanitizedImported);
        }
        continue;
      }

      // Drop `@page`, `@namespace`, `@charset`
      if (
        lowerPrelude.startsWith('@page') ||
        lowerPrelude.startsWith('@namespace') ||
        lowerPrelude.startsWith('@charset')
      ) {
        continue;
      }

      if (lowerPrelude.startsWith('@font-face') && item.block !== null) {
        const decls = sanitizeDeclarationsBlock(item.block, options.basePath, resolver, options.resources, true);
        if (decls) {
          outRules.push(`@font-face { ${decls}; }`);
        }
        continue;
      }

      if ((lowerPrelude.startsWith('@media') || lowerPrelude.startsWith('@supports')) && item.block !== null) {
        const nested = await sanitizeStylesheet(item.block, {
          ...options,
          depth: depth + 1,
        });
        if (nested) {
          outRules.push(`${item.prelude} {\n${nested}\n}`);
        }
        continue;
      }

      continue;
    }

    // Standard selector rule
    if (item.block !== null && item.prelude) {
      // Neutralize `html` / `body` selectors trying to set `overflow` or fixed viewport dimensions
      const decls = sanitizeDeclarationsBlock(item.block, options.basePath, resolver, options.resources, false);
      if (decls) {
        outRules.push(`${item.prelude} { ${decls}; }`);
      }
    }
  }

  return outRules.join('\n');
}

export function sanitizeInlineStyle(
  rawStyle: string,
  basePath: string,
  resources: Set<string>,
  resolveResourceUrl?: CssSanitizeOptions['resolveResourceUrl'],
): string {
  const resolver = resolveResourceUrl ?? defaultResolveResource;
  return sanitizeDeclarationsBlock(rawStyle, basePath, resolver, resources, false);
}
