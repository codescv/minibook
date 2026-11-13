/**
 * Faithful pure-TS port of `misaki==0.9.4` US English `Lexicon` + stemmer + number expander
 * (`TTS_V2_SPEC.md` §4.5), with exact word-level UTF-16 span tracking via `TrackedText`.
 */
import { TrackedText } from './offset-text.js';

export type EnLexiconEntry = string | Readonly<Record<string, string | null>>;
export type EnLexiconDict = Readonly<Record<string, EnLexiconEntry>>;

export interface PhonemePiece {
  readonly phonemes: string;
  readonly c0?: number;
  readonly c1?: number;
}

export interface EnPhonemizeOutput {
  readonly phonemes: string;
  readonly pieces: readonly PhonemePiece[];
}

interface TokenContext {
  readonly futureVowel: boolean | null;
  readonly futureTo: boolean;
  readonly nextLower: boolean;
}

const STRESSES = 'ˌˈ';
const PRIMARY = 'ˈ';
const SECONDARY = 'ˌ';
const VOWELS = new Set('AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ');
const CONSONANTS = new Set('bdfhjklmnpstvwzðŋɡɹɾʃʒʤʧθ');
const US_TAUS = new Set('AIOWYiuæɑəɛɪɹʊʌ');
const DIPHTHONGS = new Set('AIOQWYʤʧ');
const PUNCTS = new Set(';:,.!?—…"“”');
const NON_QUOTE_PUNCTS = new Set(';:,.!?—…');
const JUNKS = new Set("',-._‘’/");
const SYMBOLS: Readonly<Record<string, string>> = {
  '%': 'percent',
  '&': 'and',
  '+': 'plus',
  '@': 'at',
};
const ORDINALS = new Set(['st', 'nd', 'rd', 'th']);

const isAlpha = (s: string): boolean => /^\p{L}+$/u.test(s);
const isLexChars = (s: string): boolean => /^['\-A-Za-z]*$/.test(s);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const hasAny = (ps: string, set: Set<string>): boolean => {
  for (const c of ps) if (set.has(c)) return true;
  return false;
};

const SUBTOKEN =
  /^['‘’]+|\p{Lu}(?=\p{Lu}\p{Ll})|(?:^-)?(?:\d?[,.]?\d)+|[-_]+|['‘’]{2,}|\p{L}*?(?:['‘’]\p{L})*?\p{Ll}(?=\p{Lu})|\p{L}+(?:['‘’]\p{L})*|[^-_\p{L}'‘’\d]|['‘’]+$/gu;

export function applyStress(ps: string | null, stress: number | null): string | null {
  const restress = (p: string): string => {
    const ips: Array<[number, string]> = Array.from(p).map((c, i) => [i, c]);
    for (let i = 0; i < ips.length; i++) {
      if (STRESSES.includes(ips[i]![1])) {
        let j = i;
        while (j < ips.length && !VOWELS.has(ips[j]![1])) j++;
        ips[i]![0] = j - 0.5;
      }
    }
    return ips
      .sort((a, b) => a[0] - b[0])
      .map((x) => x[1])
      .join('');
  };
  if (ps == null || stress == null) return ps;
  const hasP = ps.includes(PRIMARY);
  const hasS = ps.includes(SECONDARY);
  if (stress < -1) return ps.replaceAll(PRIMARY, '').replaceAll(SECONDARY, '');
  if (stress === -1 || ((stress === 0 || stress === -0.5) && hasP)) {
    return ps.replaceAll(SECONDARY, '').replaceAll(PRIMARY, SECONDARY);
  }
  if ((stress === 0 || stress === 0.5 || stress === 1) && !hasP && !hasS) {
    return hasAny(ps, VOWELS) ? restress(SECONDARY + ps) : ps;
  }
  if (stress >= 1 && !hasP && hasS) return ps.replaceAll(SECONDARY, PRIMARY);
  if (stress > 1 && !hasP && !hasS) return hasAny(ps, VOWELS) ? restress(PRIMARY + ps) : ps;
  return ps;
}

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
] as const;
const TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
] as const;
const ORD: Readonly<Record<string, string>> = {
  one: 'first',
  two: 'second',
  three: 'third',
  five: 'fifth',
  eight: 'eighth',
  nine: 'ninth',
  twelve: 'twelfth',
};

function cardinal(n: number): string[] {
  if (!Number.isFinite(n) || n < 0) return [];
  if (n < 20) return [ONES[n] ?? 'zero'];
  if (n < 100) return [TENS[Math.floor(n / 10)]!, ...(n % 10 ? [ONES[n % 10]!] : [])];
  if (n < 1000) {
    return [ONES[Math.floor(n / 100)]!, 'hundred', ...(n % 100 ? cardinal(n % 100) : [])];
  }
  const scales: ReadonlyArray<readonly [number, string]> = [
    [1e12, 'trillion'],
    [1e9, 'billion'],
    [1e6, 'million'],
    [1e3, 'thousand'],
  ];
  for (const [v, w] of scales) {
    if (n >= v) {
      return [...cardinal(Math.floor(n / v)), w, ...(n % v ? cardinal(n % v) : [])];
    }
  }
  return [];
}

function ordinalWords(n: number): string[] {
  const w = cardinal(n);
  if (w.length === 0) return w;
  const l = w[w.length - 1]!;
  w[w.length - 1] = ORD[l] ?? (l.endsWith('y') ? `${l.slice(0, -1)}ieth` : `${l}th`);
  return w;
}

function yearWords(n: number): string[] {
  if (n >= 2000 && n < 2010) return cardinal(n);
  const hi = Math.floor(n / 100);
  const lo = n % 100;
  if (lo === 0) return [...cardinal(hi), 'hundred'];
  return [...cardinal(hi), ...(lo < 10 ? ['oh', ONES[lo]!] : cardinal(lo))];
}

export function parseEnLexiconTsv(tsv: string): Record<string, EnLexiconEntry> {
  const out: Record<string, EnLexiconEntry> = {};
  for (const rawLine of tsv.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const tabIdx = line.indexOf('\t');
    if (tabIdx > 0) {
      const key = line.slice(0, tabIdx);
      const val = line.slice(tabIdx + 1);
      out[key] = val[0] === '{' ? (JSON.parse(val) as EnLexiconEntry) : val;
    }
  }
  return out;
}

export class EnG2P {
  private readonly golds: Map<string, EnLexiconEntry>;
  private readonly silvers: Map<string, EnLexiconEntry>;
  public fallback: ((word: string) => string | null) | null;
  private readonly unk: string;

  constructor(
    gold: EnLexiconDict,
    silver: EnLexiconDict,
    opts?: { readonly fallback?: ((word: string) => string | null) | null; readonly unk?: string },
  ) {
    const grow = (d: EnLexiconDict): Map<string, EnLexiconEntry> => {
      const m = new Map<string, EnLexiconEntry>();
      for (const k of Object.keys(d)) {
        if (k.length < 2) continue;
        const lo = k.toLowerCase();
        if (k === lo) {
          if (k !== cap(k)) m.set(cap(k), d[k]!);
        } else if (k === cap(lo)) {
          m.set(lo, d[k]!);
        }
      }
      for (const k of Object.keys(d)) m.set(k, d[k]!);
      return m;
    };
    this.golds = grow(gold);
    this.silvers = grow(silver);
    this.fallback = opts?.fallback ?? null;
    this.unk = opts?.unk ?? '❓';
  }

  getNNP(word: string): string | null {
    let ps = '';
    for (const c of word) {
      if (isAlpha(c)) {
        const p = this.golds.get(c.toUpperCase());
        if (p == null) return null;
        const val = typeof p === 'string' ? p : (p['DEFAULT'] ?? null);
        if (val == null) return null;
        ps += val;
      }
    }
    const stressed = applyStress(ps, 0) ?? '';
    const i = stressed.lastIndexOf(SECONDARY);
    return i < 0 ? stressed : stressed.slice(0, i) + PRIMARY + stressed.slice(i + 1);
  }

  isKnown(word: string): boolean {
    if (this.golds.has(word) || word in SYMBOLS || this.silvers.has(word)) return true;
    if (!isAlpha(word) || !isLexChars(word)) return false;
    if (word.length === 1) return true;
    if (word === word.toUpperCase() && this.golds.has(word.toLowerCase())) return true;
    return word.slice(1) === word.slice(1).toUpperCase();
  }

  lookup(
    rawWord: string,
    tag: string | null,
    stress: number | null,
    ctx: TokenContext | null,
  ): string | null {
    let word = rawWord;
    let isNNP: boolean | null = null;
    if (word === word.toUpperCase() && !this.golds.has(word)) {
      word = word.toLowerCase();
      isNNP = tag === 'NNP';
    }
    let entry: EnLexiconEntry | null | undefined = this.golds.get(word);
    if (entry == null && !isNNP) entry = this.silvers.get(word);
    let ps: string | null = null;
    if (entry != null) {
      if (typeof entry === 'string') {
        ps = entry;
      } else if (ctx && ctx.futureVowel === null && 'None' in entry) {
        ps = entry['None'] ?? null;
      } else {
        ps = tag != null && tag in entry ? (entry[tag] ?? null) : (entry['DEFAULT'] ?? null);
      }
    }
    if (ps == null || (isNNP && !ps.includes(PRIMARY))) {
      const n = this.getNNP(word);
      if (n != null) return n;
    }
    return applyStress(ps, stress);
  }

  private suffixS(stem: string | null): string | null {
    if (!stem) return null;
    const l = stem[stem.length - 1] ?? '';
    if ('ptkfθ'.includes(l)) return `${stem}s`;
    if ('szʃʒʧʤ'.includes(l)) return `${stem}ᵻz`;
    return `${stem}z`;
  }

  stemS(
    word: string,
    tag: string | null,
    stress: number | null,
    ctx: TokenContext | null,
  ): string | null {
    if (word.length < 3 || !word.endsWith('s')) return null;
    let stem: string;
    if (!word.endsWith('ss') && this.isKnown(word.slice(0, -1))) {
      stem = word.slice(0, -1);
    } else if (
      (word.endsWith("'s") || (word.length > 4 && word.endsWith('es') && !word.endsWith('ies'))) &&
      this.isKnown(word.slice(0, -2))
    ) {
      stem = word.slice(0, -2);
    } else if (word.length > 4 && word.endsWith('ies') && this.isKnown(`${word.slice(0, -3)}y`)) {
      stem = `${word.slice(0, -3)}y`;
    } else {
      return null;
    }
    return this.suffixS(this.lookup(stem, tag, stress, ctx));
  }

  private suffixEd(stem: string | null): string | null {
    if (!stem) return null;
    const l = stem[stem.length - 1] ?? '';
    if ('pkfθʃsʧ'.includes(l)) return `${stem}t`;
    if (l === 'd') return `${stem}ᵻd`;
    if (l !== 't') return `${stem}d`;
    if (stem.length < 2) return `${stem}ɪd`;
    if (US_TAUS.has(stem[stem.length - 2] ?? '')) return `${stem.slice(0, -1)}ɾᵻd`;
    return `${stem}ᵻd`;
  }

  stemEd(
    word: string,
    tag: string | null,
    stress: number | null,
    ctx: TokenContext | null,
  ): string | null {
    if (word.length < 4 || !word.endsWith('d')) return null;
    let stem: string;
    if (!word.endsWith('dd') && this.isKnown(word.slice(0, -1))) {
      stem = word.slice(0, -1);
    } else if (
      word.length > 4 &&
      word.endsWith('ed') &&
      !word.endsWith('eed') &&
      this.isKnown(word.slice(0, -2))
    ) {
      stem = word.slice(0, -2);
    } else {
      return null;
    }
    return this.suffixEd(this.lookup(stem, tag, stress, ctx));
  }

  private suffixIng(stem: string | null): string | null {
    if (!stem) return null;
    if (stem.length > 1 && stem[stem.length - 1] === 't' && US_TAUS.has(stem[stem.length - 2] ?? '')) {
      return `${stem.slice(0, -1)}ɾɪŋ`;
    }
    return `${stem}ɪŋ`;
  }

  stemIng(
    word: string,
    tag: string | null,
    stress: number | null,
    ctx: TokenContext | null,
  ): string | null {
    if (word.length < 5 || !word.endsWith('ing')) return null;
    let stem: string;
    if (word.length > 5 && this.isKnown(word.slice(0, -3))) {
      stem = word.slice(0, -3);
    } else if (this.isKnown(`${word.slice(0, -3)}e`)) {
      stem = `${word.slice(0, -3)}e`;
    } else if (
      word.length > 5 &&
      /([bcdgklmnprstvxz])\1ing$|cking$/.test(word) &&
      this.isKnown(word.slice(0, -4))
    ) {
      stem = word.slice(0, -4);
    } else {
      return null;
    }
    return this.suffixIng(this.lookup(stem, tag, stress, ctx));
  }

  private resolveGoldString(key: string, subKey?: string): string | null {
    const e = this.golds.get(key);
    if (e == null) return null;
    if (typeof e === 'string') return e;
    if (subKey && subKey in e) return e[subKey] ?? null;
    return e['DEFAULT'] ?? null;
  }

  getSpecialCase(word: string, stress: number | null, ctx: TokenContext): string | null {
    if (word in SYMBOLS) return this.lookup(SYMBOLS[word]!, null, null, ctx);
    if (
      word.replace(/^\.+|\.+$/g, '').includes('.') &&
      isAlpha(word.replaceAll('.', '')) &&
      Math.max(...word.split('.').map((x) => x.length)) < 3
    ) {
      return this.getNNP(word);
    }
    if (word === 'a') return 'ɐ';
    if (word === 'A') return ctx.nextLower ? 'ɐ' : 'ˈA';
    if (word === 'am' || word === 'Am' || word === 'AM') {
      if (ctx.futureVowel === null || word !== 'am' || (stress && stress > 0)) {
        return this.resolveGoldString('am');
      }
      return 'ɐm';
    }
    if (word === 'an' || word === 'An') return 'ɐn';
    if (word === 'I') return `${SECONDARY}I`;
    if (word === 'to' || word === 'To') {
      return ctx.futureVowel === null ? this.resolveGoldString('to') : ctx.futureVowel ? 'tʊ' : 'tə';
    }
    if (word === 'in' || word === 'In') return `${ctx.futureVowel === null ? PRIMARY : ''}ɪn`;
    if (word === 'the' || word === 'The') return ctx.futureVowel === true ? 'ði' : 'ðə';
    if (/^vs\.?$/i.test(word)) return this.lookup('versus', null, null, ctx);
    if (word === 'used' || word === 'Used' || word === 'USED') {
      return this.resolveGoldString('used', ctx.futureTo ? 'VBD' : 'DEFAULT');
    }
    return null;
  }

  getWord(
    rawWord: string,
    tag: string | null,
    stress: number | null,
    ctx: TokenContext,
  ): string | null {
    let word = rawWord;
    const sc = this.getSpecialCase(word, stress, ctx);
    if (sc != null) return sc;
    const wl = word.toLowerCase();
    if (
      word.length > 1 &&
      isAlpha(word.replaceAll("'", '')) &&
      word !== wl &&
      !this.golds.has(word) &&
      !this.silvers.has(word) &&
      (word === word.toUpperCase() || word.slice(1) === word.slice(1).toLowerCase()) &&
      (this.golds.has(wl) ||
        this.silvers.has(wl) ||
        this.stemS(wl, tag, stress, ctx) ||
        this.stemEd(wl, tag, stress, ctx) ||
        this.stemIng(wl, tag, stress, ctx))
    ) {
      word = wl;
    }
    if (this.isKnown(word)) return this.lookup(word, tag, stress, ctx);
    if (word.endsWith("s'") && this.isKnown(`${word.slice(0, -2)}'s`)) {
      return this.lookup(`${word.slice(0, -2)}'s`, tag, stress, ctx);
    }
    if (word.endsWith("'") && this.isKnown(word.slice(0, -1))) {
      return this.lookup(word.slice(0, -1), tag, stress, ctx);
    }
    return (
      this.stemS(word, tag, stress, ctx) ??
      this.stemEd(word, tag, stress, ctx) ??
      this.stemIng(word, tag, stress == null ? 0.5 : stress, ctx)
    );
  }

  getNumber(word: string): string | null {
    const m = /^(-?)([\d,]*)(?:\.(\d+))?([a-z']*)$/.exec(word);
    if (!m || (!m[2] && !m[3])) return null;
    const intPart = (m[2] ?? '').replaceAll(',', '');
    const fracPart = m[3];
    const suffix = m[4] ?? '';
    let words: string[];
    if (intPart && !fracPart && ORDINALS.has(suffix)) {
      words = ordinalWords(Number(intPart));
    } else if (!m[1] && !fracPart && intPart.length === 4 && !(m[2] ?? '').includes(',')) {
      words = yearWords(Number(intPart));
    } else {
      words = intPart ? cardinal(Number(intPart)) : [];
      if (fracPart) {
        words.push('point', ...Array.from(fracPart, (d) => ONES[Number(d)] ?? 'zero'));
      }
    }
    if (words.length === 0) return null;
    if (m[1]) words.unshift('minus');
    const ps = words.map((w) => this.lookup(w, null, w === 'point' ? -2 : null, null));
    if (ps.some((p) => p == null)) return null;
    let res: string | null = ps.join(' ');
    if (suffix === 's' || suffix === "'s") res = this.suffixS(res);
    return res;
  }

  lex(text: string, ctx: TokenContext): string | null {
    const word = text.replaceAll('‘', "'").replaceAll('’', "'").normalize('NFKC');
    const stress =
      word === word.toLowerCase() ? null : word === word.toUpperCase() ? 2 : 0.5;
    const ps = this.getWord(word, null, stress, ctx);
    if (ps != null) return ps;
    if (/\d/.test(word)) return this.getNumber(word);
    return null;
  }

  static tokenContext(ctx: TokenContext, ps: string | null, text: string): TokenContext {
    let vowel = ctx.futureVowel;
    if (ps) {
      for (const c of ps) {
        if (NON_QUOTE_PUNCTS.has(c)) {
          vowel = null;
          break;
        }
        if (VOWELS.has(c)) {
          vowel = true;
          break;
        }
        if (CONSONANTS.has(c)) {
          vowel = false;
          break;
        }
      }
    }
    return {
      futureVowel: vowel,
      futureTo: text === 'to' || text === 'To',
      nextLower: /^[a-z]/.test(text),
    };
  }

  private resolveGroup(
    subs: readonly string[],
    ctxRef: { ctx: TokenContext },
    fallbackOverride?: ((word: string) => string | null) | null,
  ): string {
    const activeFallback = fallbackOverride !== undefined ? fallbackOverride : this.fallback;
    const ph = new Array<string | null>(subs.length).fill(null);
    let left = 0;
    let right = subs.length;

    while (left < right) {
      const anyResolved = ph.slice(left, right).some((p) => p !== null);
      const text = subs.slice(left, right).join('');
      const ps = anyResolved ? null : this.lex(text, ctxRef.ctx);
      if (ps != null) {
        ph[left] = ps;
        for (let x = left + 1; x < right; x++) ph[x] = '';
        ctxRef.ctx = EnG2P.tokenContext(ctxRef.ctx, ps, text);
        right = left;
        left = 0;
      } else if (left + 1 < right) {
        left++;
      } else {
        right--;
        const subAtRight = subs[right]!;
        if (ph[right] === null) {
          if (Array.from(subAtRight).every((c) => JUNKS.has(c))) {
            ph[right] = '';
          } else {
            const fb = activeFallback ? activeFallback(subAtRight) : null;
            if (fb != null) ph[right] = fb;
          }
        }
        left = 0;
      }
    }

    const text = subs.join('');
    const kinds = new Set<number>();
    for (const c of text) {
      if (!JUNKS.has(c)) {
        kinds.add(isAlpha(c) ? 0 : /[0-9]/.test(c) ? 1 : 2);
      }
    }
    const prespace = text.includes('/') || kinds.size > 1;
    if (!prespace) {
      const idx: Array<[number, number, number]> = [];
      ph.forEach((p, i) => {
        if (p) {
          idx.push([
            p.includes(PRIMARY) ? 1 : 0,
            Array.from(p).reduce((a, c) => a + (DIPHTHONGS.has(c) ? 2 : 1), 0),
            i,
          ]);
        }
      });
      if (idx.length === 2 && Array.from(subs[idx[0]![2]]!).length === 1) {
        const target = idx[1]![2];
        ph[target] = applyStress(ph[target] ?? null, -0.5);
      } else if (
        idx.length >= 2 &&
        idx.reduce((a, x) => a + x[0], 0) > Math.floor((idx.length + 1) / 2)
      ) {
        idx.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
        for (const [, , i] of idx.slice(0, Math.floor(idx.length / 2))) {
          ph[i] = applyStress(ph[i] ?? null, -0.5);
        }
      }
    }

    let out = '';
    ph.forEach((p, i) => {
      if (p === null) {
        out += this.unk;
        return;
      }
      if (prespace && i > 0 && out && !/\s$/.test(out) && p) out += ' ';
      out += p;
    });
    return out;
  }

  g2pTracked(
    tracked: TrackedText,
    opts?: { readonly enableFallback?: boolean },
  ): EnPhonemizeOutput {
    type Item =
      | { type: 'w'; subs: string[]; start: number; end: number; ws: string }
      | { type: 'p'; ps: string; start: number; end: number; ws: string };

    const items: Item[] = [];
    const text = tracked.text;

    for (const m of text.matchAll(/(\S+)(\s*)/g)) {
      const chunkStart = m.index ?? 0;
      const wordChunk = m[1] ?? '';
      const trailingWs = m[2] ?? '';

      const subs: Array<{ text: string; start: number; end: number }> = [];
      for (const x of wordChunk.matchAll(SUBTOKEN)) {
        const subOff = chunkStart + (x.index ?? 0);
        const rawSub = x[0];
        const clitic = /^(.*\p{L})(n['’]t|['’](?:s|re|ve|ll|d|m))$/iu.exec(rawSub);
        if (clitic && clitic[1] && clitic[2]) {
          const splitAt = subOff + clitic[1].length;
          subs.push(
            { text: clitic[1], start: subOff, end: splitAt },
            { text: clitic[2], start: splitAt, end: subOff + rawSub.length },
          );
        } else {
          subs.push({ text: rawSub, start: subOff, end: subOff + rawSub.length });
        }
      }

      let cur: Extract<Item, { type: 'w' }> | null = null;
      const first = items.length;

      for (let k = 0; k < subs.length; k++) {
        const sObj = subs[k]!;
        const s = sObj.text;
        const isWordish = /[\p{L}\d]/u.test(s) || (cur !== null && /^[-_'‘’]+$/.test(s));
        if (isWordish) {
          if (!cur) {
            cur = { type: 'w', subs: [], start: sObj.start, end: sObj.end, ws: '' };
            items.push(cur);
          }
          cur.subs.push(s);
          cur.end = sObj.end;
          continue;
        }
        if (s === '.' && cur) {
          const w = `${cur.subs.join('')}.`;
          if (this.golds.has(w) || this.silvers.has(w)) {
            cur.subs = [w];
            cur.end = sObj.end;
            cur = null;
            continue;
          }
        }
        const hadWord = cur !== null || items.length > first;
        cur = null;
        let ps = '';
        if (s === '"') ps = hadWord ? '”' : '“';
        else if (PUNCTS.has(s) || s === '(' || s === ')') ps = s;
        else if (s === '-' || s === '–') ps = '—';
        items.push({ type: 'p', ps, start: sObj.start, end: sObj.end, ws: '' });
      }

      if (items.length > first) {
        items[items.length - 1]!.ws = trailingWs ? ' ' : '';
      }
      for (let i = first; i < items.length; i++) {
        const it = items[i]!;
        if (it.type === 'w') {
          while (it.subs.length > 1 && /^[-_'‘’]+$/.test(it.subs[it.subs.length - 1]!)) {
            const popped = it.subs.pop()!;
            it.end = Math.max(it.start + 1, it.end - popped.length);
          }
        }
      }
    }

    const ctxRef: { ctx: TokenContext } = {
      ctx: { futureVowel: null, futureTo: false, nextLower: false },
    };
    const fallbackOverride = opts?.enableFallback === false ? null : undefined;
    const outs = new Array<string>(items.length);

    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.type === 'p') {
        outs[i] = it.ps;
        ctxRef.ctx = EnG2P.tokenContext(ctxRef.ctx, it.ps, '');
      } else {
        outs[i] = this.resolveGroup(it.subs, ctxRef, fallbackOverride);
      }
    }

    const pieces: PhonemePiece[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const ph = (outs[i] ?? '').replaceAll('ɾ', 'T').replaceAll('ʔ', 't');
      if (it.type === 'w' && ph) {
        const raw = tracked.rawRange(it.start, it.end);
        pieces.push({ phonemes: ph, c0: raw.c0, c1: raw.c1 });
      } else if (ph) {
        pieces.push({ phonemes: ph });
      }
      const isLast = i === items.length - 1;
      if (it.ws && !isLast) {
        pieces.push({ phonemes: it.ws });
      }
    }

    while (pieces.length > 0 && /^\s+$/.test(pieces[0]!.phonemes)) {
      pieces.shift();
    }
    while (pieces.length > 0 && /^\s+$/.test(pieces[pieces.length - 1]!.phonemes)) {
      pieces.pop();
    }

    const phonemes = pieces.map((p) => p.phonemes).join('');
    return { phonemes, pieces };
  }

  g2p(text: string, opts?: { readonly enableFallback?: boolean }): string {
    return this.g2pTracked(TrackedText.fromRaw(text), opts).phonemes;
  }
}
