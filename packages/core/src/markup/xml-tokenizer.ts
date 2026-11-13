import { MiniBookError } from '../errors.js';
import { decodeEntities } from './entities.js';
import { el, localName, MAX_MARKUP_DEPTH, type MElement, type MNamespace, txt } from './mnode.js';

export interface XmlParseOptions {
  /**
   * When `true` (used for EPUB XHTML before falling back to `parse5`), throws on
   * mismatched closing tags or unclosed elements. When `false` (default for OPF, NCX, FB2),
   * recovers tolerantly.
   */
  readonly strict?: boolean;
  /** Lower-cases tag names when namespace is `xhtml` (default `false` for raw XML, `true` for XHTML). */
  readonly lowercaseXhtmlTags?: boolean;
}

function isWs(ch: number): boolean {
  return ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d;
}

function isNameChar(ch: number): boolean {
  return (
    (ch >= 0x41 && ch <= 0x5a) ||
    (ch >= 0x61 && ch <= 0x7a) ||
    (ch >= 0x30 && ch <= 0x39) ||
    ch === 0x3a || // :
    ch === 0x5f || // _
    ch === 0x2d || // -
    ch === 0x2e || // .
    ch >= 0x80
  );
}

function inferNamespace(tag: string, attrs: Record<string, string>, parentNs: MNamespace): MNamespace {
  const xmlns = attrs['xmlns'];
  if (xmlns === 'http://www.w3.org/2000/svg') return 'svg';
  if (xmlns === 'http://www.w3.org/1998/Math/MathML') return 'math';
  if (xmlns === 'http://www.w3.org/1999/xhtml') return 'xhtml';
  const loc = localName(tag).toLowerCase();
  if (loc === 'svg') return 'svg';
  if (loc === 'math') return 'math';
  return parentNs;
}

/**
 * Extract `encoding="..."` from an `<?xml ...?>` declaration on raw header bytes.
 */
export function sniffXmlDeclarationEncoding(headBytes: Uint8Array): string | null {
  const n = Math.min(headBytes.byteLength, 512);
  let start = 0;
  if (n >= 3 && headBytes[0] === 0xef && headBytes[1] === 0xbb && headBytes[2] === 0xbf) {
    return 'utf-8';
  }
  if (n >= 2 && headBytes[0] === 0xff && headBytes[1] === 0xfe) return 'utf-16le';
  if (n >= 2 && headBytes[0] === 0xfe && headBytes[1] === 0xff) return 'utf-16be';
  let ascii = '';
  for (let i = start; i < n; i++) {
    const b = headBytes[i]!;
    if (b === 0) continue;
    ascii += String.fromCharCode(b);
  }
  const m = /^<\?xml\b[^>]*?\bencoding\s*=\s*["']([^"']+)["']/i.exec(ascii.trim());
  return m ? m[1]!.trim() : null;
}

/**
 * Pure-TS XML tokenizer & tree builder (`ARCHITECTURE.md` §4.3, §4.5, §5.2, §13):
 *   - Completely ignores `<!DOCTYPE ...>` (including internal `[...]` entity subsets),
 *     making it immune to XXE and Billion Laughs expansion attacks.
 *   - Supports `<![CDATA[...]]>`, `<!--...-->`, `<?...?>`, namespaces, and numeric/named entities.
 */
export function parseXml(source: string, options?: XmlParseOptions): MElement {
  const strict = options?.strict ?? false;
  const lowerXhtml = options?.lowercaseXhtmlTags ?? false;
  const len = source.length;
  let i = 0;
  // Strip UTF-8 BOM char if present
  if (len > 0 && source.charCodeAt(0) === 0xfeff) i = 1;

  const virtualRoot: MElement = el('#document', {}, [], 'xhtml');
  const stack: MElement[] = [virtualRoot];

  const pushText = (raw: string) => {
    if (!raw) return;
    const decoded = decodeEntities(raw);
    if (!decoded) return;
    const top = stack[stack.length - 1]!;
    if (top === virtualRoot) {
      if (strict && decoded.trim().length > 0) {
        throw new MiniBookError('corrupt-book', 'Text outside root XML element');
      }
      return;
    }
    const prev = top.children[top.children.length - 1];
    if (prev && prev.type === 'text') {
      prev.value += decoded;
    } else {
      top.children.push(txt(decoded));
    }
  };

  while (i < len) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      pushText(source.slice(i));
      break;
    }
    if (lt > i) {
      pushText(source.slice(i, lt));
    }
    i = lt;

    // Comment `<!-- ... -->`
    if (source.startsWith('<!--', i)) {
      const close = source.indexOf('-->', i + 4);
      if (close < 0) {
        if (strict) throw new MiniBookError('corrupt-book', 'Unterminated XML comment');
        break;
      }
      i = close + 3;
      continue;
    }

    // CDATA `<![CDATA[ ... ]]>`
    if (source.startsWith('<![CDATA[', i)) {
      const close = source.indexOf(']]>', i + 9);
      if (close < 0) {
        if (strict) throw new MiniBookError('corrupt-book', 'Unterminated CDATA section');
        const rawCdata = source.slice(i + 9);
        const top = stack[stack.length - 1]!;
        if (top !== virtualRoot && rawCdata) top.children.push(txt(rawCdata));
        break;
      }
      const rawCdata = source.slice(i + 9, close);
      const top = stack[stack.length - 1]!;
      if (top !== virtualRoot && rawCdata) {
        const prev = top.children[top.children.length - 1];
        if (prev && prev.type === 'text') prev.value += rawCdata;
        else top.children.push(txt(rawCdata));
      }
      i = close + 3;
      continue;
    }

    // Processing Instruction `<? ... ?>`
    if (source.startsWith('<?', i)) {
      const close = source.indexOf('?>', i + 2);
      if (close < 0) {
        const gt = source.indexOf('>', i + 2);
        i = gt < 0 ? len : gt + 1;
      } else {
        i = close + 2;
      }
      continue;
    }

    // DOCTYPE or other `<! ... >` declaration — skip completely including `[...]` subset!
    if (source.startsWith('<!', i)) {
      i += 2;
      let bracketDepth = 0;
      let quote = 0;
      while (i < len) {
        const ch = source.charCodeAt(i);
        if (quote !== 0) {
          if (ch === quote) quote = 0;
        } else if (ch === 0x22 || ch === 0x27) {
          quote = ch;
        } else if (ch === 0x5b) {
          bracketDepth++;
        } else if (ch === 0x5d) {
          if (bracketDepth > 0) bracketDepth--;
        } else if (ch === 0x3e && bracketDepth === 0) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Closing tag `</tag>`
    if (source.startsWith('</', i)) {
      i += 2;
      while (i < len && isWs(source.charCodeAt(i))) i++;
      const nameStart = i;
      while (i < len && isNameChar(source.charCodeAt(i))) i++;
      const rawCloseName = source.slice(nameStart, i);
      const gt = source.indexOf('>', i);
      if (gt < 0) {
        if (strict) throw new MiniBookError('corrupt-book', 'Unterminated closing tag');
        break;
      }
      i = gt + 1;

      const top = stack[stack.length - 1]!;
      const closeNorm = lowerXhtml && top.ns === 'xhtml' ? rawCloseName.toLowerCase() : rawCloseName;
      if (stack.length <= 1) {
        if (strict) throw new MiniBookError('corrupt-book', `Unexpected closing tag </${rawCloseName}>`);
        continue;
      }
      if (top.tag === closeNorm || (!strict && top.tag.toLowerCase() === rawCloseName.toLowerCase())) {
        stack.pop();
      } else if (strict) {
        throw new MiniBookError('corrupt-book', `Mismatched XML closing tag </${rawCloseName}> for <${top.tag}>`);
      } else {
        // Tolerant recovery: pop until matching ancestor if present
        let matchIdx = -1;
        for (let k = stack.length - 1; k >= 1; k--) {
          if (stack[k]!.tag.toLowerCase() === rawCloseName.toLowerCase()) {
            matchIdx = k;
            break;
          }
        }
        if (matchIdx >= 1) {
          stack.length = matchIdx;
        }
      }
      continue;
    }

    // Opening tag `<tag attr="val" ...>`
    i += 1;
    if (i >= len || !isNameChar(source.charCodeAt(i))) {
      if (strict) throw new MiniBookError('corrupt-book', 'Unescaped < in XML text');
      pushText('<');
      continue;
    }
    const tagStart = i;
    while (i < len && isNameChar(source.charCodeAt(i))) i++;
    const rawTag = source.slice(tagStart, i);

    const attrs: Record<string, string> = {};
    let selfClosing = false;

    while (i < len) {
      while (i < len && isWs(source.charCodeAt(i))) i++;
      if (i >= len) {
        if (strict) throw new MiniBookError('corrupt-book', `Unterminated start tag <${rawTag}>`);
        break;
      }
      const c = source.charCodeAt(i);
      if (c === 0x3e) {
        // `>`
        i++;
        break;
      }
      if (c === 0x2f && source.charCodeAt(i + 1) === 0x3e) {
        // `/>`
        selfClosing = true;
        i += 2;
        break;
      }
      if (!isNameChar(c)) {
        if (strict) throw new MiniBookError('corrupt-book', `Malformed attribute in <${rawTag}>`);
        i++;
        continue;
      }
      const attrStart = i;
      while (i < len && isNameChar(source.charCodeAt(i))) i++;
      const attrName = source.slice(attrStart, i);
      while (i < len && isWs(source.charCodeAt(i))) i++;
      if (source.charCodeAt(i) === 0x3d) {
        // `=`
        i++;
        while (i < len && isWs(source.charCodeAt(i))) i++;
        const q = source.charCodeAt(i);
        if (q === 0x22 || q === 0x27) {
          i++;
          const valStart = i;
          const qChar = q === 0x22 ? '"' : "'";
          const valEnd = source.indexOf(qChar, i);
          if (valEnd < 0) {
            if (strict) throw new MiniBookError('corrupt-book', `Unterminated attribute value in <${rawTag}>`);
            attrs[attrName] = decodeEntities(source.slice(valStart));
            i = len;
            break;
          }
          attrs[attrName] = decodeEntities(source.slice(valStart, valEnd));
          i = valEnd + 1;
        } else {
          if (strict) throw new MiniBookError('corrupt-book', `Unquoted attribute ${attrName} in XML`);
          const valStart = i;
          while (i < len && !isWs(source.charCodeAt(i)) && source.charCodeAt(i) !== 0x3e) i++;
          attrs[attrName] = decodeEntities(source.slice(valStart, i));
        }
      } else {
        if (strict) throw new MiniBookError('corrupt-book', `Boolean attribute ${attrName} without value in XML`);
        attrs[attrName] = '';
      }
    }

    const parent = stack[stack.length - 1]!;
    if (stack.length > MAX_MARKUP_DEPTH) {
      throw new MiniBookError('corrupt-book', `XML element nesting exceeds maximum depth (${MAX_MARKUP_DEPTH})`);
    }
    const ns = inferNamespace(rawTag, attrs, parent.ns);
    const normalizedTag = lowerXhtml && ns === 'xhtml' ? rawTag.toLowerCase() : rawTag;
    const node = el(normalizedTag, attrs, [], ns);
    parent.children.push(node);
    if (!selfClosing) {
      stack.push(node);
    }
  }

  if (strict && stack.length !== 1) {
    throw new MiniBookError('corrupt-book', `Unclosed XML element <${stack[stack.length - 1]!.tag}>`);
  }

  const rootElement = virtualRoot.children.find((c): c is MElement => c.type === 'element');
  if (!rootElement) {
    throw new MiniBookError('corrupt-book', 'XML document contains no root element');
  }
  return rootElement;
}
