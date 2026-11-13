/**
 * Faithful pure-TS port of `jieba==0.42.1` (`Tokenizer.cut`, `cut_for_search`, `posseg.cut`)
 * with bit-exact CPython `math.log` frequency table (`TTS_V2_SPEC.md` §4.3).
 */

export interface JiebaFinalsegModel {
  readonly start: Readonly<Record<'B' | 'M' | 'E' | 'S', number>>;
  readonly trans: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly emit: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface JiebaPossegModel {
  readonly start: Readonly<Record<string, number>>;
  readonly trans: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly emit: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly charState: Readonly<Record<string, readonly string[]>>;
}

export interface JiebaLogTable {
  readonly logtotal: number;
  readonly logs: Readonly<Record<string, number>>;
}

export type PosToken = [word: string, pos: string];

const MIN_FLOAT = -3.14e100;
const WS =
  '\\t\\n\\x0b\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const RE_HAN_DEFAULT = /([\u4E00-\u9FD5a-zA-Z0-9+#&._%-]+)/;
const RE_SKIP_DEFAULT = new RegExp(`(\\r\\n|[${WS}])`);
const RE_HAN_INTERNAL = /([\u4E00-\u9FD5a-zA-Z0-9+#&._]+)/;
const RE_HAN_ONLY = /([\u4E00-\u9FD5]+)/;
const RE_FINALSEG_SKIP = /([a-zA-Z0-9]+(?:\.\d+)?%?)/;
const RE_SKIP_DETAIL = /([.0-9]+|[a-zA-Z0-9]+)/;
const RE_NUM = /^[.0-9]+/;
const RE_ENG = /^[a-zA-Z0-9]+/;

function startsWithRegex(re: RegExp, s: string): boolean {
  const m = re.exec(s);
  return m !== null && m.index === 0;
}

type BmesState = 'B' | 'M' | 'E' | 'S';
const BMES_STATES: readonly BmesState[] = ['B', 'M', 'E', 'S'];
const BMES_PREV: Readonly<Record<BmesState, readonly BmesState[]>> = {
  B: ['E', 'S'],
  M: ['M', 'B'],
  S: ['S', 'E'],
  E: ['B', 'M'],
};

export class Jieba {
  private readonly dict: Map<string, number>;
  private readonly tagNames: string[];
  private readonly logtotal: number;
  private readonly logs: Map<number, number> | null;
  private readonly fs: JiebaFinalsegModel;
  private readonly ps: JiebaPossegModel;
  private readonly psAllStates: readonly string[];
  private readonly psTransKeys: Readonly<Record<string, readonly string[]>>;

  constructor(
    dictText: string,
    finalseg: JiebaFinalsegModel,
    posseg: JiebaPossegModel,
    logs: JiebaLogTable | null = null,
  ) {
    const D = new Map<string, number>();
    const tagIds = new Map<string, number>([['', 0]]);
    const tagNames: string[] = [''];
    let total = 0;
    let pos = 0;
    const n = dictText.length;

    while (pos < n) {
      let nl = dictText.indexOf('\n', pos);
      if (nl < 0) nl = n;
      const s1 = dictText.indexOf(' ', pos);
      if (s1 > 0 && s1 < nl) {
        const s2 = dictText.indexOf(' ', s1 + 1);
        const word = dictText.slice(pos, s1);
        const freq = Number(dictText.slice(s1 + 1, s2));
        let end = nl;
        if (dictText.charCodeAt(end - 1) === 13) end--;
        const tag = dictText.slice(s2 + 1, end);
        let tid = tagIds.get(tag);
        if (tid === undefined) {
          tid = tagNames.length;
          tagNames.push(tag);
          tagIds.set(tag, tid);
        }
        D.set(word, freq * 128 + tid);
        total += freq;
        if (word.length > 1) {
          const cps = Array.from(word);
          let frag = '';
          for (let i = 0; i < cps.length - 1; i++) {
            frag += cps[i]!;
            if (!D.has(frag)) D.set(frag, 0);
          }
        }
      }
      pos = nl + 1;
    }

    this.dict = D;
    this.tagNames = tagNames;
    this.logtotal = logs ? logs.logtotal : Math.log(total);
    this.logs = logs
      ? new Map(Object.entries(logs.logs).map(([k, v]) => [Number(k), v]))
      : null;
    this.fs = finalseg;
    this.ps = posseg;
    const allStates = Object.keys(posseg.trans);
    this.psAllStates = allStates;
    const transKeys: Record<string, readonly string[]> = {};
    for (const k of allStates) {
      transKeys[k] = Object.keys(posseg.trans[k] ?? {});
    }
    this.psTransKeys = transKeys;
  }

  freq(word: string): number {
    const v = this.dict.get(word);
    return v === undefined ? 0 : Math.floor(v / 128);
  }

  tag(word: string): string {
    const v = this.dict.get(word);
    if (v === undefined) return 'x';
    return this.tagNames[v % 128] || 'x';
  }

  private logFreq(f: number): number {
    return this.logs ? (this.logs.get(f) ?? Math.log(f)) : Math.log(f);
  }

  private route(s: readonly string[]): Int32Array {
    const N = s.length;
    const next = new Int32Array(N + 1);
    const score = new Float64Array(N + 1);
    for (let k = N - 1; k >= 0; k--) {
      let best = -Infinity;
      let bx = -1;
      let any = false;
      let frag = s[k]!;
      let i = k;
      while (i < N) {
        const v = this.dict.get(frag);
        if (v === undefined) break;
        if (v >= 128) {
          any = true;
          const p = this.logFreq(Math.floor(v / 128)) - this.logtotal + score[i + 1]!;
          if (p >= best) {
            best = p;
            bx = i;
          }
        }
        i++;
        if (i < N) frag += s[i]!;
      }
      if (!any) {
        best = 0 - this.logtotal + score[k + 1]!;
        bx = k;
      }
      score[k] = best;
      next[k] = bx;
    }
    return next;
  }

  private fsViterbi(obs: readonly string[]): BmesState[] {
    const { start, trans, emit } = this.fs;
    let V: Record<BmesState, number> = { B: 0, M: 0, E: 0, S: 0 };
    let path: Record<BmesState, BmesState[]> = { B: [], M: [], E: [], S: [] };

    const firstObs = obs[0]!;
    for (const y of BMES_STATES) {
      V[y] = start[y] + (emit[y]?.[firstObs] ?? MIN_FLOAT);
      path[y] = [y];
    }

    for (let t = 1; t < obs.length; t++) {
      const V2: Record<BmesState, number> = { B: 0, M: 0, E: 0, S: 0 };
      const np: Record<BmesState, BmesState[]> = { B: [], M: [], E: [], S: [] };
      const curObs = obs[t]!;
      for (const y of BMES_STATES) {
        const em = emit[y]?.[curObs] ?? MIN_FLOAT;
        let bp = -Infinity;
        let bs: BmesState | null = null;
        for (const y0 of BMES_PREV[y]) {
          const p = V[y0] + (trans[y0]?.[y] ?? MIN_FLOAT) + em;
          if (bs === null || p > bp || (p === bp && y0 > bs)) {
            bp = p;
            bs = y0;
          }
        }
        const chosen = bs ?? 'S';
        V2[y] = bp;
        np[y] = path[chosen].concat(y);
      }
      V = V2;
      path = np;
    }

    const st: BmesState = V.E > V.S || (V.E === V.S && 'E' > 'S') ? 'E' : 'S';
    return path[st];
  }

  private fsCutHan(s: readonly string[]): string[] {
    if (s.length === 0) return [];
    const pl = this.fsViterbi(s);
    const out: string[] = [];
    let begin = 0;
    let nexti = 0;
    for (let i = 0; i < s.length; i++) {
      const p = pl[i]!;
      if (p === 'B') {
        begin = i;
      } else if (p === 'E') {
        out.push(s.slice(begin, i + 1).join(''));
        nexti = i + 1;
      } else if (p === 'S') {
        out.push(s[i]!);
        nexti = i + 1;
      }
    }
    if (nexti < s.length) {
      out.push(s.slice(nexti).join(''));
    }
    return out;
  }

  finalsegCut(sentence: string): string[] {
    const out: string[] = [];
    for (const blk of sentence.split(RE_HAN_ONLY)) {
      if (!blk) continue;
      if (startsWithRegex(RE_HAN_ONLY, blk)) {
        out.push(...this.fsCutHan(Array.from(blk)));
      } else {
        for (const x of blk.split(RE_FINALSEG_SKIP)) {
          if (x) out.push(x);
        }
      }
    }
    return out;
  }

  private cutDAG(blk: string): string[] {
    const s = Array.from(blk);
    const N = s.length;
    const next = this.route(s);
    const out: string[] = [];
    let buf: string[] = [];
    const flush = () => {
      if (!buf.length) return;
      if (buf.length === 1) {
        out.push(buf[0]!);
      } else {
        const b = buf.join('');
        if (!this.freq(b)) out.push(...this.finalsegCut(b));
        else out.push(...buf);
      }
      buf = [];
    };
    let x = 0;
    while (x < N) {
      const y = next[x]! + 1;
      if (y - x === 1) {
        buf.push(s[x]!);
      } else {
        flush();
        out.push(s.slice(x, y).join(''));
      }
      x = y;
    }
    flush();
    return out;
  }

  cut(sentence: string): string[] {
    const out: string[] = [];
    for (const blk of sentence.split(RE_HAN_DEFAULT)) {
      if (!blk) continue;
      if (startsWithRegex(RE_HAN_DEFAULT, blk)) {
        out.push(...this.cutDAG(blk));
      } else {
        for (const x of blk.split(RE_SKIP_DEFAULT)) {
          if (x === undefined || x === '') continue;
          if (startsWithRegex(RE_SKIP_DEFAULT, x)) out.push(x);
          else out.push(...Array.from(x));
        }
      }
    }
    return out;
  }

  cutForSearch(sentence: string): string[] {
    const out: string[] = [];
    for (const w of this.cut(sentence)) {
      const c = Array.from(w);
      if (c.length > 2) {
        for (let i = 0; i < c.length - 1; i++) {
          const g = c[i]! + c[i + 1]!;
          if (this.freq(g)) out.push(g);
        }
      }
      if (c.length > 3) {
        for (let i = 0; i < c.length - 2; i++) {
          const g = c[i]! + c[i + 1]! + c[i + 2]!;
          if (this.freq(g)) out.push(g);
        }
      }
      out.push(w);
    }
    return out;
  }

  private psViterbi(obs: readonly string[]): string[] {
    const { start, trans, emit, charState } = this.ps;
    const all = this.psAllStates;
    const V: Array<Map<string, number>> = [new Map()];
    const mem: Array<Map<string, string>> = [new Map()];

    const first = obs[0]!;
    for (const y of charState[first] ?? all) {
      V[0]!.set(y, (start[y] ?? MIN_FLOAT) + (emit[y]?.[first] ?? MIN_FLOAT));
      mem[0]!.set(y, '');
    }

    for (let t = 1; t < obs.length; t++) {
      const Vt = new Map<string, number>();
      const mt = new Map<string, string>();
      V.push(Vt);
      mem.push(mt);

      const prev: string[] = [];
      for (const x of mem[t - 1]!.keys()) {
        if ((this.psTransKeys[x]?.length ?? 0) > 0) prev.push(x);
      }
      const expect = new Set<string>();
      for (const x of prev) {
        for (const y of this.psTransKeys[x] ?? []) expect.add(y);
      }
      const o = obs[t]!;
      let obsStates: readonly string[] = (charState[o] ?? all).filter((y) => expect.has(y));
      if (!obsStates.length) {
        obsStates = expect.size ? [...expect] : all;
      }
      const prevV = V[t - 1]!;
      for (const y of obsStates) {
        const em = emit[y]?.[o] ?? MIN_FLOAT;
        let bp = -Infinity;
        let bs: string | null = null;
        for (const y0 of prev) {
          const p = (prevV.get(y0) ?? MIN_FLOAT) + (trans[y0]?.[y] ?? -Infinity) + em;
          if (bs === null || p > bp || (p === bp && y0 > bs)) {
            bp = p;
            bs = y0;
          }
        }
        Vt.set(y, bp);
        mt.set(y, bs ?? '');
      }
    }

    let bp = -Infinity;
    let state: string | null = null;
    for (const [y, p] of V[V.length - 1]!) {
      if (state === null || p > bp || (p === bp && y > state)) {
        bp = p;
        state = y;
      }
    }
    const route = new Array<string>(obs.length);
    let curState = state ?? 'Sx';
    for (let i = obs.length - 1; i >= 0; i--) {
      route[i] = curState;
      curState = mem[i]!.get(curState) ?? 'Sx';
    }
    return route;
  }

  private psCutHan(s: readonly string[]): PosToken[] {
    if (s.length === 0) return [];
    const pl = this.psViterbi(s);
    const out: PosToken[] = [];
    let begin = 0;
    let nexti = 0;
    for (let i = 0; i < s.length; i++) {
      const stateStr = pl[i]!;
      const p = stateStr[0];
      if (p === 'B') {
        begin = i;
      } else if (p === 'E') {
        out.push([s.slice(begin, i + 1).join(''), stateStr.slice(1)]);
        nexti = i + 1;
      } else if (p === 'S') {
        out.push([s[i]!, stateStr.slice(1)]);
        nexti = i + 1;
      }
    }
    if (nexti < s.length) {
      out.push([s.slice(nexti).join(''), pl[nexti]!.slice(1)]);
    }
    return out;
  }

  private psCutDetail(sentence: string): PosToken[] {
    const out: PosToken[] = [];
    for (const blk of sentence.split(RE_HAN_ONLY)) {
      if (!blk) continue;
      if (startsWithRegex(RE_HAN_ONLY, blk)) {
        out.push(...this.psCutHan(Array.from(blk)));
      } else {
        for (const x of blk.split(RE_SKIP_DETAIL)) {
          if (!x) continue;
          if (RE_NUM.test(x)) out.push([x, 'm']);
          else if (RE_ENG.test(x)) out.push([x, 'eng']);
          else out.push([x, 'x']);
        }
      }
    }
    return out;
  }

  private psCutDAG(blk: string): PosToken[] {
    const s = Array.from(blk);
    const N = s.length;
    const next = this.route(s);
    const out: PosToken[] = [];
    let buf: string[] = [];
    const flush = () => {
      if (!buf.length) return;
      if (buf.length === 1) {
        out.push([buf[0]!, this.tag(buf[0]!)]);
      } else {
        const b = buf.join('');
        if (!this.freq(b)) {
          out.push(...this.psCutDetail(b));
        } else {
          for (const e of buf) out.push([e, this.tag(e)]);
        }
      }
      buf = [];
    };
    let x = 0;
    while (x < N) {
      const y = next[x]! + 1;
      if (y - x === 1) {
        buf.push(s[x]!);
      } else {
        flush();
        const w = s.slice(x, y).join('');
        out.push([w, this.tag(w)]);
      }
      x = y;
    }
    flush();
    return out;
  }

  posCut(sentence: string): PosToken[] {
    const out: PosToken[] = [];
    for (const blk of sentence.split(RE_HAN_INTERNAL)) {
      if (!blk) continue;
      if (startsWithRegex(RE_HAN_INTERNAL, blk)) {
        out.push(...this.psCutDAG(blk));
      } else {
        for (const x of blk.split(RE_SKIP_DEFAULT)) {
          if (x === undefined || x === '') continue;
          if (startsWithRegex(RE_SKIP_DEFAULT, x)) {
            out.push([x, 'x']);
          } else {
            for (const xx of Array.from(x)) {
              out.push([xx, RE_NUM.test(xx) ? 'm' : RE_ENG.test(x) ? 'eng' : 'x']);
            }
          }
        }
      }
    }
    return out;
  }
}
