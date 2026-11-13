/**
 * Faithful pure-TS port of `misaki==0.9.4` `ZHG2P(version='1.1')` (`ZHFrontend` + `ZHG2P.__call__`),
 * preserving exact word-level UTF-16 ranges via `TrackedText` (`TTS_V2_SPEC.md` §4.1, §4.3).
 */
import { transformAn2cnTracked } from './cn2an.js';
import type { EnPhonemizeOutput, PhonemePiece } from './en-g2p.js';
import type { Jieba } from './jieba.js';
import { TrackedText } from './offset-text.js';
import type { Pinyin } from './pinyin.js';
import { ToneSandhi, type MisakiZhTables, type SpannedPosToken } from './tone-sandhi.js';

const PY_WS = /^[\t\n\x0b\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/;

const PUNCT_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ['、', ', '],
  ['，', ', '],
  ['。', '. '],
  ['．', '. '],
  ['！', '! '],
  ['：', ': '],
  ['；', '; '],
  ['？', '? '],
  ['«', ' “'],
  ['»', '” '],
  ['《', ' “'],
  ['》', '” '],
  ['「', ' “'],
  ['」', '” '],
  ['【', ' “'],
  ['】', '” '],
  ['（', ' ('],
  ['）', ') '],
];

function isXEng(pos: string): boolean {
  return pos === 'x' || pos === 'eng';
}

export type EnTrackedCallable = (
  enTracked: TrackedText,
) => EnPhonemizeOutput | string;

export interface ZHG2POptions {
  readonly jieba: Jieba;
  readonly pinyin: Pinyin;
  readonly tables: MisakiZhTables;
  readonly unk?: string;
  readonly enCallable?: EnTrackedCallable | null;
}

interface FrontendToken {
  text: string;
  tag: string;
  phonemes: string | null;
  whitespace: string;
  start: number;
  end: number;
}

export class ZHG2P {
  private readonly jieba: Jieba;
  private readonly py: Pinyin;
  private readonly unk: string;
  private readonly enCallable: EnTrackedCallable | null;
  private readonly map: Readonly<Record<string, string>>;
  private readonly punc: Set<string>;
  private readonly mustErhua: Set<string>;
  private readonly notErhua: Set<string>;
  private readonly sandhi: ToneSandhi;

  constructor(options: ZHG2POptions) {
    this.jieba = options.jieba;
    this.py = options.pinyin;
    this.unk = options.unk ?? '❓';
    this.enCallable = options.enCallable ?? null;
    this.map = options.tables.map;
    this.punc = new Set(Array.from(';:,.!?—…"()“”'));
    this.mustErhua = new Set(options.tables.must_erhua);
    this.notErhua = new Set(options.tables.not_erhua);
    this.sandhi = new ToneSandhi(options.jieba, options.pinyin, options.tables);
  }

  static mapPunctuationTracked(input: TrackedText): TrackedText {
    let cur = input;
    for (const [a, b] of PUNCT_REPLACEMENTS) {
      cur = cur.replaceLiteralAll(a, b);
    }
    return cur.trim();
  }

  static mapPunctuation(text: string): string {
    return ZHG2P.mapPunctuationTracked(TrackedText.fromRaw(text)).text;
  }

  private getInitialsFinals(word: string): [string[], string[]] {
    const [ini, fin] = this.py.initialsFinals(word);
    const cs = Array.from(word);
    for (let i = 0; i < cs.length; i++) {
      if (cs[i] === '嗯') fin[i] = 'n2';
    }
    const len = Math.min(ini.length, fin.length);
    for (let i = 0; i < len; i++) {
      const c = ini[i]!;
      let v = fin[i]!;
      if (/^i\d/.test(v)) {
        if (c === 'z' || c === 'c' || c === 's') {
          v = v.replace(/i/g, 'ii');
        } else if (c === 'zh' || c === 'ch' || c === 'sh' || c === 'r') {
          v = v.replace(/i/g, 'iii');
        }
      }
      fin[i] = v;
    }
    return [ini, fin];
  }

  private mergeErhua(
    initials: string[],
    finals: string[],
    word: string,
    pos: string,
  ): [string[], string[]] {
    const w = Array.from(word);
    for (let i = 0; i < finals.length; i++) {
      if (i === finals.length - 1 && w[i] === '儿' && finals[i] === 'er1') {
        finals[i] = 'er2';
      }
    }
    if (
      !this.mustErhua.has(word) &&
      (this.notErhua.has(word) || pos === 'a' || pos === 'j' || pos === 'nr')
    ) {
      return [initials, finals];
    }
    if (finals.length !== w.length) {
      return [initials, finals];
    }
    const ni: string[] = [];
    const nf: string[] = [];
    const tail2 = w.slice(-2).join('');
    for (let i = 0; i < finals.length; i++) {
      const phn = finals[i]!;
      if (
        i === finals.length - 1 &&
        w[i] === '儿' &&
        (phn === 'er2' || phn === 'er5') &&
        !this.notErhua.has(tail2) &&
        nf.length > 0
      ) {
        const p = nf[nf.length - 1]!;
        nf[nf.length - 1] = `${p.slice(0, -1)}R${p.slice(-1)}`;
      } else {
        ni.push(initials[i]!);
        nf.push(phn);
      }
    }
    return [ni, nf];
  }

  frontendTracked(zhSlice: TrackedText): EnPhonemizeOutput {
    const rawSeg = this.jieba.posCut(zhSlice.text);
    const spanned: SpannedPosToken[] = [];
    let cursor = 0;
    for (const [word, pos] of rawSeg) {
      const start = cursor;
      const end = cursor + word.length;
      spanned.push({ word, pos, start, end });
      cursor = end;
    }

    const seg = this.sandhi.preMergeForModify(spanned);
    const tokens: FrontendToken[] = [];

    for (const item of seg) {
      const word = item.word;
      let pos = item.pos;
      if (pos === 'x') {
        const cs = Array.from(word);
        if (cs.length > 0) {
          let mnCp = cs[0]!.codePointAt(0) ?? 0;
          let mxCp = mnCp;
          for (const c of cs) {
            const cp = c.codePointAt(0) ?? 0;
            if (cp < mnCp) mnCp = cp;
            if (cp > mxCp) mxCp = cp;
          }
          if (mnCp >= 0x4e00 && mxCp <= 0x9fff) {
            pos = 'X';
          }
        }
      } else if (this.punc.has(word)) {
        pos = 'x';
      }

      const tk: FrontendToken = {
        text: word,
        tag: pos,
        phonemes: null,
        whitespace: '',
        start: item.start,
        end: item.end,
      };

      if (pos === 'x' || pos === 'eng') {
        if (!PY_WS.test(word)) {
          if (pos === 'x' && this.punc.has(word)) {
            tk.phonemes = word;
          }
          tokens.push(tk);
        } else if (tokens.length > 0) {
          tokens[tokens.length - 1]!.whitespace += word;
        }
        continue;
      } else if (
        tokens.length > 0 &&
        !isXEng(tokens[tokens.length - 1]!.tag) &&
        !tokens[tokens.length - 1]!.whitespace
      ) {
        tokens[tokens.length - 1]!.whitespace = '/';
      }

      let [ini, fin] = this.getInitialsFinals(word);
      fin = this.sandhi.modifiedTone(word, pos, fin);
      [ini, fin] = this.mergeErhua(ini, fin, word, pos);

      const phones: string[] = [];
      const count = Math.min(ini.length, fin.length);
      for (let i = 0; i < count; i++) {
        const c = ini[i]!;
        const v = fin[i]!;
        if (c) phones.push(c);
        if (v && (!this.punc.has(v) || v !== c)) phones.push(v);
      }

      const parts = phones
        .join('_')
        .replaceAll('_eR', '_er')
        .replaceAll('R', '_R')
        .replace(/(?=\d)/g, '_')
        .split('_');

      tk.phonemes = parts
        .map((p) => (Object.prototype.hasOwnProperty.call(this.map, p) ? this.map[p]! : this.unk))
        .join('');
      tokens.push(tk);
    }

    const pieces: PhonemePiece[] = [];
    for (const t of tokens) {
      const ph = t.phonemes === null ? this.unk : t.phonemes;
      if (!isXEng(t.tag) && ph) {
        const raw = zhSlice.rawRange(t.start, t.end);
        pieces.push({ phonemes: ph, c0: raw.c0, c1: raw.c1 });
      } else if (ph) {
        pieces.push({ phonemes: ph });
      }
      if (t.whitespace) {
        pieces.push({ phonemes: t.whitespace });
      }
    }

    const phonemes = pieces.map((p) => p.phonemes).join('');
    return { phonemes, pieces };
  }

  spansTracked(
    input: TrackedText,
  ): Array<{ readonly kind: 'zh' | 'en'; readonly tracked: TrackedText }> {
    const mapped = ZHG2P.mapPunctuationTracked(transformAn2cnTracked(input));
    const out: Array<{ readonly kind: 'zh' | 'en'; readonly tracked: TrackedText }> = [];
    for (const m of mapped.text.matchAll(/([A-Za-z '-]*[A-Za-z][A-Za-z '-]*)|([^A-Za-z]+)/g)) {
      const mStart = m.index ?? 0;
      const mEnd = mStart + m[0].length;
      const sub = mapped.slice(mStart, mEnd).trim();
      if (!sub.text) continue;
      if (m[2] !== undefined && m[2].trim()) {
        out.push({ kind: 'zh', tracked: sub });
      } else {
        out.push({ kind: 'en', tracked: sub });
      }
    }
    return out;
  }

  g2pTracked(input: TrackedText, enCallable: EnTrackedCallable | null = this.enCallable): EnPhonemizeOutput {
    if (!input.text.trim()) {
      return { phonemes: '', pieces: [] };
    }
    const spans = this.spansTracked(input);
    const pieces: PhonemePiece[] = [];

    spans.forEach((sp, idx) => {
      if (idx > 0) {
        pieces.push({ phonemes: ' ' });
      }
      if (sp.kind === 'zh') {
        const zhOut = this.frontendTracked(sp.tracked);
        pieces.push(...zhOut.pieces);
      } else if (enCallable) {
        const enOut = enCallable(sp.tracked);
        if (typeof enOut === 'string') {
          const raw = sp.tracked.rawRange(0, sp.tracked.text.length);
          pieces.push({ phonemes: enOut, c0: raw.c0, c1: raw.c1 });
        } else {
          pieces.push(...enOut.pieces);
        }
      } else {
        pieces.push({ phonemes: this.unk });
      }
    });

    const phonemes = pieces.map((p) => p.phonemes).join('');
    return { phonemes, pieces };
  }

  g2p(text: string, enCallable: EnTrackedCallable | null = this.enCallable): string {
    return this.g2pTracked(TrackedText.fromRaw(text), enCallable).phonemes;
  }
}
