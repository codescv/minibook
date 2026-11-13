/**
 * Rule-based English letter-to-sound fallback for OOV words (`TTS_V2_SPEC.md` §4.5).
 * Emits ONLY symbols present in `KOKORO_VOCAB` (misaki US phoneme set).
 */

const VOWEL_LETTERS = 'aeiouy';
const VOWEL_PH = new Set('AIOWYiuæɑɔəɛɜɪʊʌ');

function isVowelLetter(c: string | undefined): boolean {
  return c !== undefined && VOWEL_LETTERS.includes(c);
}

export function englishLts(word: string): string | null {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return null;
  const n = w.length;
  let out = '';
  const magicE = (i: number): boolean =>
    i + 2 === n - 1 && !isVowelLetter(w[i + 1]) && w[i + 2] === 'e';

  for (let i = 0; i < n; ) {
    const c = w[i]!;
    const d = w[i + 1];
    const e = w[i + 2];
    const rest = w.slice(i);
    const isLast = i === n - 1;
    let p: string | null = null;
    let k = 1;

    const matchRule = (re: RegExp, ph: string) => {
      if (p === null) {
        const x = re.exec(rest);
        if (x) {
          p = ph;
          k = x[0].length;
        }
      }
    };

    matchRule(/^tion/, 'ʃən');
    matchRule(/^sion/, 'ʒən');
    matchRule(/^ture$/, 'ʧəɹ');
    matchRule(/^ous$/, 'əs');
    matchRule(/^tch/, 'ʧ');
    matchRule(/^dge/, 'ʤ');
    matchRule(/^igh/, 'I');
    matchRule(/^ough/, 'O');
    matchRule(/^augh/, 'ɔ');
    matchRule(/^sch/, 'sk');
    matchRule(/^ch/, 'ʧ');
    matchRule(/^sh/, 'ʃ');
    matchRule(/^th/, 'θ');
    matchRule(/^ph/, 'f');
    matchRule(/^wh/, 'w');
    matchRule(/^ck/, 'k');
    matchRule(/^qu/, 'kw');
    matchRule(/^zh/, 'ʒ');
    matchRule(/^ng(?![aeiouy])/, 'ŋ');
    matchRule(/^gh/, i === 0 ? 'ɡ' : '');
    if (p === null && i === 0) {
      matchRule(/^kn/, 'n');
      matchRule(/^wr/, 'ɹ');
      matchRule(/^ps/, 's');
    }
    if (p === null && c === d && !isVowelLetter(c)) {
      p = '';
    }

    if (p === null) {
      const hasPriorVowel = out.length > 0 && Array.from(out).some((x) => VOWEL_PH.has(x));
      switch (c) {
        case 'a':
          if (d === 'r' && !isVowelLetter(e)) {
            p = 'ɑɹ';
            k = 2;
          } else if (d === 'i' || d === 'y') {
            p = 'A';
            k = 2;
          } else if (d === 'u' || d === 'w') {
            p = 'ɔ';
            k = 2;
          } else if (magicE(i)) {
            p = 'A';
          } else if (isLast && n > 2) {
            p = 'ə';
          } else {
            p = 'æ';
          }
          break;
        case 'e':
          if (d === 'e' || d === 'a') {
            p = 'i';
            k = 2;
          } else if (d === 'r' && !isVowelLetter(e)) {
            p = hasPriorVowel ? 'əɹ' : 'ɜɹ';
            k = 2;
          } else if (d === 'w') {
            p = 'u';
            k = 2;
          } else if (d === 'y' && i + 2 === n) {
            p = 'i';
            k = 2;
          } else if (d === 'i' || d === 'y') {
            p = 'A';
            k = 2;
          } else if (isLast && hasPriorVowel) {
            p = '';
          } else if (magicE(i) || isLast) {
            p = 'i';
          } else {
            p = 'ɛ';
          }
          break;
        case 'i':
          if (d === 'r' && !isVowelLetter(e)) {
            p = 'ɜɹ';
            k = 2;
          } else if (d === 'e' && i + 2 === n) {
            p = 'i';
            k = 2;
          } else if (magicE(i)) {
            p = 'I';
          } else if (isLast && n > 2) {
            p = 'i';
          } else {
            p = 'ɪ';
          }
          break;
        case 'o':
          if (d === 'o') {
            p = 'u';
            k = 2;
          } else if (d === 'w' && i + 2 === n) {
            p = 'O';
            k = 2;
          } else if (d === 'u' || d === 'w') {
            p = 'W';
            k = 2;
          } else if (d === 'i' || d === 'y') {
            p = 'Y';
            k = 2;
          } else if (d === 'a') {
            p = 'O';
            k = 2;
          } else if (d === 'r') {
            p = 'ɔɹ';
            k = 2;
          } else if (magicE(i) || isLast) {
            p = 'O';
          } else {
            p = 'ɑ';
          }
          break;
        case 'u':
          if (d === 'r' && !isVowelLetter(e)) {
            p = 'ɜɹ';
            k = 2;
          } else if (d === 'e' && i + 2 === n) {
            p = 'u';
            k = 2;
          } else if (magicE(i)) {
            p = 'u';
          } else {
            p = 'ʌ';
          }
          break;
        case 'y':
          p = i === 0 && isVowelLetter(d) ? 'j' : isLast ? (hasPriorVowel ? 'i' : 'I') : 'ɪ';
          break;
        case 'c':
          p = d === 'e' || d === 'i' || d === 'y' ? 's' : 'k';
          break;
        case 'g':
          p = i > 0 && (d === 'e' || d === 'i' || d === 'y') ? 'ʤ' : 'ɡ';
          break;
        case 'l':
          if (d === 'e' && i + 2 === n && i > 0 && !isVowelLetter(w[i - 1])) {
            p = 'ᵊl';
            k = 2;
          } else {
            p = 'l';
          }
          break;
        case 's': {
          const prev = i > 0 ? w[i - 1] : undefined;
          p =
            isLast && prev !== undefined && (isVowelLetter(prev) || 'bdglmnrv'.includes(prev))
              ? 'z'
              : 's';
          break;
        }
        case 'h':
          p = i > 0 && isVowelLetter(w[i - 1]) && !isVowelLetter(d) ? '' : 'h';
          break;
        case 'j':
          p = 'ʤ';
          break;
        case 'q':
          p = 'k';
          break;
        case 'r':
          p = 'ɹ';
          break;
        case 'x':
          p = i === 0 ? 'z' : 'ks';
          break;
        default:
          p = c;
      }
    }
    out += p;
    i += k;
  }

  const chars = Array.from(out.replace(/ɹɹ/g, 'ɹ'));
  const fi = chars.findIndex((x) => VOWEL_PH.has(x));
  if (fi >= 0) chars.splice(fi, 0, 'ˈ');
  return chars.join('');
}

export function createEnglishOovFallback(
  spellLetters: (word: string) => string | null,
): (word: string) => string | null {
  return (word: string): string | null => {
    const letters = word.replace(/[^A-Za-z]/g, '');
    if (!letters) return null;
    if (
      (letters === letters.toUpperCase() && letters.length <= 5) ||
      !/[aeiouyAEIOUY]/.test(letters)
    ) {
      return spellLetters(letters);
    }
    return englishLts(letters);
  };
}
