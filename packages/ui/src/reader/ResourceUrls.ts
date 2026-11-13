import type { BookSession, SectionDoc } from '@minibook/core';

const MAX_RESOURCE_BYTES = 32 * 1024 * 1024; // 32 MiB guard (`ARCHITECTURE.md` §6.2)
const PLACEHOLDER_PREFIX = 'mb-res:';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/**
 * Manages `blob:` URL lifecycle for a single rendered unit (`ARCHITECTURE.md` §6.2).
 * Handles HTML `src`/`href`, inline `style` `url()`, SVG 2 `href`, AND XML-namespaced
 * `xlink:href` (`http://www.w3.org/1999/xlink`) on Gutenberg/Calibre `<svg><image/></svg>` covers.
 * Applied BEFORE attaching the adopted root to the live `frameDoc` so zero `mb-res:` URLs
 * ever trigger browser speculative fetches or CSP errors (`[P1-U6]`).
 */
export class ResourceUrlScope {
  private readonly urls = new Map<string, string>();
  private readonly skippedOversized = new Set<string>();
  private disposed = false;

  async preloadSectionResources(session: BookSession, doc: SectionDoc): Promise<void> {
    const unique = new Set<string>(doc.resources);
    for (const match of doc.xhtml.matchAll(/mb-res:([^\s"'<>)]+)/g)) {
      if (match[1]) unique.add(match[1]);
    }
    for (const match of doc.css.matchAll(/mb-res:([^\s"'<>)]+)/g)) {
      if (match[1]) unique.add(match[1]);
    }

    await Promise.all(
      [...unique].map(async (href) => {
        if (this.disposed || this.urls.has(href)) return;
        try {
          const res = await session.loadResource(href);
          if (this.disposed) return;
          if (res.bytes.byteLength > MAX_RESOURCE_BYTES) {
            this.skippedOversized.add(href);
            return;
          }
          const copy = new Uint8Array(res.bytes.byteLength);
          copy.set(res.bytes);
          const blob = new Blob([copy], { type: res.mime || 'application/octet-stream' });
          this.urls.set(href, URL.createObjectURL(blob));
        } catch {
          // Missing embedded asset degrades gracefully to alt text / empty
        }
      }),
    );
  }

  rewriteCss(css: string): string {
    if (!css) return '';
    return css.replace(/mb-res:([^\s"'<>)]+)/g, (_full, path: string) => {
      return this.urls.get(path) ?? 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    });
  }

  applyToRoot(root: Document | Element): void {
    const ownerDoc = root.nodeType === 9 ? (root as Document) : root.ownerDocument;
    const elements = root.querySelectorAll('*');

    for (const el of elements) {
      // 1. Standard non-namespaced `src`, `href`, and HTML-parsed literal `xlink:href`
      for (const attr of ['src', 'href', 'xlink:href']) {
        const val = el.getAttribute(attr);
        if (!val || !val.startsWith(PLACEHOLDER_PREFIX)) continue;
        const path = val.slice(PLACEHOLDER_PREFIX.length);
        if (this.skippedOversized.has(path)) {
          if (el.tagName.toLowerCase() === 'img' && ownerDoc) {
            const alt = el.getAttribute('alt') || '';
            const span = ownerDoc.createElement('span');
            span.setAttribute('data-mb-skip', '');
            span.textContent = alt;
            el.replaceWith(span);
          } else {
            el.removeAttribute(attr);
          }
          continue;
        }
        const resolved = this.urls.get(path);
        if (resolved) {
          el.setAttribute(attr, resolved);
        } else {
          el.removeAttribute(attr);
        }
      }

      // 2. XML-namespaced `xlink:href` (`http://www.w3.org/1999/xlink`, e.g. `<svg><image xlink:href="mb-res:..."/></svg>`)
      const xlinkVal = el.getAttributeNS(XLINK_NS, 'href');
      if (xlinkVal && xlinkVal.startsWith(PLACEHOLDER_PREFIX)) {
        const path = xlinkVal.slice(PLACEHOLDER_PREFIX.length);
        const resolved = this.skippedOversized.has(path) ? undefined : this.urls.get(path);
        if (resolved) {
          el.setAttributeNS(XLINK_NS, 'xlink:href', resolved);
          if (el.localName === 'image' && !el.hasAttribute('href')) {
            el.setAttribute('href', resolved);
          }
        } else {
          el.removeAttributeNS(XLINK_NS, 'href');
        }
      }

      // 3. Inline `style="...url(mb-res:...)"` attributes
      const inlineStyle = el.getAttribute('style');
      if (inlineStyle && inlineStyle.includes(PLACEHOLDER_PREFIX)) {
        el.setAttribute('style', this.rewriteCss(inlineStyle));
      }
    }
  }

  applyToDocument(frameDoc: Document): void {
    this.applyToRoot(frameDoc);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const url of this.urls.values()) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
    this.urls.clear();
  }
}
