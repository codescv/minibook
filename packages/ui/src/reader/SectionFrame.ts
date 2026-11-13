import type { AppSettings, BookSession, Locator, SectionDoc } from '@minibook/core';
import { handleGlobalKeyDown } from '../app/keymap';
import { freezeAnimatedImages } from '../eink/freeze-images';
import { Highlighter } from './Highlighter';
import { getLiterataFrameFontCss } from './literata-blobs';
import { computePaginationGeometry, Paginator, type PaginationGeometry } from './Paginator';
import { ResourceUrlScope } from './ResourceUrls';
import { TextMap } from './TextMap';
import { buildFrameUserStylesheet } from './user-stylesheet';

export const FRAME_CSP_CONTENT =
  "default-src 'none'; script-src 'none'; connect-src 'none'; img-src blob: data:; font-src blob: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

let cachedSandboxValue: string | null = null;

/**
 * Startup probe for WebKit bug 218086 (`ARCHITECTURE.md` §6.1):
 * Checks whether a parent-attached event listener fires inside a script-less
 * `sandbox="allow-same-origin"` `about:blank` iframe. Even when `allow-scripts`
 * is required on older WebKit, layer 3 (`script-src 'none'` CSP meta) + layer 1
 * (sanitizer) + `DOMParser` adoption prevent any script from executing.
 */
export function resolveFrameSandboxAttribute(hostDoc: Document = document): string {
  if (cachedSandboxValue !== null) return cachedSandboxValue;
  try {
    const probe = hostDoc.createElement('iframe');
    probe.setAttribute('sandbox', 'allow-same-origin');
    probe.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;';
    hostDoc.body.appendChild(probe);
    const fDoc = probe.contentDocument;
    let fired = false;
    if (fDoc) {
      fDoc.addEventListener('mb-sandbox-probe', () => {
        fired = true;
      });
      fDoc.dispatchEvent(new Event('mb-sandbox-probe'));
    }
    probe.remove();
    cachedSandboxValue = fired ? 'allow-same-origin' : 'allow-same-origin allow-scripts';
  } catch {
    cachedSandboxValue = 'allow-same-origin';
  }
  return cachedSandboxValue;
}

export interface FrameGestureCallbacks {
  onPrevPage(): void;
  onNextPage(): void;
  onToggleChrome(): void;
  onInternalLink(rawTarget: string): void;
  onExternalLink(url: string): void;
  onImageZoom(src: string, alt: string): void;
  onSelectionChange(selection: { text: string; locator: Locator } | null): void;
  onReadAloudTapLocator(locator: Locator): boolean;
  onContentRelayout?(): void;
}

export interface FilledFrameUnit {
  readonly iframe: HTMLIFrameElement;
  readonly frameDoc: Document;
  readonly sectionDoc: SectionDoc;
  readonly textMap: TextMap;
  readonly paginator: Paginator;
  readonly highlighter: Highlighter;
  readonly resources: ResourceUrlScope;
  updateStylesAndLayout(settings: AppSettings, isEink: boolean, geom: PaginationGeometry): void;
  dispose(): void;
}

function stripExecutableNodes(root: ParentNode): void {
  const forbidden = root.querySelectorAll(
    'script, iframe, object, embed, applet, meta, base, link, frame',
  );
  for (const el of forbidden) el.remove();
  const all = root.querySelectorAll('*');
  for (const el of all) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const val = attr.value.trim();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction' || name === 'srcset' || name === 'ping') {
        el.removeAttribute(attr.name);
      } else if (
        (name === 'src' || name === 'href' || name === 'xlink:href') &&
        /^\s*(javascript|vbscript):/i.test(val)
      ) {
        el.removeAttribute(attr.name);
      } else if (
        (name === 'src' ||
          name === 'xlink:href' ||
          (name === 'href' &&
            (el.localName === 'image' || el.localName === 'use' || el.localName === 'feImage'))) &&
        val !== '' &&
        !val.startsWith('#') &&
        !val.startsWith('mb-res:') &&
        !val.startsWith('blob:') &&
        !/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);/i.test(val)
      ) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

function parseBookXhtml(xhtml: string, lang: string | null, dir: 'ltr' | 'rtl'): Document {
  const langAttr = lang ? ` xml:lang="${lang}" lang="${lang}"` : '';
  const wrapped = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"${langAttr} dir="${dir}"><head></head><body>${xhtml}</body></html>`;
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(wrapped, 'application/xhtml+xml');
  if (!xmlDoc.querySelector('parsererror')) {
    return xmlDoc;
  }
  const htmlDoc = parser.parseFromString(
    `<!DOCTYPE html><html${lang ? ` lang="${lang}"` : ''} dir="${dir}"><head></head><body>${xhtml}</body></html>`,
    'text/html',
  );
  return htmlDoc;
}

/**
 * Manages the 2-iframe render window (visible + pre-rendered adjacent unit)
 * with 4-layer security isolation and direct `frameDoc` gesture bridging (`ARCHITECTURE.md` §6.1).
 */
export class SectionFrameManager {
  private readonly stageEl: HTMLElement;
  private readonly callbacks: FrameGestureCallbacks;
  private activeUnit: FilledFrameUnit | null = null;
  private prerenderUnit: FilledFrameUnit | null = null;

  constructor(stageEl: HTMLElement, callbacks: FrameGestureCallbacks) {
    this.stageEl = stageEl;
    this.callbacks = callbacks;
  }

  getActive(): FilledFrameUnit | null {
    return this.activeUnit;
  }

  getPrerender(): FilledFrameUnit | null {
    return this.prerenderUnit;
  }

  async renderActive(options: {
    readonly session: BookSession;
    readonly sectionDoc: SectionDoc;
    readonly settings: AppSettings;
    readonly isEink: boolean;
    readonly frameWidth: number;
    readonly frameHeight: number;
    readonly safeTop: number;
    readonly safeBottom: number;
  }): Promise<FilledFrameUnit> {
    // Fast-swap if pre-rendered unit already matches `(section, unit.start)`
    if (
      this.prerenderUnit &&
      this.prerenderUnit.sectionDoc.index === options.sectionDoc.index &&
      this.prerenderUnit.sectionDoc.unit.start === options.sectionDoc.unit.start
    ) {
      const promoted = this.prerenderUnit;
      this.prerenderUnit = null;
      this.activeUnit?.dispose();
      this.activeUnit = promoted;
      const geom = computePaginationGeometry({
        frameWidth: options.frameWidth,
        frameHeight: options.frameHeight,
        fontScale: options.settings.fontScale,
        margins: options.settings.margins,
        safeTop: options.safeTop,
        safeBottom: options.safeBottom,
        isEink: options.isEink,
        ...(options.sectionDoc.isCoverLike !== undefined
          ? { isCoverLike: options.sectionDoc.isCoverLike }
          : {}),
      });
      promoted.updateStylesAndLayout(options.settings, options.isEink, geom);
      this.positionIframe(promoted.iframe, options.frameWidth, geom, true);
      return promoted;
    }

    const unit = await this.createFilledUnit(options, true);
    this.activeUnit?.dispose();
    this.activeUnit = unit;
    return unit;
  }

  async prerenderAdjacent(options: {
    readonly session: BookSession;
    readonly sectionDoc: SectionDoc;
    readonly settings: AppSettings;
    readonly isEink: boolean;
    readonly frameWidth: number;
    readonly frameHeight: number;
    readonly safeTop: number;
    readonly safeBottom: number;
  }): Promise<void> {
    if (
      this.prerenderUnit &&
      this.prerenderUnit.sectionDoc.index === options.sectionDoc.index &&
      this.prerenderUnit.sectionDoc.unit.start === options.sectionDoc.unit.start
    ) {
      return;
    }
    this.prerenderUnit?.dispose();
    this.prerenderUnit = null;
    try {
      this.prerenderUnit = await this.createFilledUnit(options, false);
    } catch {
      // Non-fatal pre-render failure
    }
  }

  private positionIframe(
    iframe: HTMLIFrameElement,
    containerWidth: number,
    geom: PaginationGeometry,
    visible: boolean,
  ): void {
    const leftOffset = Math.max(0, Math.floor((containerWidth - geom.Vw) / 2));
    iframe.style.width = `${geom.Vw}px`;
    iframe.style.height = `${geom.Vh}px`;
    iframe.style.left = `${leftOffset}px`;
    iframe.style.visibility = visible ? 'visible' : 'hidden';
    iframe.style.pointerEvents = visible ? 'auto' : 'none';
    iframe.style.zIndex = visible ? '2' : '1';
  }

  private async createFilledUnit(
    options: {
      readonly session: BookSession;
      readonly sectionDoc: SectionDoc;
      readonly settings: AppSettings;
      readonly isEink: boolean;
      readonly frameWidth: number;
      readonly frameHeight: number;
      readonly safeTop: number;
      readonly safeBottom: number;
    },
    visible: boolean,
  ): Promise<FilledFrameUnit> {
    const hostDoc = this.stageEl.ownerDocument;
    const iframe = hostDoc.createElement('iframe');
    iframe.className = 'mb-reader-frame';
    iframe.setAttribute('sandbox', resolveFrameSandboxAttribute(hostDoc));
    iframe.setAttribute('title', options.sectionDoc.text.text.slice(0, 48) || 'Book page');
    iframe.src = 'about:blank';

    const geom = computePaginationGeometry({
      frameWidth: options.frameWidth,
      frameHeight: options.frameHeight,
      fontScale: options.settings.fontScale,
      margins: options.settings.margins,
      safeTop: options.safeTop,
      safeBottom: options.safeBottom,
      isEink: options.isEink,
      ...(options.sectionDoc.isCoverLike !== undefined
        ? { isCoverLike: options.sectionDoc.isCoverLike }
        : {}),
    });

    this.positionIframe(iframe, options.frameWidth, geom, visible);
    this.stageEl.appendChild(iframe);

    const frameDoc = iframe.contentDocument;
    if (!frameDoc) {
      iframe.remove();
      throw new Error('Unable to initialize SectionFrame document');
    }

    // Initialize blank frame in Standards Mode (`CSS1Compat`) with Layer-3 CSP BEFORE any book content exists (`§6.1`)
    frameDoc.open();
    frameDoc.write(
      `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP_CONTENT}"></head><body></body></html>`,
    );
    frameDoc.close();

    const [literataFontCss, resources] = await Promise.all([
      getLiterataFrameFontCss(),
      (async () => {
        const scope = new ResourceUrlScope();
        await scope.preloadSectionResources(options.session, options.sectionDoc);
        return scope;
      })(),
    ]);

    const parsed = parseBookXhtml(
      options.sectionDoc.xhtml,
      options.sectionDoc.lang,
      options.sectionDoc.dir,
    );
    stripExecutableNodes(parsed);

    const adoptedRoot = frameDoc.adoptNode(parsed.documentElement);
    let head = adoptedRoot.querySelector('head');
    if (!head) {
      head = frameDoc.createElement('head');
      adoptedRoot.insertBefore(head, adoptedRoot.firstChild);
    }

    const cspMeta = frameDoc.createElement('meta');
    cspMeta.setAttribute('http-equiv', 'Content-Security-Policy');
    cspMeta.setAttribute('content', FRAME_CSP_CONTENT);
    head.insertBefore(cspMeta, head.firstChild);

    const pubStyle = frameDoc.createElement('style');
    pubStyle.id = 'mb-publisher-css';
    pubStyle.textContent = resources.rewriteCss(options.sectionDoc.css);
    head.appendChild(pubStyle);

    const userStyle = frameDoc.createElement('style');
    userStyle.id = 'mb-user-css';
    userStyle.textContent = buildFrameUserStylesheet({
      settings: options.settings,
      isEink: options.isEink,
      geom,
      bookLang: options.sectionDoc.lang,
      ...(options.sectionDoc.isCoverLike !== undefined
        ? { isCoverLike: options.sectionDoc.isCoverLike }
        : {}),
      literataFontCss,
    });
    head.appendChild(userStyle);

    // Rewrite all `mb-res:` placeholders (incl. XML-namespaced `<image xlink:href="mb-res:...">`)
    // BEFORE attaching `adoptedRoot` to `frameDoc` so zero `mb-res:` URLs trigger CSP errors (`[P1-U6]`).
    resources.applyToRoot(adoptedRoot);
    frameDoc.replaceChild(adoptedRoot, frameDoc.documentElement);
    if (options.isEink) {
      freezeAnimatedImages(frameDoc);
    }

    // Wait for font readiness capped at 1.5s (`ARCHITECTURE.md` §6.3)
    if (frameDoc.fonts?.ready) {
      let settledBeforeCap = false;
      await Promise.race([
        frameDoc.fonts.ready.then(() => {
          settledBeforeCap = true;
        }),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
      if (!settledBeforeCap) {
        void frameDoc.fonts.ready.then(() => {
          this.callbacks.onContentRelayout?.();
        });
      }
    }

    const textMap = new TextMap(frameDoc.body, options.sectionDoc.text.text);
    const paginator = new Paginator({
      frameDoc,
      textMap,
      sectionDoc: options.sectionDoc,
      geometry: geom,
    });
    const highlighter = new Highlighter({
      frameDoc,
      textMap,
      sectionDoc: options.sectionDoc,
    });

    const detachGestures = this.attachFrameGestures(frameDoc, paginator, options.sectionDoc);

    let disposed = false;
    return {
      iframe,
      frameDoc,
      sectionDoc: options.sectionDoc,
      textMap,
      paginator,
      highlighter,
      resources,
      updateStylesAndLayout: (nextSettings, nextEink, nextGeom) => {
        if (disposed) return;
        this.positionIframe(iframe, options.frameWidth, nextGeom, iframe.style.visibility === 'visible');
        const styleEl = frameDoc.getElementById('mb-user-css');
        if (styleEl) {
          styleEl.textContent = buildFrameUserStylesheet({
            settings: nextSettings,
            isEink: nextEink,
            geom: nextGeom,
            bookLang: options.sectionDoc.lang,
            ...(options.sectionDoc.isCoverLike !== undefined
              ? { isCoverLike: options.sectionDoc.isCoverLike }
              : {}),
            literataFontCss,
          });
        }
        if (nextEink) {
          freezeAnimatedImages(frameDoc);
        }
        paginator.updateGeometry(nextGeom);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        detachGestures();
        paginator.destroy();
        resources.dispose();
        iframe.remove();
      },
    };
  }

  private attachFrameGestures(
    frameDoc: Document,
    paginator: Paginator,
    sectionDoc: SectionDoc,
  ): () => void {
    let downX = 0;
    let downY = 0;
    let downTime = 0;
    let pointerActive = false;
    let hadSelectionOnDown = false;
    let lastImageTap: { target: Element; time: number; timer: ReturnType<typeof setTimeout> } | null = null;
    let lastWheelAt = 0;
    let relayoutDebounce: ReturnType<typeof setTimeout> | null = null;

    const scheduleRelayout = (): void => {
      if (relayoutDebounce) clearTimeout(relayoutDebounce);
      relayoutDebounce = setTimeout(() => {
        relayoutDebounce = null;
        this.callbacks.onContentRelayout?.();
      }, 100);
    };

    const images = Array.from(frameDoc.querySelectorAll('img'));
    for (const img of images) {
      if (!img.complete) {
        img.addEventListener('load', scheduleRelayout, { once: true });
      }
    }

    const getNonEmptySelection = (): Selection | null => {
      const sel = frameDoc.getSelection();
      if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) return null;
      return sel;
    };

    const onClickCapture = (e: MouseEvent): void => {
      const target = e.target as Element | null;
      const anchor = target?.closest?.('a');
      if (anchor) {
        e.preventDefault();
      }
    };

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      pointerActive = true;
      downX = e.clientX;
      downY = e.clientY;
      downTime = Date.now();
      hadSelectionOnDown = getNonEmptySelection() !== null;
    };

    const executeZoneAction = (clientX: number, clientY: number): void => {
      const Vw = Math.max(1, paginator.getGeometry().Vw);
      const ratio = clientX / Vw;
      const isRtl = sectionDoc.dir === 'rtl';
      // Side zones (<28% / >72%) ALWAYS turn pages, even while Read Aloud is active (`[P0-2]`)
      if (ratio < 0.28) {
        if (isRtl) this.callbacks.onNextPage();
        else this.callbacks.onPrevPage();
        return;
      }
      if (ratio > 0.72) {
        if (isRtl) this.callbacks.onPrevPage();
        else this.callbacks.onNextPage();
        return;
      }

      // Center zone: sentence-seek ONLY if point hits actual glyph rects and ReadAloudBar is open
      const hitLoc = paginator.locatorAtPoint(clientX, clientY, { strictHitRect: true });
      if (hitLoc && this.callbacks.onReadAloudTapLocator(hitLoc)) {
        return;
      }
      this.callbacks.onToggleChrome();
    };

    const onPointerUp = (e: PointerEvent): void => {
      if (!pointerActive) return;
      pointerActive = false;

      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      const elapsed = Date.now() - downTime;

      // Active text selection suppresses page turn (`ARCHITECTURE.md` §6.1.1)
      if (getNonEmptySelection() !== null || hadSelectionOnDown) {
        return;
      }

      // Horizontal swipe on release (`>= 40px` and `|dx| > 2*|dy|`)
      if (Math.abs(dx) >= 40 && Math.abs(dx) > 2 * Math.abs(dy)) {
        const isRtl = sectionDoc.dir === 'rtl';
        if (dx < 0) {
          if (isRtl) this.callbacks.onPrevPage();
          else this.callbacks.onNextPage();
        } else {
          if (isRtl) this.callbacks.onNextPage();
          else this.callbacks.onPrevPage();
        }
        return;
      }

      // Tap within 10px and 300ms
      if (Math.hypot(dx, dy) <= 10 && elapsed <= 300) {
        const target = e.target as Element | null;
        const internalLink = target?.closest?.('a[data-mb-loc]');
        if (internalLink) {
          const dest = internalLink.getAttribute('data-mb-loc');
          if (dest) this.callbacks.onInternalLink(dest);
          return;
        }
        const extLink = target?.closest?.('a[data-mb-ext]');
        if (extLink) {
          const url = extLink.getAttribute('data-mb-ext');
          if (url) this.callbacks.onExternalLink(url);
          return;
        }

        const mediaEl = target?.closest?.('img');
        if (mediaEl) {
          const now = Date.now();
          if (lastImageTap && lastImageTap.target === mediaEl && now - lastImageTap.time <= 300) {
            clearTimeout(lastImageTap.timer);
            lastImageTap = null;
            const src = mediaEl.getAttribute('src') ?? '';
            const alt = mediaEl.getAttribute('alt') ?? '';
            if (src) this.callbacks.onImageZoom(src, alt);
            return;
          }
          const cx = e.clientX;
          const cy = e.clientY;
          const timer = setTimeout(() => {
            lastImageTap = null;
            executeZoneAction(cx, cy);
          }, 300);
          lastImageTap = { target: mediaEl, time: now, timer };
          return;
        }

        executeZoneAction(e.clientX, e.clientY);
      }
    };

    const onPointerCancel = (): void => {
      pointerActive = false;
    };

    const onSelectionChange = (): void => {
      const sel = getNonEmptySelection();
      if (!sel || sel.rangeCount === 0) {
        this.callbacks.onSelectionChange(null);
        return;
      }
      const loc = paginator.locatorFromRange(sel.getRangeAt(0));
      if (!loc) {
        this.callbacks.onSelectionChange(null);
        return;
      }
      this.callbacks.onSelectionChange({
        text: sel.toString(),
        locator: loc,
      });
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      handleGlobalKeyDown(e);
    };

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheelAt < 250) return;
      const dominant = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(dominant) < 6) return;
      lastWheelAt = now;
      if (dominant > 0) this.callbacks.onNextPage();
      else this.callbacks.onPrevPage();
    };

    frameDoc.addEventListener('click', onClickCapture, true);
    frameDoc.addEventListener('pointerdown', onPointerDown);
    frameDoc.addEventListener('pointerup', onPointerUp);
    frameDoc.addEventListener('pointercancel', onPointerCancel);
    frameDoc.addEventListener('selectionchange', onSelectionChange);
    frameDoc.addEventListener('keydown', onKeyDown);
    frameDoc.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      if (relayoutDebounce) {
        clearTimeout(relayoutDebounce);
        relayoutDebounce = null;
      }
      if (lastImageTap) {
        clearTimeout(lastImageTap.timer);
        lastImageTap = null;
      }
      frameDoc.removeEventListener('click', onClickCapture, true);
      frameDoc.removeEventListener('pointerdown', onPointerDown);
      frameDoc.removeEventListener('pointerup', onPointerUp);
      frameDoc.removeEventListener('pointercancel', onPointerCancel);
      frameDoc.removeEventListener('selectionchange', onSelectionChange);
      frameDoc.removeEventListener('keydown', onKeyDown);
      frameDoc.removeEventListener('wheel', onWheel);
    };
  }

  disposeAll(): void {
    this.activeUnit?.dispose();
    this.activeUnit = null;
    this.prerenderUnit?.dispose();
    this.prerenderUnit = null;
  }
}
