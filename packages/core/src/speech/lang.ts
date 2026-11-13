/**
 * Per-utterance BCP-47 language resolver (`ARCHITECTURE.md` §8.1 #7):
 *   1. Nearest `lang` / `xml:lang` from the `TextBlock`
 *   2. Script heuristic on the sentence characters:
 *        - Hiragana / Katakana -> `'ja'`
 *        - Hangul -> `'ko'`
 *        - Han ideographs -> `bookLang` if `zh*` or `ja*`, else `'zh-CN'`
 *        - Cyrillic -> `bookLang` if `ru*`/`uk*`/`bg*`, else `'ru'`
 *   3. `bookLang` from metadata, else `'en'`.
 *
 * Mixed CJK + English inside a single sentence is NOT split by script (spoken by the CJK voice).
 */
export function resolveUtteranceLang(
  sentenceText: string,
  blockLang: string | null | undefined,
  bookLang: string | null | undefined,
): string {
  const normBlock = normalizeBcp47(blockLang);
  const normBook = normalizeBcp47(bookLang);

  let hasKana = false;
  let hasHangul = false;
  let hasHan = false;
  let hasCyrillic = false;

  for (let i = 0; i < sentenceText.length; i++) {
    const c = sentenceText.charCodeAt(i);
    if ((c >= 0x3040 && c <= 0x309f) || (c >= 0x30a0 && c <= 0x30ff)) {
      hasKana = true;
      break; // Kana unambiguously identifies Japanese even when Han + Latin are mixed in
    }
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)) {
      hasHangul = true;
    } else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) {
      hasHan = true;
    } else if (c >= 0x0400 && c <= 0x04ff) {
      hasCyrillic = true;
    }
  }

  // Script overrides generic Latin block tags when embedded CJK appears, while honoring specific regional tags (`zh-TW`, `zh-HK`)
  if (hasKana) {
    if (normBlock?.startsWith('ja')) return normBlock;
    if (normBook?.startsWith('ja')) return normBook;
    return 'ja';
  }
  if (hasHangul) {
    if (normBlock?.startsWith('ko')) return normBlock;
    if (normBook?.startsWith('ko')) return normBook;
    return 'ko';
  }
  if (hasHan) {
    if (normBlock && (normBlock.startsWith('zh') || normBlock.startsWith('ja'))) return normBlock;
    if (normBook && (normBook.startsWith('zh') || normBook.startsWith('ja'))) return normBook;
    return 'zh-CN';
  }
  if (normBlock) return normBlock;
  if (hasCyrillic) {
    if (normBook && /^(?:ru|uk|bg|sr|be)\b/i.test(normBook)) return normBook;
    return 'ru';
  }
  return normBook ?? 'en';
}

export function normalizeBcp47(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const cleaned = tag.trim().replace(/_/g, '-');
  if (!cleaned) return null;
  const parts = cleaned.split('-');
  if (parts.length === 1) return parts[0]!.toLowerCase();
  return [
    parts[0]!.toLowerCase(),
    ...parts.slice(1).map((p) => (p.length === 2 ? p.toUpperCase() : p)),
  ].join('-');
}

export function containsCjkCharacters(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (
      (c >= 0x3040 && c <= 0x30ff) ||
      (c >= 0x3400 && c <= 0x9fff) ||
      (c >= 0xac00 && c <= 0xd7a3)
    ) {
      return true;
    }
  }
  return false;
}
