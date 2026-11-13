import type { ByteSource } from '../types.js';
import { concatBytes } from './binary.js';

export type SupportedTextEncoding =
  | 'utf-8'
  | 'utf-16le'
  | 'utf-16be'
  | 'gb18030'
  | 'big5'
  | 'shift_jis'
  | 'euc-kr'
  | 'windows-1252';

export interface DetectedEncoding {
  readonly encoding: SupportedTextEncoding;
  /** Byte length of leading BOM to skip (`0`, `2`, or `3`). */
  readonly bomLength: number;
}

// Top ~520 highest-frequency Simplified Chinese characters (covers >75% of running Simplified prose)
const TOP_SIMPLIFIED_HANZI = new Set(
  '的一是不了人我在有他这为之大来以个中上们到说国和地也子时道出而要于就下得可你年生自会那后能对着事其里所去行过家十用发天如然作方成者多日都三小军二无同么经法当起与好看学进种将还分此心前面又定见只主没公从知现长已明政四女民外两些意月实直水比但被最气使身等全信内体化名新果正平理间手把点四向头文几定本见想机力气开它相情高已动两长回少便定重问度知物全把应美电它门最给听女风什打果些走白快第章回卷集部篇说笑看道眼手心神声色光身口头面笑问想吃喝睡走跑跳哭喊叫杀战死生爱恨剑刀拳掌气血魂灵天地山河江湖海云雨雷电风火水木金土星辰日月明暗黑白红绿蓝黄紫青银金玉石铁钢城池宫殿宗门派世家族皇帝王侯将相仙魔神妖鬼怪龙凤虎狼犬猫鸟鱼花草树木林森田园路桥车船马衣食住行书画琴棋诗词歌赋男女老少父母兄弟姐妹夫妻儿女师徒朋友敌我她它咱们您谁哪怎几多少大小高低长短远近快慢早晚新旧好坏真假美丑善恶强弱胜败生死存亡开关进出上下左右前后内外中间东西南北春夏秋冬年月日时分秒今昨明早晚夜晨昏百千万亿零一二三四五六七八九十两半双全每各某另别其他'.split(
    '',
  ),
);

// Top ~520 highest-frequency Traditional Chinese characters (distinct + shared common chars)
const TOP_TRADITIONAL_HANZI = new Set(
  '的一是不了人我在有他這為之大來以個中上們到說國和地也子時道出而要於就下得可你年生自會那後能對著事其裡所去行過家十用發天如然作方成者多日都三小軍二無同麼經法當起與好看學進種將還分此心前面又定見只主沒公從知現長已明政四女民外兩些意月實直水比但被最氣使身等全信內體化名新果正平理間手把點向頭文幾本見想機力開它相情高動回少便重問度物應美電門給聽風什打果走白快第章回卷集部篇說笑看道眼手心神聲色光身口頭面問想吃喝睡走跑跳哭喊叫殺戰死生愛恨劍刀拳掌氣血魂靈天地山河江湖海雲雨雷電風火水木金土星辰日月明暗黑白紅綠藍黃紫青銀金玉石鐵鋼城池宮殿宗門派世家族皇帝王侯將相仙魔神妖鬼怪龍鳳虎狼犬貓鳥魚花草樹木林森田園路橋車船馬衣食住行書畫琴棋詩詞歌賦男女老少父母兄弟姐妹夫妻兒女師徒朋友敵我她它咱們您誰哪怎幾多少大小高低長短遠近快慢早晚新舊好壞真假美醜善惡強弱勝敗生死存亡開關進出上下左右前後內外中間東西南北春夏秋冬年月日時分秒今昨明早晚夜晨昏百千萬億零一二三四五六七八九十兩半雙全每各某另別其他體學國會發開關門間時間問題點頭見過還進運動邊遠近處應該讓給從來對開關聽說讀寫認識覺得喜歡愛護選擇環境歷史經濟社會政治文化藝術科學技術教育醫療健康生活工作學習旅遊'.split(
    '',
  ),
);

const CJK_PUNCT = new Set(
  '，。！？；：“”‘’「」『』（）【】《》〈〉、…—～·'.split(''),
);

function cutSampleAtNewline(buf: Uint8Array, trimStart: boolean, trimEnd: boolean): Uint8Array {
  let start = 0;
  let end = buf.byteLength;
  if (trimStart) {
    const idx = buf.indexOf(0x0a);
    if (idx >= 0 && idx + 1 < end) start = idx + 1;
  }
  if (trimEnd) {
    const idx = buf.lastIndexOf(0x0a);
    if (idx > start) end = idx + 1;
  }
  return buf.subarray(start, end);
}

function checkBom(head: Uint8Array): DetectedEncoding | null {
  if (head.byteLength >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    return { encoding: 'utf-8', bomLength: 3 };
  }
  if (head.byteLength >= 2 && head[0] === 0xff && head[1] === 0xfe) {
    return { encoding: 'utf-16le', bomLength: 2 };
  }
  if (head.byteLength >= 2 && head[0] === 0xfe && head[1] === 0xff) {
    return { encoding: 'utf-16be', bomLength: 2 };
  }
  return null;
}

function checkBomlessUtf16(head: Uint8Array): DetectedEncoding | null {
  const n = Math.min(head.byteLength & ~1, 4096);
  if (n < 16) return null;
  let evenZeros = 0;
  let oddZeros = 0;
  const pairs = n >>> 1;
  for (let i = 0; i < n; i += 2) {
    if (head[i] === 0) evenZeros++;
    if (head[i + 1] === 0) oddZeros++;
  }
  if (oddZeros > pairs * 0.3 && evenZeros < pairs * 0.05) {
    return { encoding: 'utf-16le', bomLength: 0 };
  }
  if (evenZeros > pairs * 0.3 && oddZeros < pairs * 0.05) {
    return { encoding: 'utf-16be', bomLength: 0 };
  }
  return null;
}

function scoreDecodedText(text: string, candidate: SupportedTextEncoding): number {
  if (text.length === 0) return 0;
  let totalNonWs = 0;
  let simpHits = 0;
  let tradHits = 0;
  let kanaHits = 0;
  let hangulHits = 0;
  let latinHits = 0;
  let latinSpaces = 0;
  let cjkPunctHits = 0;
  let rareOrBad = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
      if (code === 0x20) latinSpaces++;
      continue;
    }
    totalNonWs++;
    const ch = text[i]!;

    // Control characters (C0 except tab/LF/CR, DEL, C1 0x80..0x9F), replacement char, PUA
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0xfffd ||
      (code >= 0xe000 && code <= 0xf8ff)
    ) {
      rareOrBad += 4;
      continue;
    }

    // ASCII Latin letters & common ASCII punctuation
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      latinHits++;
      continue;
    }
    if (code >= 0x21 && code <= 0x7e) {
      latinHits += 0.5;
      continue;
    }

    // Hiragana (3040..309F) & Fullwidth Katakana (30A0..30FF)
    if (code >= 0x3040 && code <= 0x30ff) {
      kanaHits += 1.4;
      continue;
    }

    // Halfwidth Katakana (FF65..FF9F) — common mojibake symptom unless Shift_JIS
    if (code >= 0xff65 && code <= 0xff9f) {
      if (candidate === 'shift_jis') kanaHits += 0.4;
      else rareOrBad += 1.5;
      continue;
    }

    // Hangul syllables (AC00..D7A3) — weight common Korean syllables
    if (code >= 0xac00 && code <= 0xd7a3) {
      hangulHits += 1.1;
      continue;
    }

    if (CJK_PUNCT.has(ch)) {
      cjkPunctHits += 1.2;
      continue;
    }

    // CJK Unified Ideographs (4E00..9FFF)
    if (code >= 0x4e00 && code <= 0x9fff) {
      const inSimp = TOP_SIMPLIFIED_HANZI.has(ch);
      const inTrad = TOP_TRADITIONAL_HANZI.has(ch);
      if (inSimp || inTrad) {
        if (inSimp) simpHits += 1.2;
        if (inTrad) tradHits += 1.2;
      } else {
        // Uncommon ideograph: common in garbled cross-CJK decodes (e.g. Big5 decoded as GB18030)
        rareOrBad += 0.65;
      }
      continue;
    }

    // CJK Extension A / Compatibility / Box-drawing / Cyrillic / Greek in CJK candidates
    if (code >= 0x3400 && code <= 0x4dbf) {
      rareOrBad += 1.5;
      continue;
    }

    // Western European Latin-1 supplement & Windows-1252 smart punctuation
    if (
      (code >= 0x00c0 && code <= 0x00ff) ||
      (code >= 0x2013 && code <= 0x2026)
    ) {
      if (candidate === 'windows-1252') {
        latinHits += 0.9;
      } else {
        rareOrBad += 0.5;
      }
      continue;
    }

    rareOrBad += 0.8;
  }

  if (totalNonWs === 0) return 0;

  let naturalHits = cjkPunctHits;
  switch (candidate) {
    case 'gb18030':
      naturalHits += simpHits + latinHits * 0.8;
      break;
    case 'big5':
      naturalHits += tradHits + latinHits * 0.8;
      break;
    case 'shift_jis':
      naturalHits += kanaHits + Math.max(simpHits, tradHits) * 0.85 + latinHits * 0.8;
      break;
    case 'euc-kr':
      naturalHits += hangulHits + latinHits * 0.8;
      break;
    case 'windows-1252': {
      // Genuine Western prose has spaces roughly every 4-8 chars; CJK bytes misinterpreted as Latin-1 have almost no spaces!
      const spaceRatio = latinSpaces / Math.max(1, text.length);
      const spacingFactor = spaceRatio >= 0.08 ? 1.15 : 0.25;
      naturalHits = latinHits * spacingFactor;
      break;
    }
    default:
      naturalHits += latinHits;
      break;
  }

  return (naturalHits - rareOrBad) / totalNonWs;
}

/**
 * Detects text encoding on the first 256 KiB plus two 64 KiB mid-file samples
 * cut at `\n` boundaries (`ARCHITECTURE.md` §4.6):
 *   1. BOM -> UTF-8 / UTF-16LE / UTF-16BE (plus BOM-less UTF-16 null-byte check)
 *   2. Strict `TextDecoder('utf-8', { fatal: true })` -> UTF-8
 *   3. Fatal-mode candidates `gb18030`, `big5`, `shift_jis`, `euc-kr`, `windows-1252`
 *      scored by top-500 Simplified/Traditional/Kana/Hangul/Latin frequency sets; tie -> `gb18030`.
 */
export async function detectTextEncoding(src: ByteSource): Promise<DetectedEncoding> {
  const HEAD_LEN = 256 * 1024;
  const MID_LEN = 64 * 1024;

  const headRaw = await src.read(0, Math.min(src.size, HEAD_LEN));
  const bom = checkBom(headRaw);
  if (bom) return bom;

  const bomless16 = checkBomlessUtf16(headRaw);
  if (bomless16) return bomless16;

  const samples: Uint8Array[] = [
    src.size > HEAD_LEN ? cutSampleAtNewline(headRaw, false, true) : headRaw,
  ];

  if (src.size > HEAD_LEN * 2) {
    const mid1Start = Math.floor(src.size * 0.35);
    const mid1Raw = await src.read(mid1Start, Math.min(MID_LEN, src.size - mid1Start));
    const mid1 = cutSampleAtNewline(mid1Raw, true, true);
    if (mid1.byteLength > 0) samples.push(mid1);

    const mid2Start = Math.floor(src.size * 0.7);
    const mid2Raw = await src.read(mid2Start, Math.min(MID_LEN, src.size - mid2Start));
    const mid2 = cutSampleAtNewline(mid2Raw, true, true);
    if (mid2.byteLength > 0) samples.push(mid2);
  }

  return detectEncodingFromSamples(samples);
}

export function detectEncodingFromBytes(bytes: Uint8Array): DetectedEncoding {
  const bom = checkBom(bytes);
  if (bom) return bom;
  const bomless16 = checkBomlessUtf16(bytes);
  if (bomless16) return bomless16;
  return detectEncodingFromSamples([bytes]);
}

function detectEncodingFromSamples(samples: readonly Uint8Array[]): DetectedEncoding {
  const combined = concatBytes(samples);
  if (combined.byteLength === 0) {
    return { encoding: 'utf-8', bomLength: 0 };
  }

  // Fast check: pure 7-bit ASCII
  let allAscii = true;
  for (let i = 0; i < combined.byteLength; i++) {
    if (combined[i]! >= 0x80) {
      allAscii = false;
      break;
    }
  }
  if (allAscii) {
    return { encoding: 'utf-8', bomLength: 0 };
  }

  // Strict UTF-8 check on every sample independently (since samples are cut on 0x0A)
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    for (const s of samples) {
      utf8.decode(s);
    }
    return { encoding: 'utf-8', bomLength: 0 };
  } catch {
    // Not valid UTF-8; fall through to legacy multi-byte / single-byte candidates
  }

  const candidates: readonly SupportedTextEncoding[] = [
    'gb18030',
    'big5',
    'shift_jis',
    'euc-kr',
    'windows-1252',
  ];

  let bestEncoding: SupportedTextEncoding = 'gb18030';
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder(candidate, { fatal: true });
    } catch {
      continue;
    }
    let decodedAll = '';
    let failed = false;
    for (const s of samples) {
      try {
        decodedAll += decoder.decode(s);
      } catch {
        failed = true;
        break;
      }
    }
    if (failed) continue;

    const score = scoreDecodedText(decodedAll, candidate);
    // Strict `>` preserves `gb18030` as the tie-breaker since it is evaluated first (`§4.6`)
    if (score > bestScore) {
      bestScore = score;
      bestEncoding = candidate;
    }
  }

  return { encoding: bestEncoding, bomLength: 0 };
}

export function decodeBytesWithEncoding(
  bytes: Uint8Array,
  encoding: string,
  bomLength = 0,
): string {
  const slice = bomLength > 0 ? bytes.subarray(bomLength) : bytes;
  const norm = normalizeEncodingLabel(encoding);
  try {
    return new TextDecoder(norm, { fatal: false }).decode(slice);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(slice);
  }
}

export function normalizeEncodingLabel(label: string): string {
  const clean = label.trim().toLowerCase();
  if (!clean || clean === 'utf8' || clean === 'utf-8' || clean === '65001') return 'utf-8';
  if (clean === 'cp1252' || clean === '1252' || clean === 'iso-8859-1' || clean === 'latin1') {
    return 'windows-1252';
  }
  if (clean === 'cp1251' || clean === 'win-1251' || clean === '1251') return 'windows-1251';
  if (clean === 'gb2312' || clean === 'gbk' || clean === 'cp936') return 'gb18030';
  if (clean === 'sjis' || clean === 'ms932' || clean === 'cp932' || clean === 'shift-jis') return 'shift_jis';
  if (clean === 'big-5' || clean === 'cp950') return 'big5';
  return clean;
}
