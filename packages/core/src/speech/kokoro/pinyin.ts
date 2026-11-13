/**
 * Faithful pure-TS port of `pypinyin==0.55.0` `lazy_pinyin` (`INITIALS` / `FINALS_TONE3`,
 * `strict=True`, `neutral_tone_with_five=True`) over exported tables (`TTS_V2_SPEC.md` §4.3).
 */
import { KOKORO_WORD_OVERRIDES } from './overrides.js';

export type SyllablePair = readonly [initial: string, finalTone3: string];

const RE_HAN_CHAR =
  /^[\u3007\ue815-\ue864\ufa18\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2A6DF}\u{2A703}-\u{2B73F}\u{2B740}-\u{2B81D}\u{2B825}-\u{2BF6E}\u{2C029}-\u{2CE93}\u{2D016}\u{2D11B}-\u{2EBD9}\u{2F80A}-\u{2FA1F}\u{300F2}-\u{31349}]$/u;

export interface PinyinOptions {
  readonly exact?: boolean;
  readonly wordOverrides?: Readonly<Record<string, string>>;
}

export class Pinyin {
  private readonly syl: readonly SyllablePair[];
  private readonly exact: boolean;
  private readonly chars: Map<string, number>;
  private readonly phrases: Map<string, string>;
  private readonly keys: readonly string[];
  private readonly maxLen: number;
  private readonly wordOverrides: Readonly<Record<string, string>>;

  constructor(
    syllables: readonly SyllablePair[],
    charsText: string,
    phrasesText: string,
    options?: PinyinOptions,
  ) {
    this.syl = syllables;
    this.exact = Boolean(options?.exact);
    this.wordOverrides = options?.wordOverrides ?? KOKORO_WORD_OVERRIDES;

    const chars = new Map<string, number>();
    for (const rawLine of charsText.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line) continue;
      const cp = line.codePointAt(0);
      if (cp === undefined) continue;
      const ch = String.fromCodePoint(cp);
      chars.set(ch, parseInt(line.slice(ch.length), 16));
    }
    this.chars = chars;

    const phrases = new Map<string, string>();
    let maxLen = 1;
    for (const rawLine of phrasesText.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line) continue;
      const sp = line.indexOf(' ');
      if (sp <= 0) continue;
      const ph = line.slice(0, sp);
      phrases.set(ph, line.slice(sp + 1));
      if (ph.length > maxLen) maxLen = ph.length;
    }
    this.phrases = phrases;
    this.maxLen = maxLen;
    this.keys = this.exact ? [...phrases.keys()].sort() : [];
  }

  private isPrefix(w: string): boolean {
    const k = this.keys;
    let lo = 0;
    let hi = k.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (k[mid]! < w) lo = mid + 1;
      else hi = mid;
    }
    return lo < k.length && k[lo]!.startsWith(w);
  }

  private emitPhrase(v: string, ini: string[], fin: string[]): void {
    for (const h of v.split(',')) {
      const s = this.syl[parseInt(h, 16)];
      if (s) {
        ini.push(s[0]);
        fin.push(s[1]);
      }
    }
  }

  private emitSingle(ch: string, ini: string[], fin: string[]): void {
    const v = this.phrases.get(ch);
    if (v !== undefined) {
      this.emitPhrase(v, ini, fin);
      return;
    }
    const id = this.chars.get(ch);
    const s = id !== undefined ? this.syl[id] : undefined;
    if (!s) {
      ini.push(ch);
      fin.push(ch);
    } else {
      ini.push(s[0]);
      fin.push(s[1]);
    }
  }

  initialsFinals(word: string): [initials: string[], finals: string[]] {
    const override = this.wordOverrides[word];
    if (override) {
      const parts = override.trim().split(/\s+/);
      const ini: string[] = [];
      const fin: string[] = [];
      for (const syl of parts) {
        const m = /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcs])?(.*)$/.exec(syl);
        ini.push(m?.[1] ?? '');
        fin.push(m?.[2] ?? syl);
      }
      return [ini, fin];
    }

    const cs = Array.from(word);
    const ini: string[] = [];
    const fin: string[] = [];
    let i = 0;
    const n = cs.length;

    while (i < n) {
      if (!RE_HAN_CHAR.test(cs[i]!)) {
        let j = i + 1;
        while (j < n && !RE_HAN_CHAR.test(cs[j]!)) j++;
        const run = cs.slice(i, j).join('');
        ini.push(run);
        fin.push(run);
        i = j;
        continue;
      }
      let end = i + 1;
      while (end < n && RE_HAN_CHAR.test(cs[end]!)) end++;

      if (this.exact) {
        while (i < end) {
          let validLen = 0;
          let broke = false;
          let w = '';
          for (let idx = 0; idx < end - i; idx++) {
            w += cs[i + idx]!;
            if (this.isPrefix(w)) {
              if (this.phrases.has(w)) validLen = idx + 1;
            } else {
              broke = true;
              break;
            }
          }
          if (validLen > 0) {
            const matched = this.phrases.get(cs.slice(i, i + validLen).join(''));
            if (matched !== undefined) this.emitPhrase(matched, ini, fin);
            i += validLen;
          } else if (broke) {
            this.emitSingle(cs[i]!, ini, fin);
            i++;
          } else {
            for (; i < end; i++) this.emitSingle(cs[i]!, ini, fin);
          }
        }
      } else {
        while (i < end) {
          let hit: string | null = null;
          let hl = 0;
          for (let L = Math.min(this.maxLen, end - i); L >= 2; L--) {
            const v = this.phrases.get(cs.slice(i, i + L).join(''));
            if (v !== undefined) {
              hit = v;
              hl = L;
              break;
            }
          }
          if (hit !== null) {
            this.emitPhrase(hit, ini, fin);
            i += hl;
          } else {
            this.emitSingle(cs[i]!, ini, fin);
            i++;
          }
        }
      }
    }

    return [ini, fin];
  }

  finalsTone3(word: string): string[] {
    const f = this.initialsFinals(word)[1];
    const cs = Array.from(word);
    for (let i = 0; i < cs.length; i++) {
      if (cs[i] === '嗯') f[i] = 'n2';
    }
    return f;
  }
}
