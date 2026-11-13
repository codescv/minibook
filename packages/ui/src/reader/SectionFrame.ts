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

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

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
 * Manages the active + pre-warmed neighbor iframes (`prevUnit` and `nextUnit`)
 * with 4-layer security isolation and direct `frameDoc` 1:1 gesture bridging (`ARCHITECTURE.md` §6.1).
 */
export class SectionFrameManager {
  private readonly stageEl: HTMLElement;
  private readonly callbacks: FrameGestureCallbacks;
  private activeUnit: FilledFrameUnit | null = null;
  private prevUnit: FilledFrameUnit | null = null;
  private nextUnit: FilledFrameUnit | null = null;
  private isEink = false;
  private edgeTweenRaf: number | null = null;
  private edgeTweenCleanup: (() => void) | null = null;
  private edgeAlreadySlid = false;

  constructor(stageEl: HTMLElement, callbacks: FrameGestureCallbacks) {
    this.stageEl = stageEl;
    this.callbacks = callbacks;
  }

  getActive(): FilledFrameUnit | null {
    return this.activeUnit;
  }

  getPrerender(): FilledFrameUnit | null {
    return this.nextUnit ?? this.prevUnit;
  }

  getPrevNeighbor(): FilledFrameUnit | null {
    return this.prevUnit;
  }

  getNextNeighbor(): FilledFrameUnit | null {
    return this.nextUnit;
  }

  private cancelEdgeTween(): void {
    if (this.edgeTweenRaf !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.edgeTweenRaf);
      this.edgeTweenRaf = null;
    }
    if (this.edgeTweenCleanup !== null) {
      const cleanup = this.edgeTweenCleanup;
      this.edgeTweenCleanup = null;
      cleanup();
    }
  }

  resetEdgeTransforms(): void {
    this.cancelEdgeTween();
    if (this.activeUnit) {
      this.activeUnit.iframe.style.transform = '';
      this.activeUnit.iframe.setAttribute('data-frame-role', 'active');
    }
    if (this.prevUnit) {
      this.prevUnit.iframe.style.transform = '';
      this.prevUnit.iframe.style.visibility = 'hidden';
      this.prevUnit.iframe.style.pointerEvents = 'none';
      this.prevUnit.iframe.style.zIndex = '1';
      this.prevUnit.iframe.setAttribute('data-frame-role', 'prev');
    }
    if (this.nextUnit) {
      this.nextUnit.iframe.style.transform = '';
      this.nextUnit.iframe.style.visibility = 'hidden';
      this.nextUnit.iframe.style.pointerEvents = 'none';
      this.nextUnit.iframe.style.zIndex = '1';
      this.nextUnit.iframe.setAttribute('data-frame-role', 'next');
    }
  }

  clearNeighbor(role: 'prev' | 'next'): void {
    if (role === 'prev') {
      this.prevUnit?.dispose();
      this.prevUnit = null;
    } else {
      this.nextUnit?.dispose();
      this.nextUnit = null;
    }
  }

  updateNeighborsStylesAndLayout(options: {
    readonly settings: AppSettings;
    readonly isEink: boolean;
    readonly frameWidth: number;
    readonly frameHeight: number;
    readonly safeTop: number;
    readonly safeBottom: number;
  }): void {
    this.isEink = options.isEink;
    this.resetEdgeTransforms();
    for (const [role, unit] of [
      ['prev', this.prevUnit],
      ['next', this.nextUnit],
    ] as const) {
      if (!unit) continue;
      const geom = computePaginationGeometry({
        frameWidth: options.frameWidth,
        frameHeight: options.frameHeight,
        fontScale: options.settings.fontScale,
        margins: options.settings.margins,
        safeTop: options.safeTop,
        safeBottom: options.safeBottom,
        isEink: options.isEink,
        ...(unit.sectionDoc.isCoverLike !== undefined
          ? { isCoverLike: unit.sectionDoc.isCoverLike }
          : {}),
      });
      unit.updateStylesAndLayout(options.settings, options.isEink, geom);
      this.positionIframe(unit.iframe, options.frameWidth, geom, false, role);
      const parkPage = role === 'prev' ? Math.max(0, unit.paginator.getPageCount() - 1) : 0;
      unit.paginator.goToPage(parkPage, { animate: false, isEink: true });
    }
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
    this.isEink = options.isEink;
    this.cancelEdgeTween();

    const computeGeomFor = (doc: SectionDoc): PaginationGeometry =>
      computePaginationGeometry({
        frameWidth: options.frameWidth,
        frameHeight: options.frameHeight,
        fontScale: options.settings.fontScale,
        margins: options.settings.margins,
        safeTop: options.safeTop,
        safeBottom: options.safeBottom,
        isEink: options.isEink,
        ...(doc.isCoverLike !== undefined ? { isCoverLike: doc.isCoverLike } : {}),
      });

    // Fast-promote if `nextUnit` matches `(section, unit.start)`
    if (
      this.nextUnit &&
      this.nextUnit.sectionDoc.index === options.sectionDoc.index &&
      this.nextUnit.sectionDoc.unit.start === options.sectionDoc.unit.start
    ) {
      const alreadySlid = this.edgeAlreadySlid;
      this.edgeAlreadySlid = false;
      const promoted = this.nextUnit;
      this.nextUnit = null;
      this.prevUnit?.dispose();
      this.prevUnit = null;

      const oldActive = this.activeUnit;
      if (oldActive && !options.isEink) {
        const prevGeom = computeGeomFor(oldActive.sectionDoc);
        oldActive.updateStylesAndLayout(options.settings, options.isEink, prevGeom);
        this.positionIframe(oldActive.iframe, options.frameWidth, prevGeom, false, 'prev');
        this.prevUnit = oldActive;
      } else {
        oldActive?.dispose();
      }

      this.activeUnit = promoted;
      const geom = computeGeomFor(options.sectionDoc);
      promoted.updateStylesAndLayout(options.settings, options.isEink, geom);
      this.positionIframe(promoted.iframe, options.frameWidth, geom, true, 'active');

      if (oldActive && this.prevUnit === oldActive) {
        const parkPrev = (): void => {
          oldActive.paginator.goToPage(Math.max(0, oldActive.paginator.getPageCount() - 1), {
            animate: false,
            isEink: true,
          });
        };
        if (!alreadySlid && !options.isEink) {
          const incomingSign: -1 | 1 = options.sectionDoc.dir === 'rtl' ? -1 : 1;
          this.startPromoteSlide(promoted, oldActive, incomingSign, geom.Vw, parkPrev);
        } else {
          parkPrev();
        }
      }
      return promoted;
    }

    // Fast-promote if `prevUnit` matches `(section, unit.start)`
    if (
      this.prevUnit &&
      this.prevUnit.sectionDoc.index === options.sectionDoc.index &&
      this.prevUnit.sectionDoc.unit.start === options.sectionDoc.unit.start
    ) {
      const alreadySlid = this.edgeAlreadySlid;
      this.edgeAlreadySlid = false;
      const promoted = this.prevUnit;
      this.prevUnit = null;
      this.nextUnit?.dispose();
      this.nextUnit = null;

      const oldActive = this.activeUnit;
      if (oldActive && !options.isEink) {
        const nextGeom = computeGeomFor(oldActive.sectionDoc);
        oldActive.updateStylesAndLayout(options.settings, options.isEink, nextGeom);
        this.positionIframe(oldActive.iframe, options.frameWidth, nextGeom, false, 'next');
        this.nextUnit = oldActive;
      } else {
        oldActive?.dispose();
      }

      this.activeUnit = promoted;
      const geom = computeGeomFor(options.sectionDoc);
      promoted.updateStylesAndLayout(options.settings, options.isEink, geom);
      this.positionIframe(promoted.iframe, options.frameWidth, geom, true, 'active');

      if (oldActive && this.nextUnit === oldActive) {
        const parkNext = (): void => {
          oldActive.paginator.goToPage(0, { animate: false, isEink: true });
        };
        if (!alreadySlid && !options.isEink) {
          const incomingSign: -1 | 1 = options.sectionDoc.dir === 'rtl' ? 1 : -1;
          this.startPromoteSlide(promoted, oldActive, incomingSign, geom.Vw, parkNext);
        } else {
          parkNext();
        }
      }
      return promoted;
    }

    const alreadySlid = this.edgeAlreadySlid;
    this.edgeAlreadySlid = false;
    const unit = await this.createFilledUnit(options, true, 'active');
    const oldActive = this.activeUnit;
    this.prevUnit?.dispose();
    this.prevUnit = null;
    this.nextUnit?.dispose();
    this.nextUnit = null;
    this.activeUnit = unit;

    if (
      oldActive &&
      !options.isEink &&
      (oldActive.sectionDoc.index !== options.sectionDoc.index ||
        oldActive.sectionDoc.unit.start !== options.sectionDoc.unit.start)
    ) {
      const isForward =
        options.sectionDoc.index > oldActive.sectionDoc.index ||
        (options.sectionDoc.index === oldActive.sectionDoc.index &&
          options.sectionDoc.unit.start > oldActive.sectionDoc.unit.start);
      const demotedRole: 'prev' | 'next' = isForward ? 'prev' : 'next';
      const demotedGeom = computeGeomFor(oldActive.sectionDoc);
      oldActive.updateStylesAndLayout(options.settings, options.isEink, demotedGeom);
      this.positionIframe(oldActive.iframe, options.frameWidth, demotedGeom, false, demotedRole);
      if (demotedRole === 'prev') {
        this.prevUnit = oldActive;
      } else {
        this.nextUnit = oldActive;
      }
      const parkDemoted = (): void => {
        const p =
          demotedRole === 'prev'
            ? Math.max(0, oldActive.paginator.getPageCount() - 1)
            : 0;
        oldActive.paginator.goToPage(p, { animate: false, isEink: true });
      };
      if (!alreadySlid) {
        const isRtl = options.sectionDoc.dir === 'rtl';
        const incomingSign: -1 | 1 = isForward ? (isRtl ? -1 : 1) : isRtl ? 1 : -1;
        this.startPromoteSlide(
          unit,
          oldActive,
          incomingSign,
          unit.paginator.getGeometry().Vw,
          parkDemoted,
        );
      } else {
        parkDemoted();
      }
    } else {
      oldActive?.dispose();
    }
    return unit;
  }

  async prerenderAdjacent(
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
    role: 'prev' | 'next' = 'next',
  ): Promise<void> {
    const existing = role === 'prev' ? this.prevUnit : this.nextUnit;
    if (
      existing &&
      existing.sectionDoc.index === options.sectionDoc.index &&
      existing.sectionDoc.unit.start === options.sectionDoc.unit.start
    ) {
      if (this.edgeTweenRaf === null) {
        const parkPage = role === 'prev' ? Math.max(0, existing.paginator.getPageCount() - 1) : 0;
        existing.paginator.goToPage(parkPage, { animate: false, isEink: true });
      }
      return;
    }
    existing?.dispose();
    if (role === 'prev') this.prevUnit = null;
    else this.nextUnit = null;

    try {
      const unit = await this.createFilledUnit(options, false, role);
      if (
        this.activeUnit &&
        this.activeUnit.sectionDoc.index === options.sectionDoc.index &&
        this.activeUnit.sectionDoc.unit.start === options.sectionDoc.unit.start
      ) {
        unit.dispose();
        return;
      }
      const parkPage = role === 'prev' ? Math.max(0, unit.paginator.getPageCount() - 1) : 0;
      unit.paginator.goToPage(parkPage, { animate: false, isEink: true });
      if (role === 'prev') {
        this.prevUnit?.dispose();
        this.prevUnit = unit;
      } else {
        this.nextUnit?.dispose();
        this.nextUnit = unit;
      }
    } catch {
      // Non-fatal pre-render failure
    }
  }

  private positionIframe(
    iframe: HTMLIFrameElement,
    containerWidth: number,
    geom: PaginationGeometry,
    visible: boolean,
    role: 'active' | 'prev' | 'next' = 'active',
  ): void {
    const leftOffset = Math.max(0, Math.floor((containerWidth - geom.Vw) / 2));
    iframe.style.width = `${geom.Vw}px`;
    iframe.style.height = `${geom.Vh}px`;
    iframe.style.left = `${leftOffset}px`;
    iframe.style.transform = '';
    iframe.style.visibility = visible ? 'visible' : 'hidden';
    iframe.style.pointerEvents = visible ? 'auto' : 'none';
    iframe.style.zIndex = visible ? '2' : '1';
    iframe.setAttribute('data-frame-role', role);
  }

  private startPromoteSlide(
    promoted: FilledFrameUnit,
    demoted: FilledFrameUnit,
    incomingSign: -1 | 1,
    Vw: number,
    onFinishPark?: () => void,
  ): void {
    this.cancelEdgeTween();
    if (
      this.isEink ||
      prefersReducedMotion() ||
      typeof requestAnimationFrame !== 'function' ||
      Vw <= 0
    ) {
      onFinishPark?.();
      return;
    }

    const durationMs = 250;
    const t0 = performance.now();

    promoted.iframe.style.visibility = 'visible';
    promoted.iframe.style.transform = `translate3d(${incomingSign * Vw}px, 0, 0)`;
    demoted.iframe.style.visibility = 'visible';
    demoted.iframe.style.transform = 'translate3d(0px, 0, 0)';

    this.edgeTweenCleanup = () => {
      promoted.iframe.style.transform = '';
      demoted.iframe.style.transform = '';
      if (this.activeUnit !== demoted) {
        demoted.iframe.style.visibility = 'hidden';
      }
      onFinishPark?.();
    };

    const tick = (now: number): void => {
      const elapsed = now - t0;
      if (elapsed >= durationMs) {
        this.edgeTweenRaf = null;
        const cleanup = this.edgeTweenCleanup;
        this.edgeTweenCleanup = null;
        cleanup?.();
        return;
      }
      const p = elapsed / durationMs;
      const eased = 1 - Math.pow(1 - p, 3);
      const promX = Math.round(incomingSign * Vw * (1 - eased));
      const demX = Math.round(-incomingSign * Vw * eased);
      promoted.iframe.style.transform = promX === 0 ? '' : `translate3d(${promX}px, 0, 0)`;
      demoted.iframe.style.transform = `translate3d(${demX}px, 0, 0)`;
      this.edgeTweenRaf = requestAnimationFrame(tick);
    };

    this.edgeTweenRaf = requestAnimationFrame(tick);
  }

  private animateEdgeTransition(
    startDx: number,
    targetDx: number,
    neighbor: FilledFrameUnit | null,
    neighborOffsetSign: -1 | 1,
    onDone: () => void,
  ): void {
    this.cancelEdgeTween();
    const active = this.activeUnit;
    if (
      !active ||
      this.isEink ||
      prefersReducedMotion() ||
      typeof requestAnimationFrame !== 'function' ||
      Math.abs(targetDx - startDx) <= 1
    ) {
      onDone();
      return;
    }

    const Vw = active.paginator.getGeometry().Vw;
    const durationMs = 250;
    const t0 = performance.now();

    this.edgeTweenCleanup = () => {
      active.iframe.style.transform = targetDx === 0 ? '' : `translate3d(${targetDx}px, 0, 0)`;
      if (neighbor) {
        const nX = neighborOffsetSign * Vw + targetDx;
        neighbor.iframe.style.transform = nX === 0 ? '' : `translate3d(${nX}px, 0, 0)`;
      }
      onDone();
    };

    const tick = (now: number): void => {
      const elapsed = now - t0;
      if (elapsed >= durationMs) {
        this.edgeTweenRaf = null;
        const cleanup = this.edgeTweenCleanup;
        this.edgeTweenCleanup = null;
        cleanup?.();
        return;
      }
      const p = elapsed / durationMs;
      const eased = 1 - Math.pow(1 - p, 3);
      const curDx = Math.round(startDx + (targetDx - startDx) * eased);
      active.iframe.style.transform = curDx === 0 ? '' : `translate3d(${curDx}px, 0, 0)`;
      if (neighbor) {
        neighbor.iframe.style.visibility = 'visible';
        neighbor.iframe.style.transform = `translate3d(${neighborOffsetSign * Vw + curDx}px, 0, 0)`;
      }
      this.edgeTweenRaf = requestAnimationFrame(tick);
    };

    this.edgeTweenRaf = requestAnimationFrame(tick);
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
    role: 'active' | 'prev' | 'next' = 'active',
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

    this.positionIframe(iframe, options.frameWidth, geom, visible, role);
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

    const detachGestures = this.attachFrameGestures(iframe, frameDoc, paginator, options.sectionDoc);

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
        const curRole =
          (iframe.getAttribute('data-frame-role') as 'active' | 'prev' | 'next' | null) ?? 'active';
        this.positionIframe(
          iframe,
          options.frameWidth,
          nextGeom,
          curRole === 'active',
          curRole,
        );
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
    iframe: HTMLIFrameElement,
    frameDoc: Document,
    paginator: Paginator,
    sectionDoc: SectionDoc,
  ): () => void {
    const hostDoc = this.stageEl.ownerDocument;
    let startStationaryX = 0;
    let startStationaryY = 0;
    let downClientX = 0;
    let downClientY = 0;
    let downTime = 0;
    let lastPtX = 0;
    let lastPtTime = 0;
    let velocityX = 0;
    let pointerActive = false;
    let activePointerId: number | null = null;
    let dragLocked = false;
    let dragKind: 'none' | 'intra' | 'edge' = 'none';
    let lastDragDx = 0;
    let hadSelectionOnDown = false;
    let lastImageTap: { target: Element; time: number; timer: ReturnType<typeof setTimeout> } | null = null;
    let lastWheelAt = 0;
    let relayoutDebounce: ReturnType<typeof setTimeout> | null = null;

    const getStationaryPoint = (e: PointerEvent): { x: number; y: number } => {
      if (e.view && e.view !== frameDoc.defaultView) {
        return { x: e.clientX, y: e.clientY };
      }
      const rect = iframe.getBoundingClientRect();
      return {
        x: rect.left + e.clientX,
        y: rect.top + e.clientY,
      };
    };

    const scheduleRelayout = (): void => {
      if (relayoutDebounce) clearTimeout(relayoutDebounce);
      relayoutDebounce = setTimeout(() => {
        relayoutDebounce = null;
        if (this.activeUnit?.iframe === iframe) {
          this.callbacks.onContentRelayout?.();
        } else {
          paginator.measure();
          const curRole = iframe.getAttribute('data-frame-role');
          const parkPage =
            curRole === 'prev' ? Math.max(0, paginator.getPageCount() - 1) : 0;
          paginator.goToPage(parkPage, { animate: false, isEink: true });
        }
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
      hadSelectionOnDown = getNonEmptySelection() !== null;
      if (e.pointerType === 'mouse' && !hadSelectionOnDown) {
        e.preventDefault();
      }
      this.cancelEdgeTween();
      const pt = getStationaryPoint(e);
      pointerActive = true;
      activePointerId = e.pointerId;
      startStationaryX = pt.x;
      startStationaryY = pt.y;
      downClientX = e.clientX;
      downClientY = e.clientY;
      downTime = Date.now();
      lastPtX = pt.x;
      lastPtTime = performance.now();
      velocityX = 0;
      dragLocked = false;
      dragKind = 'none';
      lastDragDx = 0;
    };

    const onPointerMove = (e: PointerEvent): void => {
      if (
        !pointerActive ||
        (activePointerId !== null && e.pointerId !== undefined && e.pointerId !== activePointerId)
      ) {
        return;
      }
      if (this.isEink) return;
      if (hadSelectionOnDown) return;

      const pt = getStationaryPoint(e);
      const dx = pt.x - startStationaryX;
      const dy = pt.y - startStationaryY;
      const now = performance.now();
      const dt = now - lastPtTime;
      if (dt > 0) {
        const instVx = (pt.x - lastPtX) / dt;
        velocityX = velocityX === 0 ? instVx : velocityX * 0.4 + instVx * 0.6;
        lastPtX = pt.x;
        lastPtTime = now;
      }

      if (!dragLocked) {
        if (Math.abs(dx) > 8 && Math.abs(dx) > 1.25 * Math.abs(dy)) {
          dragLocked = true;
        } else {
          return;
        }
      }

      lastDragDx = dx;
      const curPage = paginator.getCurrentPage();
      const totalPages = paginator.getPageCount();
      const Vw = paginator.getGeometry().Vw;
      const isRtl = sectionDoc.dir === 'rtl';
      const wantsNext = isRtl ? dx > 0 : dx < 0;
      const wantsPrev = isRtl ? dx < 0 : dx > 0;
      const canIntraNext = wantsNext && curPage + 1 < totalPages;
      const canIntraPrev = wantsPrev && curPage > 0;

      if (canIntraNext || canIntraPrev || dx === 0) {
        if (dragKind === 'edge') {
          this.resetEdgeTransforms();
        }
        dragKind = 'intra';
        paginator.setDragOffset(dx);
        return;
      }

      // At render-unit / chapter edge: keep current unit scrollLeft parked and slide active + neighbor iframes 1:1
      paginator.setDragOffset(0);
      dragKind = 'edge';
      const neighbor = wantsNext ? this.nextUnit : wantsPrev ? this.prevUnit : null;
      const otherNeighbor = wantsNext ? this.prevUnit : this.nextUnit;
      if (otherNeighbor) {
        otherNeighbor.iframe.style.visibility = 'hidden';
        otherNeighbor.iframe.style.transform = '';
      }

      if (neighbor) {
        const clampedDx = Math.max(-Vw, Math.min(Vw, dx));
        const offsetSign: -1 | 1 = clampedDx < 0 ? 1 : -1;
        iframe.style.transform = `translate3d(${clampedDx}px, 0, 0)`;
        neighbor.iframe.style.visibility = 'visible';
        neighbor.iframe.style.transform = `translate3d(${offsetSign * Vw + clampedDx}px, 0, 0)`;
      } else {
        const dampedDx = Math.round(dx * 0.22);
        iframe.style.transform = `translate3d(${dampedDx}px, 0, 0)`;
      }
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

    const finishPointerGesture = (e: PointerEvent, isCancel: boolean): void => {
      if (
        !pointerActive ||
        (activePointerId !== null && e.pointerId !== undefined && e.pointerId !== activePointerId)
      ) {
        return;
      }
      pointerActive = false;
      activePointerId = null;

      const pt = getStationaryPoint(e);
      const dx = dragLocked ? lastDragDx || pt.x - startStationaryX : pt.x - startStationaryX;
      const dy = pt.y - startStationaryY;
      const elapsed = Date.now() - downTime;

      if (dragLocked && !this.isEink) {
        const curPage = paginator.getCurrentPage();
        const totalPages = paginator.getPageCount();
        const Vw = paginator.getGeometry().Vw;
        const isRtl = sectionDoc.dir === 'rtl';
        const wantsNext = isRtl ? dx > 0 : dx < 0;
        const wantsPrev = isRtl ? dx < 0 : dx > 0;
        const absDx = Math.abs(dx);
        const recentMove = performance.now() - lastPtTime <= 80;
        const flickInDir =
          recentMove && elapsed <= 280 && absDx >= 36 && velocityX * Math.sign(dx) >= 0.45;
        const shouldCommit =
          !isCancel && (absDx >= Math.min(84, Vw * 0.22) || flickInDir);

        if (dragKind === 'intra') {
          this.resetEdgeTransforms();
          if (shouldCommit && wantsNext && curPage + 1 < totalPages) {
            this.callbacks.onNextPage();
          } else if (shouldCommit && wantsPrev && curPage > 0) {
            this.callbacks.onPrevPage();
          } else {
            paginator.goToPage(curPage, { animate: true, isEink: false });
          }
          return;
        }

        if (dragKind === 'edge') {
          const neighbor = wantsNext ? this.nextUnit : wantsPrev ? this.prevUnit : null;
          const clampedDx = neighbor ? Math.max(-Vw, Math.min(Vw, dx)) : Math.round(dx * 0.22);
          const offsetSign: -1 | 1 = dx < 0 ? 1 : -1;

          if (shouldCommit && neighbor) {
            const targetDx = dx < 0 ? -Vw : Vw;
            this.animateEdgeTransition(clampedDx, targetDx, neighbor, offsetSign, () => {
              this.edgeAlreadySlid = true;
              if (wantsNext) this.callbacks.onNextPage();
              else this.callbacks.onPrevPage();
            });
          } else if (shouldCommit && !neighbor && wantsNext) {
            this.resetEdgeTransforms();
            this.callbacks.onNextPage();
          } else {
            this.animateEdgeTransition(clampedDx, 0, neighbor, offsetSign, () => {
              this.resetEdgeTransforms();
            });
          }
          return;
        }
      }

      if (isCancel) {
        this.resetEdgeTransforms();
        return;
      }

      // Active text selection suppresses page turn (`ARCHITECTURE.md` §6.1.1)
      if (getNonEmptySelection() !== null || hadSelectionOnDown) {
        return;
      }

      // Horizontal swipe on release (`>= 40px` and `|dx| > 2*|dy|`, e.g. E-Ink mode)
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
          const cx = downClientX;
          const cy = downClientY;
          const timer = setTimeout(() => {
            lastImageTap = null;
            executeZoneAction(cx, cy);
          }, 300);
          lastImageTap = { target: mediaEl, time: now, timer };
          return;
        }

        executeZoneAction(downClientX, downClientY);
      }
    };

    const onPointerUp = (e: PointerEvent): void => {
      finishPointerGesture(e, false);
    };

    const onPointerCancel = (e: PointerEvent): void => {
      finishPointerGesture(e, true);
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
    frameDoc.addEventListener('pointermove', onPointerMove);
    frameDoc.addEventListener('pointerup', onPointerUp);
    frameDoc.addEventListener('pointercancel', onPointerCancel);
    hostDoc.addEventListener('pointermove', onPointerMove);
    hostDoc.addEventListener('pointerup', onPointerUp);
    hostDoc.addEventListener('pointercancel', onPointerCancel);
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
      frameDoc.removeEventListener('pointermove', onPointerMove);
      frameDoc.removeEventListener('pointerup', onPointerUp);
      frameDoc.removeEventListener('pointercancel', onPointerCancel);
      hostDoc.removeEventListener('pointermove', onPointerMove);
      hostDoc.removeEventListener('pointerup', onPointerUp);
      hostDoc.removeEventListener('pointercancel', onPointerCancel);
      frameDoc.removeEventListener('selectionchange', onSelectionChange);
      frameDoc.removeEventListener('keydown', onKeyDown);
      frameDoc.removeEventListener('wheel', onWheel);
    };
  }

  disposeAll(): void {
    this.cancelEdgeTween();
    this.activeUnit?.dispose();
    this.activeUnit = null;
    this.prevUnit?.dispose();
    this.prevUnit = null;
    this.nextUnit?.dispose();
    this.nextUnit = null;
  }
}
