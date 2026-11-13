/**
 * Faithful pure-TS port of `cn2an==0.5.24` `Transform().transform(text, 'an2cn')`
 * (`TTS_V2_SPEC.md` §4.1, §4.3).
 */
import { TrackedText } from './offset-text.js';

const D = '[0-9\\uFF10-\\uFF19]';
const NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;
const UNIT = ['', '十', '百', '千', '万', '十', '百', '千', '亿', '十', '百', '千', '万', '十', '百', '千'] as const;
const MEASURE =
  '斤|克|千克|公斤|吨|米|厘米|毫米|公里|升|毫升|元|角|分|个|只|条|张|块|瓶|杯|份|本|辆|台|匹|头|位|亩|小时|分钟|秒|天|半';

function toHalfWidth(s: string): string {
  return s
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248))
    .replace(/\u3000/g, ' ');
}

function integerConvert(raw: string): string {
  const s = raw.replace(/^0+(?=\d)/, '');
  const n = s.length;
  if (n > UNIT.length) throw new Error('cn2an integer out of range');
  let out = '';
  for (let i = 0; i < n; i++) {
    const d = s.charCodeAt(i) - 48;
    const digitChar = NUM[d]!;
    const unitChar = UNIT[n - i - 1]!;
    if (d !== 0) {
      out += digitChar + unitChar;
    } else {
      if ((n - i - 1) % 4 === 0) {
        out += digitChar + unitChar;
      }
      if (i > 0 && out[out.length - 1] !== '零') {
        out += digitChar;
      }
    }
  }
  out = out
    .replaceAll('零零', '零')
    .replaceAll('零万', '万')
    .replaceAll('零亿', '亿')
    .replaceAll('亿万', '亿')
    .replace(/^零+|零+$/g, '');
  out = out.replace(/([万亿])零([一二三四五六七八九壹贰叁肆伍陆柒捌玖][千仟])/g, '$1$2');
  if (out.startsWith('一十')) {
    out = out.slice(1);
  }
  return out || '零';
}

export function an2cn(input: string, mode: 'low' | 'direct' = 'low'): string {
  let s = toHalfWidth(input);
  if (!/^[0-9.-]+$/.test(s)) throw new Error('cn2an invalid input');
  let sign = '';
  if (s[0] === '-') {
    sign = '负';
    s = s.slice(1);
  }
  if (mode === 'direct') {
    return (
      sign +
      Array.from(s)
        .map((c) => (c === '.' ? '点' : (NUM[c.charCodeAt(0) - 48] ?? c)))
        .join('')
    );
  }
  const parts = s.split('.');
  if (parts.length === 1) {
    return sign + integerConvert(parts[0]!);
  }
  if (parts.length === 2) {
    const intPart = parts[0]!;
    const fracRaw = parts[1]!;
    const dec = fracRaw.slice(0, 16);
    const fracStr = fracRaw.length
      ? '点' + Array.from(dec).map((c) => NUM[c.charCodeAt(0) - 48] ?? c).join('')
      : '';
    return sign + integerConvert(intPart) + fracStr;
  }
  throw new Error('cn2an invalid decimal');
}

function safeTransform(input: string, fn: (x: string) => string): string {
  try {
    return fn(input);
  } catch {
    return input;
  }
}

function makeCn2anRegex(src: string): RegExp {
  return new RegExp(src.replaceAll('\\d', D), 'g');
}

const RE_RANGE = makeCn2anRegex(`\\d+(?:\\.\\d+)?-\\d+(?:\\.\\d+)?(?=(?:${MEASURE}))`);
const RE_DATE = makeCn2anRegex(
  '\\d{2,4}年(?:\\d{1,2}月)?(?:\\d{1,2}日)?|\\d{1,2}月(?:\\d{1,2}日)?|\\d{1,2}日',
);
const RE_YEAR_DIGITS = makeCn2anRegex('\\d+(?=年)');
const RE_DIGITS = makeCn2anRegex('\\d+');
const RE_FRACTION = makeCn2anRegex('\\d+/\\d+');
const RE_PERCENT = makeCn2anRegex('-?(?:\\d+\\.)?\\d+%');
const RE_CELSIUS = makeCn2anRegex('\\d+℃');
const RE_NUMBER = makeCn2anRegex('-?(?:\\d+\\.)?\\d+');

export function transformAn2cnTracked(tracked: TrackedText): TrackedText {
  let cur = tracked;
  cur = cur.replaceRegex(RE_RANGE, (m) =>
    safeTransform(m, (x) => {
      const [a, b] = x.split('-');
      return `${an2cn(a ?? '')}到${an2cn(b ?? '')}`;
    }),
  );
  cur = cur.replaceRegex(RE_DATE, (m) =>
    safeTransform(m, (x) => {
      const withYear = x.replace(RE_YEAR_DIGITS, (y) => an2cn(y, 'direct'));
      return withYear.replace(RE_DIGITS, (y) => an2cn(y));
    }),
  );
  cur = cur.replaceRegex(RE_FRACTION, (m) =>
    safeTransform(m, (x) => {
      const [num, den] = x.replace(RE_DIGITS, (y) => an2cn(y)).split('/');
      return `${den ?? ''}分之${num ?? ''}`;
    }),
  );
  cur = cur.replaceRegex(RE_PERCENT, (m) =>
    safeTransform(m, (x) => `百分之${an2cn(x.slice(0, -1))}`),
  );
  cur = cur.replaceRegex(RE_CELSIUS, (m) =>
    safeTransform(m, (x) => `${an2cn(x.slice(0, -1))}摄氏度`),
  );
  cur = cur.replaceRegex(RE_NUMBER, (m) => safeTransform(m, (x) => an2cn(x)));
  return cur;
}

export function transformAn2cn(text: string): string {
  return transformAn2cnTracked(TrackedText.fromRaw(text)).text;
}
