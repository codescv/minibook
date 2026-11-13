import { MiniBookError } from '../../errors.js';
import { findAll, findFirst, getAttr, localName } from '../../markup/mnode.js';
import { parseXml } from '../../markup/xml-tokenizer.js';
import type { EpubFontObfuscationRule } from '../../types.js';
import { bytesToHex, hexToBytes } from '../../util/base32.js';
import { normalizeArchivePath } from '../../util/path.js';
import { sha1Bytes } from '../../util/sha1.js';

const ALGO_IDPF_FONT = 'http://www.idpf.org/2008/embedding';
const ALGO_ADOBE_FONT = 'http://ns.adobe.com/pdf/enc#rc';

export function deriveIdpfFontKeyHex(uniqueIdentifier: string): string {
  // IDPF spec: trim & collapse whitespace (`\u0020 \u0009 \u000D \u000A`) to single space, UTF-8 SHA-1 (20 bytes)
  const normalized = uniqueIdentifier.replace(/[\u0020\u0009\u000d\u000a]+/g, ' ').trim();
  return bytesToHex(sha1Bytes(normalized));
}

export function deriveAdobeFontKeyHex(uniqueIdentifier: string): string | null {
  // Adobe spec: strip `urn:uuid:` and hyphens, take 16-byte (32 hex chars) UUID key
  const stripped = uniqueIdentifier
    .replace(/^urn:uuid:/i, '')
    .replace(/[^0-9a-fA-F]/g, '');
  if (stripped.length < 32) return null;
  return stripped.slice(0, 32).toLowerCase();
}

/**
 * Parses `META-INF/encryption.xml` (`ARCHITECTURE.md` §4.3 #5):
 *   - Maps IDPF (`http://www.idpf.org/2008/embedding`) and Adobe (`http://ns.adobe.com/pdf/enc#RC`)
 *     obfuscated font entries into `obfuscatedFonts` rules.
 *   - Immediately rejects ANY other `EncryptedData` (ADEPT, FairPlay, LCP, Kobo DRM, encrypted XHTML)
 *     with `MiniBookError('drm-protected', ...)`.
 */
export function parseEpubEncryptionXml(
  encryptionXml: string,
  uniqueIdentifiers: readonly string[],
): Record<string, EpubFontObfuscationRule> {
  const root = parseXml(encryptionXml, { strict: false });
  const encryptedBlocks = findAll(root, (n) => localName(n.tag).toLowerCase() === 'encrypteddata');
  const rules: Record<string, EpubFontObfuscationRule> = {};

  const primaryId = uniqueIdentifiers[0] ?? '';

  for (const block of encryptedBlocks) {
    const methodEl = findFirst(block, (n) => localName(n.tag).toLowerCase() === 'encryptionmethod');
    const cipherRefEl = findFirst(block, (n) => localName(n.tag).toLowerCase() === 'cipherreference');
    const rawAlgo = (methodEl ? getAttr(methodEl, 'Algorithm') : undefined)?.trim() ?? '';
    const rawUri = (cipherRefEl ? getAttr(cipherRefEl, 'URI') : undefined)?.trim() ?? '';
    const algoLower = rawAlgo.toLowerCase();
    const normPath = normalizeArchivePath(decodeURIComponentSafe(rawUri));

    if (algoLower === ALGO_IDPF_FONT.toLowerCase()) {
      if (!primaryId) {
        throw new MiniBookError('corrupt-book', `IDPF obfuscated font "${normPath}" missing OPF unique-identifier`);
      }
      rules[normPath] = {
        algorithm: 'idpf',
        keyHex: deriveIdpfFontKeyHex(primaryId),
      };
      continue;
    }

    if (algoLower === ALGO_ADOBE_FONT) {
      let adobeKey: string | null = null;
      for (const candidate of uniqueIdentifiers) {
        adobeKey = deriveAdobeFontKeyHex(candidate);
        if (adobeKey) break;
      }
      if (!adobeKey) {
        throw new MiniBookError('corrupt-book', `Adobe obfuscated font "${normPath}" missing valid UUID identifier`);
      }
      rules[normPath] = {
        algorithm: 'adobe',
        keyHex: adobeKey,
      };
      continue;
    }

    throw new MiniBookError(
      'drm-protected',
      'This book is copy-protected and cannot be opened.',
      { details: { algorithm: rawAlgo, uri: normPath } },
    );
  }

  return rules;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Applies IDPF (1040 bytes, 20-byte SHA-1 key) or Adobe (1024 bytes, 16-byte UUID key)
 * XOR font de-obfuscation (`ARCHITECTURE.md` §4.3 #5).
 */
export function deobfuscateEpubFont(bytes: Uint8Array, rule: EpubFontObfuscationRule): Uint8Array {
  const key = hexToBytes(rule.keyHex);
  if (key.byteLength === 0) return bytes;
  const prefixBytes = rule.algorithm === 'idpf' ? 1040 : 1024;
  const limit = Math.min(prefixBytes, bytes.byteLength);
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  for (let i = 0; i < limit; i++) {
    out[i] = out[i]! ^ key[i % key.byteLength]!;
  }
  return out;
}
