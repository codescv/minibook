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

/**
 * Decodes CSS Syntax Level 3 §4.3.7 backslash escapes (`\75 rl` -> `url`, `\000065` -> `e`, `\:`)
 * while preserving escaped quotes (`\"`, `\'`) inside string literals so string boundaries stay intact.
 */
export function unescapeCssTokens(input: string): string {
  if (!input.includes('\\')) return input;
  let out = '';
  let i = 0;
  let quote = 0;
  const n = input.length;

  while (i < n) {
    const ch = input.charCodeAt(i);
    if (ch === 0x22 || ch === 0x27) {
      if (quote === 0) quote = ch;
      else if (quote === ch) quote = 0;
      out += input[i]!;
      i++;
      continue;
    }

    if (ch === 0x5c && i + 1 < n) {
      const nextChar = input[i + 1]!;
      // Line continuation inside quoted string (`\\\n`, `\\\r\n`)
      if (quote !== 0 && (nextChar === '\n' || nextChar === '\r')) {
        i += 2;
        if (nextChar === '\r' && input[i] === '\n') i++;
        continue;
      }
      // Preserve escaped matching quote inside string literal
      if (quote !== 0 && input.charCodeAt(i + 1) === quote) {
        out += '\\' + nextChar;
        i += 2;
        continue;
      }
      // Hex escape `\<1-6 hex digits><optional single whitespace>`
      let hexEnd = i + 1;
      while (hexEnd < n && hexEnd - (i + 1) < 6 && /[0-9a-fA-F]/.test(input[hexEnd]!)) {
        hexEnd++;
      }
      if (hexEnd > i + 1) {
        const cp = Number.parseInt(input.slice(i + 1, hexEnd), 16);
        // Consume optional single trailing whitespace (`\r\n` counts as one)
        if (hexEnd < n) {
          if (input[hexEnd] === '\r' && input[hexEnd + 1] === '\n') hexEnd += 2;
          else if (input[hexEnd] === ' ' || input[hexEnd] === '\t' || input[hexEnd] === '\n' || input[hexEnd] === '\f') {
            hexEnd += 1;
          }
        }
        const safeCp = cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? 0xfffd : cp;
        const decoded = String.fromCodePoint(safeCp);
        if (quote !== 0 && decoded.charCodeAt(0) === quote) {
          out += '\\' + decoded;
        } else {
          out += decoded;
        }
        i = hexEnd;
        continue;
      }

      // Single escaped character (`\u` when non-hex, `\:`, `\(`, etc.)
      out += nextChar;
      i += 2;
      continue;
    }

    out += input[i]!;
    i++;
  }
  return out;
}

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
        preludeEnd = i;
        terminator = '{';
        i++;
        break;
      }
      if (parenDepth === 0 && isAt && c === 0x3b) {
        preludeEnd = i;
        terminator = ';';
        i++;
        break;
      }
      i++;
    }

    const prelude = unescapeCssTokens(css.slice(start, preludeEnd).trim());
    if (terminator === ';') {
      if (prelude) items.push({ kind: 'at', prelude, block: null });
      continue;
    }
    if (terminator === 'eof') {
      break;
    }

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

/**
 * Rewrites `url(...)` and `src(...)` tokens inside an already-unescaped CSS declaration value.
 */
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

    const restLower = value.slice(i, i + 4).toLowerCase();
    if (
      (restLower === 'url(' || restLower === 'src(') &&
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

/**
 * Converts bare quoted string URLs at depth 1 inside `image-set("foo.png" 1x)` /
 * `-webkit-image-set(...)` / `-moz-image-set(...)` / `cross-fade(...)` into `url("foo.png")`
 * (leaving nested `url(...)`, `src(...)`, `type("image/avif")`, `format(...)` untouched)
 * so `rewriteCssUrls` resolves every resource URL in a single unified pass (`[P1-C3]`).
 */
function normalizeBareUrlsInCssFunctions(value: string): string {
  if (!/(?:image-set|cross-fade)\s*\(/i.test(value)) {
    return value;
  }

  const fnRegex = /(?:-(?:webkit|moz)-)?(?:image-set|cross-fade)\s*\(/gi;
  let out = '';
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = fnRegex.exec(value)) !== null) {
    const fnStart = match.index;
    if (fnStart < cursor) continue;
    if (fnStart > 0 && /[a-zA-Z0-9_-]/.test(value[fnStart - 1]!)) {
      continue;
    }

    out += value.slice(cursor, fnStart + match[0].length);
    let i = fnStart + match[0].length;
    let depth = 1;

    while (i < value.length && depth > 0) {
      const ch = value.charCodeAt(i);
      if (ch === 0x22 || ch === 0x27) {
        const quoteChar = ch;
        let j = i + 1;
        let rawInner = '';
        while (j < value.length) {
          const c = value.charCodeAt(j);
          if (c === 0x5c && j + 1 < value.length) {
            rawInner += value[j]! + value[j + 1]!;
            j += 2;
            continue;
          }
          if (c === quoteChar) {
            j++;
            break;
          }
          rawInner += value[j]!;
          j++;
        }
        if (depth === 1) {
          // Bare string URL argument to `image-set(...)` or `cross-fade(...)` -> wrap in `url(...)`
          const qStr = String.fromCharCode(quoteChar);
          out += `url(${qStr}${rawInner}${qStr})`;
        } else {
          out += value.slice(i, j);
        }
        i = j;
        continue;
      }

      if (ch === 0x28) {
        depth++;
      } else if (ch === 0x29) {
        depth--;
      }
      out += value[i]!;
      i++;
    }

    cursor = i;
    fnRegex.lastIndex = i;
  }

  out += value.slice(cursor);
  return out;
}

/**
 * Final belt-and-suspenders guard: rejects ANY CSS declaration value that still contains a
 * remote/unsafe scheme (`http:`, `https:`, `//`, `javascript:`, `vbscript:`, `file:`, or non-allowlisted `data:`),
 * regardless of what CSS function or syntax wrapped it (`[P1-C3]`).
 */
function containsDisallowedUrlToken(unescapedVal: string): boolean {
  if (/(?:https?:|javascript:|vbscript:|file:|ftp:|blob:)/i.test(unescapedVal)) {
    return true;
  }
  // Protocol-relative `//host` inside quotes or `(`
  if (/(?:["'(\s])\/\/[a-zA-Z0-9._-]/.test(unescapedVal)) {
    return true;
  }
  if (/data:/i.test(unescapedVal)) {
    // Every `data:` URI present must match `isSafeDataImageUri`
    const dataMatches = unescapedVal.match(/data:[^"')\s,]+(?:,[^"')\s]*)?/gi) ?? [];
    for (const dm of dataMatches) {
      if (!isSafeDataImageUri(dm)) return true;
    }
  }
  return false;
}

function normalizeFontSizeValue(val: string): string {
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

  for (const rawDecl of decls) {
    const colonIdx = rawDecl.indexOf(':');
    if (colonIdx <= 0) continue;

    // Unescape CSS hex/character escapes BEFORE checking property names & function tokens (`[P1-C3]`)!
    let prop = unescapeCssTokens(rawDecl.slice(0, colonIdx)).trim().toLowerCase();
    let val = unescapeCssTokens(rawDecl.slice(colonIdx + 1)).trim();
    if (!prop || !val) continue;

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

    if (FORBIDDEN_COLUMN_PROPS.has(prop)) {
      continue;
    }

    if (
      (prop === 'writing-mode' || prop === '-webkit-writing-mode' || prop === '-epub-writing-mode') &&
      /vertical|tb|sideways/i.test(val)
    ) {
      continue;
    }

    let important = false;
    if (/!\s*important\s*$/i.test(val)) {
      val = val.replace(/!\s*important\s*$/i, '').trim();
      if (!USER_OWNED_IMPORTANT_PROPS.has(prop)) {
        important = true;
      }
    }

    if (prop === 'position' && /^(?:fixed|sticky)$/i.test(val)) {
      val = 'static';
    }

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

    // Normalize bare string URLs inside `image-set(...)` / `cross-fade(...)` into `url(...)`
    // so `rewriteCssUrls` resolves them in one pass without double-rewriting `mb-res:...`!
    if (/(?:image-set|cross-fade)\s*\(/i.test(val)) {
      val = normalizeBareUrlsInCssFunctions(val);
    }

    if (/(?:url|src)\s*\(/i.test(val)) {
      if (isFontFace && prop === 'src') {
        const parts = val.split(',');
        const validParts: string[] = [];
        for (const p of parts) {
          if (/(?:url|src)\s*\(/i.test(p)) {
            const rw = rewriteCssUrls(p, basePath, resolver, resources);
            if (!rw.hadRemovedRemoteUrl && rw.rewritten.trim()) {
              validParts.push(rw.rewritten.trim());
            }
          } else if (/local\s*\(/i.test(p) && !containsDisallowedUrlToken(p)) {
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

    // Final belt-and-suspenders guard against any surviving remote URL!
    if (containsDisallowedUrlToken(val)) {
      continue;
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
        if (!resolved || !resolved.path) continue;
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

    if (item.block !== null && item.prelude) {
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
