import type { BookSession, SectionDoc } from '@minibook/core';

const MAX_RESOURCE_BYTES = 32 * 1024 * 1024; // 32 MiB guard (`ARCHITECTURE.md` §6.2)
const PLACEHOLDER_PREFIX = 'mb-res:';

/**
 * Manages `blob:` URL lifecycle for a single rendered unit (`ARCHITECTURE.md` §6.2).
 * Every created object URL is revoked when the unit leaves the 2-frame window.
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
          // Missing embedded asset degrades gracefully to alt text
        }
      }),
    );
  }

  rewriteCss(css: string): string {
    if (!css) return '';
    return css.replace(/mb-res:([^\s"'<>)]+)/g, (_full, path: string) => {
      return this.urls.get(path) ?? 'about:blank';
    });
  }

  applyToDocument(frameDoc: Document): void {
    const elements = frameDoc.querySelectorAll('[src], [href], [xlink\\:href]');
    for (const el of elements) {
      for (const attr of ['src', 'href', 'xlink:href']) {
        const val = el.getAttribute(attr);
        if (!val || !val.startsWith(PLACEHOLDER_PREFIX)) continue;
        const path = val.slice(PLACEHOLDER_PREFIX.length);
        if (this.skippedOversized.has(path)) {
          if (el.tagName.toLowerCase() === 'img') {
            const alt = el.getAttribute('alt') || '';
            const span = frameDoc.createElement('span');
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
    }
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
