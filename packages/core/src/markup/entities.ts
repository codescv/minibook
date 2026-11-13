/**
 * Predefined XML, numeric, and HTML5 named entity expansion (`ARCHITECTURE.md` §5.2).
 * Never evaluates custom DTD entities (preventing XXE & Billion Laughs).
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  shy: '\u00ad',
  zwj: '\u200d',
  zwnj: '\u200c',
  lrm: '\u200e',
  rlm: '\u200f',
  ndash: '\u2013',
  mdash: '\u2014',
  horbar: '\u2015',
  lsquo: '\u2018',
  rsquo: '\u2019',
  sbquo: '\u201a',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bdquo: '\u201e',
  hellip: '\u2026',
  prime: '\u2032',
  Prime: '\u2033',
  lsaquo: '\u2039',
  rsaquo: '\u203a',
  laquo: '\u00ab',
  raquo: '\u00bb',
  bull: '\u2022',
  middot: '\u00b7',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  sect: '\u00a7',
  para: '\u00b6',
  dagger: '\u2020',
  Dagger: '\u2021',
  deg: '\u00b0',
  plusmn: '\u00b1',
  times: '\u00d7',
  divide: '\u00f7',
  minus: '\u2212',
   lowast: '\u2217',
  radic: '\u221a',
  infin: '\u221e',
  asymp: '\u2248',
  ne: '\u2260',
  equiv: '\u2261',
  le: '\u2264',
  ge: '\u2265',
  larr: '\u2190',
  uarr: '\u2191',
  rarr: '\u2192',
  darr: '\u2193',
  harr: '\u2194',
  sup1: '\u00b9',
  sup2: '\u00b2',
  sup3: '\u00b3',
  frac14: '\u00bc',
  frac12: '\u00bd',
  frac34: '\u00be',
  iexcl: '\u00a1',
  iquest: '\u00bf',
  cent: '\u00a2',
  pound: '\u00a3',
  yen: '\u00a5',
  euro: '\u20ac',
  Agrave: '\u00c0',
  Aacute: '\u00c1',
  Acirc: '\u00c2',
  Atilde: '\u00c3',
  Auml: '\u00c4',
  Aring: '\u00c5',
  AElig: '\u00c6',
  Ccedil: '\u00c7',
  Egrave: '\u00c8',
  Eacute: '\u00c9',
  Ecirc: '\u00ca',
  Euml: '\u00cb',
  Igrave: '\u00cc',
  Iacute: '\u00cd',
  Icirc: '\u00ce',
  Iuml: '\u00cf',
  Ntilde: '\u00d1',
  Ograve: '\u00d2',
  Oacute: '\u00d3',
  Ocirc: '\u00d4',
  Otilde: '\u00d5',
  Ouml: '\u00d6',
  Oslash: '\u00d8',
  Ugrave: '\u00d9',
  Uacute: '\u00da',
  Ucirc: '\u00db',
  Uuml: '\u00dc',
  Yacute: '\u00dd',
  szlig: '\u00df',
  agrave: '\u00e0',
  aacute: '\u00e1',
  acirc: '\u00e2',
  atilde: '\u00e3',
  auml: '\u00e4',
  aring: '\u00e5',
  aelig: '\u00e6',
  ccedil: '\u00e7',
  egrave: '\u00e8',
  eacute: '\u00e9',
  ecirc: '\u00ea',
  euml: '\u00eb',
  igrave: '\u00ec',
  iacute: '\u00ed',
  icirc: '\u00ee',
  iuml: '\u00ef',
  ntilde: '\u00f1',
  ograve: '\u00f2',
  oacute: '\u00f3',
  ocirc: '\u00f4',
  otilde: '\u00f5',
  ouml: '\u00f6',
  oslash: '\u00f8',
  ugrave: '\u00f9',
  uacute: '\u00fa',
  ucirc: '\u00fb',
  uuml: '\u00fc',
  yacute: '\u00fd',
  yuml: '\u00ff',
  oelig: '\u0153',
  OElig: '\u0152',
};

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return '\ufffd';
  if (cp >= 0xd800 && cp <= 0xdfff) return '\ufffd';
  if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) return '';
  return String.fromCodePoint(cp);
}

export function decodeEntities(input: string): string {
  if (input.indexOf('&') < 0) return input;
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (full, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return safeFromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) {
      return safeFromCodePoint(Number.parseInt(body.slice(1), 10));
    }
    const trimmed = body.trim();
    const mapped = NAMED_ENTITIES[trimmed] ?? NAMED_ENTITIES[trimmed.toLowerCase()];
    return mapped ?? full;
  });
}

export function escapeXmlText(text: string): string {
  return sanitizeXmlChars(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeXmlAttr(value: string): string {
  return sanitizeXmlChars(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Strips illegal XML 1.0 characters (`0x00..0x08`, `0x0B`, `0x0C`, `0x0E..0x1F`,
 * `0xFFFE`, `0xFFFF`, and unpaired UTF-16 surrogates) and normalizes `\r\n`/`\r` to `\n`.
 */
export function sanitizeXmlChars(str: string): string {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 0x0d) {
      if (i + 1 < str.length && str.charCodeAt(i + 1) === 0x0a) continue;
      out += '\n';
      continue;
    }
    if (c === 0x09 || c === 0x0a) {
      out += str[i]!;
      continue;
    }
    if (c < 0x20 || c === 0xfffe || c === 0xffff) {
      continue;
    }
    // High surrogate: verify valid low surrogate follows
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += str[i]! + str[i + 1]!;
        i++;
      }
      continue;
    }
    // Lone low surrogate
    if (c >= 0xdc00 && c <= 0xdfff) {
      continue;
    }
    out += str[i]!;
  }
  return out;
}
