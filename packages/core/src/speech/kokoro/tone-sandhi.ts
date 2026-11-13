/**
 * Faithful pure-TS port of `misaki==0.9.4` `ToneSandhi` (`TTS_V2_SPEC.md` §4.1, §4.3),
 * preserving exact `[start, end)` UTF-16 character spans across word pre-merges.
 */
import type { Jieba } from './jieba.js';
import type { Pinyin } from './pinyin.js';

export interface MisakiZhTables {
  readonly map: Readonly<Record<string, string>>;
  readonly must_erhua: readonly string[];
  readonly not_erhua: readonly string[];
  readonly must_neural_tone_words: readonly string[];
  readonly must_not_neural_tone_words: readonly string[];
  readonly sandhi_punc: string;
  readonly numeric_chars: string;
}

export interface SpannedPosToken {
  word: string;
  pos: string;
  start: number;
  end: number;
}

const BU = '不';
const YI = '一';

function isXEng(pos: string): boolean {
  return pos === 'x' || pos === 'eng';
}

function lastChar(s: string): string {
  return s[s.length - 1] ?? '';
}

function setTone(finalStr: string, tone: string): string {
  return finalStr.slice(0, -1) + tone;
}

function allToneThree(finals: readonly string[]): boolean {
  return finals.length > 0 && finals.every((x) => x[x.length - 1] === '3');
}

export class ToneSandhi {
  private readonly jieba: Jieba;
  private readonly py: Pinyin;
  private readonly mustNeural: Set<string>;
  private readonly mustNotNeural: Set<string>;
  private readonly punc: string;
  private readonly numeric: Set<string>;

  constructor(jieba: Jieba, pinyin: Pinyin, tables: MisakiZhTables) {
    this.jieba = jieba;
    this.py = pinyin;
    this.mustNeural = new Set(tables.must_neural_tone_words);
    this.mustNotNeural = new Set(tables.must_not_neural_tone_words);
    this.punc = tables.sandhi_punc;
    this.numeric = new Set(Array.from(tables.numeric_chars));
  }

  private splitWord(word: string): [string, string] {
    const wl = this.jieba
      .cutForSearch(word)
      .map((w): [string, number] => [w, Array.from(w).length])
      .sort((a, b) => a[1] - b[1]);
    const firstEntry = wl[0];
    if (!firstEntry) return [word, ''];
    const first = firstEntry[0];
    const fl = firstEntry[1];
    const cs = Array.from(word);
    if (word.indexOf(first) === 0) {
      return [first, cs.slice(fl).join('')];
    }
    return [cs.slice(0, cs.length - fl).join(''), first];
  }

  private inMustNeural(word: string): boolean {
    return this.mustNeural.has(word) || this.mustNeural.has(Array.from(word).slice(-2).join(''));
  }

  private neuralSandhi(word: string, pos: string, finals: string[]): string[] {
    if (this.mustNotNeural.has(word)) return finals;
    const w = Array.from(word);
    const L = w.length;
    const pos0 = pos[0] ?? '';
    for (let j = 1; j < L; j++) {
      if (w[j] === w[j - 1] && 'nva'.includes(pos0) && finals[j] !== undefined) {
        finals[j] = setTone(finals[j]!, '5');
      }
    }
    const ge = w.indexOf('个');
    const lw = w[L - 1] ?? '';
    const fl = finals.length - 1;
    if (fl >= 0) {
      if (L >= 1 && '吧呢啊呐噻嘛吖嗨呐哦哒滴哩哟喽啰耶喔诶'.includes(lw)) {
        finals[fl] = setTone(finals[fl]!, '5');
      } else if (L >= 1 && '的地得'.includes(lw)) {
        finals[fl] = setTone(finals[fl]!, '5');
      } else if (L === 1 && '了着过'.includes(word) && (pos === 'ul' || pos === 'uz' || pos === 'ug')) {
        finals[fl] = setTone(finals[fl]!, '5');
      } else if (L > 1 && '们子'.includes(lw) && (pos === 'r' || pos === 'n')) {
        finals[fl] = setTone(finals[fl]!, '5');
      } else if (L > 1 && '上下'.includes(lw) && (pos === 's' || pos === 'l' || pos === 'f')) {
        finals[fl] = setTone(finals[fl]!, '5');
      } else if (L > 1 && '来去'.includes(lw) && '上下进出回过起开'.includes(w[L - 2] ?? '')) {
        finals[fl] = setTone(finals[fl]!, '5');
      } else if (
        (ge >= 1 &&
          finals[ge] !== undefined &&
          (this.numeric.has(w[ge - 1] ?? '') || '几有两半多各整每做是'.includes(w[ge - 1] ?? ''))) ||
        (word === '个' && ge >= 0 && finals[ge] !== undefined)
      ) {
        finals[ge] = setTone(finals[ge]!, '5');
      } else if (this.inMustNeural(word)) {
        finals[fl] = setTone(finals[fl]!, '5');
      }
    }

    const wl = this.splitWord(word);
    const k = Array.from(wl[0]).length;
    const fls: [string[], string[]] = [finals.slice(0, k), finals.slice(k)];
    wl.forEach((sw, idx) => {
      const f = fls[idx as 0 | 1];
      if (f.length > 0 && this.inMustNeural(sw)) {
        f[f.length - 1] = setTone(f[f.length - 1]!, '5');
      }
    });
    return fls[0].concat(fls[1]);
  }

  private buSandhi(word: string, finals: string[]): string[] {
    const w = Array.from(word);
    if (w.length === 3 && w[1] === BU && finals[1] !== undefined) {
      finals[1] = setTone(finals[1]!, '5');
    } else {
      for (let i = 0; i < w.length; i++) {
        if (w[i] === BU && i + 1 < w.length && lastChar(finals[i + 1] ?? '') === '4' && finals[i] !== undefined) {
          finals[i] = setTone(finals[i]!, '2');
        }
      }
    }
    return finals;
  }

  private yiSandhi(word: string, finals: string[]): string[] {
    const w = Array.from(word);
    if (w.includes(YI) && w.every((c) => c === YI || this.numeric.has(c))) {
      return finals;
    }
    if (w.length === 3 && w[1] === YI && w[0] === w[2] && finals[1] !== undefined) {
      finals[1] = setTone(finals[1]!, '5');
    } else if (word.startsWith('第一') && finals[1] !== undefined) {
      finals[1] = setTone(finals[1]!, '1');
    } else {
      for (let i = 0; i < w.length; i++) {
        if (w[i] === YI && i + 1 < w.length && finals[i] !== undefined) {
          const t = lastChar(finals[i + 1] ?? '');
          if (t === '4' || t === '5') {
            finals[i] = setTone(finals[i]!, '2');
          } else if (!this.punc.includes(w[i + 1] ?? '')) {
            finals[i] = setTone(finals[i]!, '4');
          }
        }
      }
    }
    return finals;
  }

  private threeSandhi(word: string, finals: string[]): string[] {
    const L = Array.from(word).length;
    if (L === 2 && allToneThree(finals) && finals[0] !== undefined) {
      finals[0] = setTone(finals[0]!, '2');
    } else if (L === 3) {
      const wl = this.splitWord(word);
      const k = Array.from(wl[0]).length;
      if (allToneThree(finals)) {
        if (k === 2 && finals[0] !== undefined && finals[1] !== undefined) {
          finals[0] = setTone(finals[0]!, '2');
          finals[1] = setTone(finals[1]!, '2');
        } else if (k === 1 && finals[1] !== undefined) {
          finals[1] = setTone(finals[1]!, '2');
        }
      } else {
        const fls: [string[], string[]] = [finals.slice(0, k), finals.slice(k)];
        for (let i = 0; i < 2; i++) {
          const sub = fls[i as 0 | 1];
          if (allToneThree(sub) && sub.length === 2 && sub[0] !== undefined) {
            sub[0] = setTone(sub[0]!, '2');
          } else if (
            i === 1 &&
            !allToneThree(sub) &&
            lastChar(sub[0] ?? '') === '3' &&
            fls[0].length > 0 &&
            lastChar(fls[0][fls[0].length - 1] ?? '') === '3'
          ) {
            const f0 = fls[0];
            f0[f0.length - 1] = setTone(f0[f0.length - 1]!, '2');
          }
        }
        finals = fls[0].concat(fls[1]);
      }
    } else if (L === 4) {
      const out: string[] = [];
      for (const sub of [finals.slice(0, 2), finals.slice(2)]) {
        if (allToneThree(sub) && sub[0] !== undefined) {
          sub[0] = setTone(sub[0]!, '2');
        }
        out.push(...sub);
      }
      finals = out;
    }
    return finals;
  }

  modifiedTone(word: string, pos: string, finals: string[]): string[] {
    finals = this.buSandhi(word, finals);
    finals = this.yiSandhi(word, finals);
    finals = this.neuralSandhi(word, pos, finals);
    finals = this.threeSandhi(word, finals);
    return finals;
  }

  private mergeBu(seg: SpannedPosToken[]): SpannedPosToken[] {
    const out: SpannedPosToken[] = [];
    for (let i = 0; i < seg.length; i++) {
      const cur = seg[i]!;
      let word = cur.word;
      let start = cur.start;
      const pos = cur.pos;
      if (!isXEng(pos) && i > 0 && seg[i - 1]!.word === BU) {
        word = seg[i - 1]!.word + word;
        start = seg[i - 1]!.start;
      }
      const nextPos = i + 1 < seg.length ? seg[i + 1]!.pos : null;
      if (word !== BU || nextPos === null || isXEng(nextPos)) {
        out.push({ word, pos, start, end: cur.end });
      }
    }
    return out;
  }

  private mergeYi(seg: SpannedPosToken[]): SpannedPosToken[] {
    let out: SpannedPosToken[] = [];
    let skip = false;
    for (let i = 0; i < seg.length; i++) {
      if (skip) {
        skip = false;
        continue;
      }
      const cur = seg[i]!;
      if (
        i - 1 >= 0 &&
        cur.word === YI &&
        i + 1 < seg.length &&
        seg[i - 1]!.word === seg[i + 1]!.word &&
        seg[i - 1]!.pos === 'v' &&
        !isXEng(seg[i + 1]!.pos)
      ) {
        const prev = out[out.length - 1]!;
        out[out.length - 1] = {
          word: prev.word + YI + seg[i + 1]!.word,
          pos: prev.pos,
          start: prev.start,
          end: seg[i + 1]!.end,
        };
        skip = true;
      } else {
        out.push({ ...cur });
      }
    }
    seg = out;
    out = [];
    for (const cur of seg) {
      const prev = out[out.length - 1];
      if (prev && prev.word === YI && !isXEng(cur.pos)) {
        out[out.length - 1] = {
          word: prev.word + cur.word,
          pos: prev.pos,
          start: prev.start,
          end: cur.end,
        };
      } else {
        out.push({ ...cur });
      }
    }
    return out;
  }

  private mergeReduplication(seg: SpannedPosToken[]): SpannedPosToken[] {
    const out: SpannedPosToken[] = [];
    for (const cur of seg) {
      const prev = out[out.length - 1];
      if (prev && cur.word === prev.word && !isXEng(cur.pos)) {
        prev.word += cur.word;
        prev.end = cur.end;
      } else {
        out.push({ ...cur });
      }
    }
    return out;
  }

  private isRedup(word: string): boolean {
    const w = Array.from(word);
    return w.length === 2 && w[0] === w[1];
  }

  private mergeThree(seg: SpannedPosToken[], mode: 1 | 2): SpannedPosToken[] {
    const out: SpannedPosToken[] = [];
    const sub = seg.map((t) => (isXEng(t.pos) ? ['0'] : this.py.finalsTone3(t.word)));
    const mergeLast = new Array<boolean>(seg.length).fill(false);

    for (let i = 0; i < seg.length; i++) {
      const cur = seg[i]!;
      const prevSub = i > 0 ? (sub[i - 1] ?? []) : [];
      const curSub = sub[i] ?? [];
      const cond =
        !isXEng(cur.pos) &&
        i - 1 >= 0 &&
        !mergeLast[i - 1] &&
        (mode === 1
          ? allToneThree(prevSub) && allToneThree(curSub)
          : prevSub.length > 0 &&
            curSub.length > 0 &&
            lastChar(prevSub[prevSub.length - 1] ?? '') === '3' &&
            lastChar(curSub[0] ?? '') === '3');
      if (cond) {
        const prevSeg = seg[i - 1]!;
        const prevOut = out[out.length - 1];
        if (
          prevOut &&
          !this.isRedup(prevSeg.word) &&
          Array.from(prevSeg.word).length + Array.from(cur.word).length <= 3
        ) {
          prevOut.word += cur.word;
          prevOut.end = cur.end;
          mergeLast[i] = true;
        } else {
          out.push({ ...cur });
        }
      } else {
        out.push({ ...cur });
      }
    }
    return out;
  }

  private mergeEr(seg: SpannedPosToken[]): SpannedPosToken[] {
    const out: SpannedPosToken[] = [];
    for (let i = 0; i < seg.length; i++) {
      const cur = seg[i]!;
      const prev = out[out.length - 1];
      if (i - 1 >= 0 && cur.word === '儿' && prev && !isXEng(prev.pos)) {
        prev.word += cur.word;
        prev.end = cur.end;
      } else {
        out.push({ ...cur });
      }
    }
    return out;
  }

  preMergeForModify(seg: SpannedPosToken[]): SpannedPosToken[] {
    seg = this.mergeBu(seg);
    seg = this.mergeYi(seg);
    seg = this.mergeReduplication(seg);
    seg = this.mergeThree(seg, 1);
    seg = this.mergeThree(seg, 2);
    seg = this.mergeEr(seg);
    return seg;
  }
}
