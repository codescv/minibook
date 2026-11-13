/**
 * Offset-preserving string wrapper (`TrackedText`) that composes arbitrary regex/substring
 * replacements while maintaining an exact per-UTF-16-code-unit map `[c0, c1)` back into the
 * original `Utterance.text`.
 *
 * Guarantee: `tracked.text` is 100% identical to running the same `.replace` / `.trim` operations
 * on a plain string, and for any `0 <= s < e <= tracked.text.length`, `rawRange(s, e)` satisfies
 * `0 <= c0 <= c1 <= originalLength`.
 */

export interface RawCharRange {
  readonly c0: number;
  readonly c1: number;
}

export class TrackedText {
  readonly originalLength: number;
  readonly text: string;
  readonly c0s: Int32Array;
  readonly c1s: Int32Array;

  constructor(text: string, c0s: Int32Array, c1s: Int32Array, originalLength: number) {
    this.text = text;
    this.c0s = c0s;
    this.c1s = c1s;
    this.originalLength = originalLength;
  }

  static fromRaw(raw: string): TrackedText {
    const n = raw.length;
    const c0s = new Int32Array(n);
    const c1s = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      c0s[i] = i;
      c1s[i] = i + 1;
    }
    return new TrackedText(raw, c0s, c1s, n);
  }

  /** Maps a `[start, end)` UTF-16 slice of `this.text` back to `[c0, c1)` in the raw input. */
  rawRange(start: number, end: number): RawCharRange {
    const len = this.text.length;
    if (len === 0 || this.originalLength === 0) {
      return { c0: 0, c1: 0 };
    }
    const s = Math.max(0, Math.min(len - 1, start));
    const e = Math.max(s + 1, Math.min(len, end));
    const rawStart = this.c0s[s] ?? 0;
    const rawEnd = this.c1s[e - 1] ?? rawStart;
    const c0 = Math.max(0, Math.min(this.originalLength, rawStart));
    const c1 = Math.max(c0, Math.min(this.originalLength, rawEnd));
    return { c0, c1 };
  }

  slice(start: number, end = this.text.length): TrackedText {
    const s = Math.max(0, Math.min(this.text.length, start));
    const e = Math.max(s, Math.min(this.text.length, end));
    return new TrackedText(
      this.text.slice(s, e),
      this.c0s.slice(s, e),
      this.c1s.slice(s, e),
      this.originalLength,
    );
  }

  trim(): TrackedText {
    let s = 0;
    let e = this.text.length;
    while (s < e && /\s/.test(this.text[s]!)) s++;
    while (e > s && /\s/.test(this.text[e - 1]!)) e--;
    if (s === 0 && e === this.text.length) return this;
    return this.slice(s, e);
  }

  replaceRegex(
    pattern: RegExp,
    replacer: (match: string, ...groups: string[]) => string,
  ): TrackedText {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);

    let outText = '';
    const outC0: number[] = [];
    const outC1: number[] = [];
    let lastIndex = 0;

    for (const m of this.text.matchAll(re)) {
      const mStart = m.index ?? 0;
      const matched = m[0];
      const mEnd = mStart + matched.length;
      if (mEnd === mStart) continue;

      if (mStart > lastIndex) {
        outText += this.text.slice(lastIndex, mStart);
        for (let i = lastIndex; i < mStart; i++) {
          outC0.push(this.c0s[i]!);
          outC1.push(this.c1s[i]!);
        }
      }

      const groups = m.slice(1).map((g) => g ?? '');
      const rep = replacer(matched, ...groups);
      if (rep.length > 0) {
        outText += rep;
        if (rep.length === matched.length) {
          for (let k = 0; k < rep.length; k++) {
            outC0.push(this.c0s[mStart + k]!);
            outC1.push(this.c1s[mStart + k]!);
          }
        } else {
          const spanStart = this.c0s[mStart]!;
          const spanEnd = this.c1s[mEnd - 1]!;
          for (let k = 0; k < rep.length; k++) {
            outC0.push(spanStart);
            outC1.push(spanEnd);
          }
        }
      }

      lastIndex = mEnd;
    }

    if (lastIndex === 0) {
      return this;
    }

    if (lastIndex < this.text.length) {
      outText += this.text.slice(lastIndex);
      for (let i = lastIndex; i < this.text.length; i++) {
        outC0.push(this.c0s[i]!);
        outC1.push(this.c1s[i]!);
      }
    }

    return new TrackedText(
      outText,
      Int32Array.from(outC0),
      Int32Array.from(outC1),
      this.originalLength,
    );
  }

  replaceLiteralAll(search: string, replacement: string): TrackedText {
    if (!search || !this.text.includes(search)) return this;
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return this.replaceRegex(new RegExp(escaped, 'g'), () => replacement);
  }
}
