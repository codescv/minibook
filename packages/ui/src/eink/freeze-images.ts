/**
 * Freezes potentially animated raster images (`gif`, `webp`, `apng`/`png`) on their
 * first frame when E-Ink mode is active (`PRODUCT_DESIGN.md` §8.2 R2 & `ARCHITECTURE.md` §9.2).
 */
export function freezeAnimatedImages(doc: Document): void {
  const images = doc.querySelectorAll('img');
  for (const img of images) {
    if (img.dataset.mbFrozen === '1') continue;
    const src = img.getAttribute('src') ?? '';
    if (!src || src.startsWith('data:image/png;base64,')) continue;

    const freezeOne = (): void => {
      if (img.dataset.mbFrozen === '1') return;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w <= 0 || h <= 0 || w * h > 8_388_608) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, w, h);
        const snapshot = canvas.toDataURL('image/png');
        img.dataset.mbFrozen = '1';
        img.src = snapshot;
      } catch {
        // Ignore security/canvas errors in non-canvas environments (e.g. jsdom)
      }
    };

    if (img.complete && img.naturalWidth > 0) {
      freezeOne();
    } else {
      img.addEventListener('load', freezeOne, { once: true });
    }
  }
}
