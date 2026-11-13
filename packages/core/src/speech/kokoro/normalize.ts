/**
 * App-side text pre-normaliser (`TTS_V2_SPEC.md` §4.4).
 * Converts modern typography, dates, clock times, currencies, thousands separators, ranges,
 * and phone/ID digit sequences into clean Mandarin text before `cn2an` + `ZHG2P` run,
 * while preserving exact UTF-16 offset ranges via `TrackedText`.
 */
import { an2cn } from './cn2an.js';
import { TrackedText } from './offset-text.js';

const RE_FULLWIDTH_ALNUM = /[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/g;
const RE_ELLIPSIS = /\.{3,}|。{3,}/g;
const RE_DOUBLE_DASH = /--+/g;
const RE_BRACKETS_OPEN = /[\[{]/g;
const RE_BRACKETS_CLOSE = /[\]}]/g;
const RE_ISO_DATE = /(?<!\d)(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?!\d)/g;
const RE_CLOCK_TIME = /(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\d)/g;
const RE_THOUSANDS = /(?<!\d)\d{1,3}(?:,\d{3})+(?:\.\d+)?(?!\d)/g;
const RE_NUMERIC_RANGE = /(-?\d+(?:\.\d+)?(?:%|℃)?)\s*[～~∼]\s*(?=-?\d)/g;
const RE_TILDE = /[～~∼]/g;
const RE_PREFIXED_ID = /((?:电话|手机|号码|编号|QQ|微信)\s*[:：]?\s*)(\d{5,})/gi;
const RE_LONG_DIGIT_RUN = /(?<![.\d])\d{7,}(?![.\d])/g;
const RE_USD = /\$(\d+(?:\.\d+)?)/g;
const RE_RMB = /[¥￥](\d+(?:\.\d+)?)/g;

export function normalizeZhTracked(input: TrackedText): TrackedText {
  let cur = input;

  // 1. NFKC for full-width ASCII digits & Latin letters (`２０２４` -> `2024`)
  cur = cur.replaceRegex(RE_FULLWIDTH_ALNUM, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );

  // 2. Curly single/corner quotes, dashes, ellipsis, brackets (`TTS_V2_SPEC.md` §4.4)
  cur = cur
    .replaceLiteralAll('‘', '“')
    .replaceLiteralAll('’', '”')
    .replaceLiteralAll('『', '“')
    .replaceLiteralAll('』', '”')
    .replaceRegex(RE_ELLIPSIS, () => '…')
    .replaceRegex(RE_DOUBLE_DASH, () => '——')
    .replaceRegex(RE_BRACKETS_OPEN, () => '(')
    .replaceRegex(RE_BRACKETS_CLOSE, () => ')');

  // 3. `〇` -> `零` (`二〇二四年` -> `二零二四年`)
  cur = cur.replaceLiteralAll('〇', '零');

  // 4. ISO dates (`2024-01-15`, `2024/1/15` -> `2024年1月15日`)
  cur = cur.replaceRegex(RE_ISO_DATE, (match, y, m, d) => {
    const month = Number(m);
    const day = Number(d);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${y}年${month}月${day}日`;
    }
    return match;
  });

  // 5. Clock times (`12:30` -> `12点30分`, `12:30:45` -> `12点30分45秒`, `12:05` -> `12点零5分`)
  cur = cur.replaceRegex(RE_CLOCK_TIME, (match, hh, mm, ss) => {
    const h = Number(hh);
    const m = Number(mm);
    const s = ss ? Number(ss) : 0;
    if (h >= 0 && h <= 24 && m >= 0 && m <= 59 && s >= 0 && s <= 59) {
      const fmt2 = (raw: string, unit: string) => {
        const v = Number(raw);
        if (v === 0) return `0${unit}`;
        return raw.length === 2 && raw[0] === '0' ? `零${v}${unit}` : `${v}${unit}`;
      };
      if (ss) {
        return `${h}点${fmt2(mm, '分')}${fmt2(ss, '秒')}`;
      }
      return m === 0 ? `${h}点整` : `${h}点${fmt2(mm, '分')}`;
    }
    return match;
  });

  // 6. Thousands separators (`1,234,567.89` -> `1234567.89`) before currency/number rules
  cur = cur.replaceRegex(RE_THOUSANDS, (match) => match.replaceAll(',', ''));

  // 7. Ranges (`45%～60%`, `3~5` -> `45%到60%`, `3到5`)
  cur = cur.replaceRegex(RE_NUMERIC_RANGE, (_m, left) => `${left}到`);
  cur = cur.replaceRegex(RE_TILDE, () => '到');

  // 8. Phone / ID digit runs (>= 7 digits, or after 电话/手机/号码/编号/QQ/微信) -> digit-by-digit
  cur = cur.replaceRegex(RE_PREFIXED_ID, (_m, prefix, digits) => `${prefix}${an2cn(digits, 'direct')}`);
  cur = cur.replaceRegex(RE_LONG_DIGIT_RUN, (digits) => an2cn(digits, 'direct'));

  // 9. Currency (`$19.99` -> `19.99美元`, `¥5` / `￥5` -> `5元`)
  cur = cur.replaceRegex(RE_USD, (_m, amt) => `${amt}美元`);
  cur = cur.replaceRegex(RE_RMB, (_m, amt) => `${amt}元`);

  return cur;
}

export function normalizeEnTracked(input: TrackedText): TrackedText {
  let cur = input;
  cur = cur.replaceRegex(RE_FULLWIDTH_ALNUM, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  cur = cur
    .replaceRegex(RE_ELLIPSIS, () => '…')
    .replaceRegex(RE_DOUBLE_DASH, () => '—')
    .replaceRegex(RE_BRACKETS_OPEN, () => '(')
    .replaceRegex(RE_BRACKETS_CLOSE, () => ')');
  return cur;
}

export function normalizeForKokoro(text: string): string {
  return normalizeZhTracked(TrackedText.fromRaw(text)).text;
}
