/**
 * POSIX archive path helpers & MIME sniffing.
 * Clamps `..` to archive root (`ARCHITECTURE.md` §4.3 #6, §13).
 */

export function normalizeArchivePath(rawPath: string): string {
  const replaced = rawPath.replace(/\\/g, '/').trim();
  const segments = replaced.split('/');
  const stack: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(seg);
  }
  return stack.join('/');
}

export function dirnameArchivePath(path: string): string {
  const norm = normalizeArchivePath(path);
  const idx = norm.lastIndexOf('/');
  return idx < 0 ? '' : norm.slice(0, idx);
}

export function splitHrefFragment(href: string): { readonly pathPart: string; readonly fragment: string | null } {
  const hashIdx = href.indexOf('#');
  const rawPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const fragment = hashIdx >= 0 ? href.slice(hashIdx + 1) : null;
  const qIdx = rawPath.indexOf('?');
  const pathPart = qIdx >= 0 ? rawPath.slice(0, qIdx) : rawPath;
  return { pathPart, fragment };
}

export function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Resolves a relative reference `relHref` against `baseDocPath` (e.g. `OEBPS/Styles/main.css`
 * + `../Fonts/Literata.woff2` -> `OEBPS/Fonts/Literata.woff2`), clamping `..` to archive root.
 * Returns `null` for remote (`http:`, `https:`, `//`), `javascript:`, `vbscript:`, `mailto:`, `data:`, etc.
 */
export function resolveArchiveHref(
  baseDocPath: string,
  relHref: string,
): { readonly path: string; readonly fragment: string | null } | null {
  const trimmed = relHref.trim();
  if (!trimmed) return null;
  if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/.test(trimmed)) {
    return null;
  }
  const { pathPart, fragment } = splitHrefFragment(trimmed);
  if (!pathPart) {
    return {
      path: normalizeArchivePath(baseDocPath),
      fragment: fragment !== null ? safeDecodeUriComponent(fragment) : null,
    };
  }
  const decodedPart = safeDecodeUriComponent(pathPart);
  if (decodedPart.startsWith('/')) {
    return {
      path: normalizeArchivePath(decodedPart.slice(1)),
      fragment: fragment !== null ? safeDecodeUriComponent(fragment) : null,
    };
  }
  const baseDir = dirnameArchivePath(baseDocPath);
  const joined = baseDir ? `${baseDir}/${decodedPart}` : decodedPart;
  return {
    path: normalizeArchivePath(joined),
    fragment: fragment !== null ? safeDecodeUriComponent(fragment) : null,
  };
}

export function isRemoteOrExternalScheme(href: string): string | null {
  const trimmed = href.trim();
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (!m) {
    if (trimmed.startsWith('//')) return `https:${trimmed}`;
    return null;
  }
  const scheme = m[1]!.toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') {
    return trimmed;
  }
  return null;
}

export function isSafeDataImageUri(uri: string): boolean {
  return /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(uri.trim());
}

export function mimeFromPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.xhtml') || lower.endsWith('.xht')) return 'application/xhtml+xml';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.css')) return 'text/css';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.avif')) return 'image/avif';
  if (lower.endsWith('.woff2')) return 'font/woff2';
  if (lower.endsWith('.woff')) return 'font/woff';
  if (lower.endsWith('.otf')) return 'font/otf';
  if (lower.endsWith('.ttf')) return 'font/ttf';
  if (lower.endsWith('.xml') || lower.endsWith('.opf') || lower.endsWith('.ncx')) return 'application/xml';
  return 'application/octet-stream';
}

export function mimeFromMagic(bytes: Uint8Array, fallback = 'application/octet-stream'): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }
  if (bytes.length >= 4 && bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46 && bytes[3] === 0x32) {
    return 'font/woff2';
  }
  if (bytes.length >= 4 && bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return 'font/woff';
  }
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x54 && bytes[2] === 0x54 && bytes[3] === 0x4f) {
    return 'font/otf';
  }
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) {
    return 'font/ttf';
  }
  // Check SVG XML text header
  if (bytes.length >= 5) {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(256, bytes.length)));
    if (/<svg[\s>]/i.test(head)) return 'image/svg+xml';
  }
  return fallback;
}
