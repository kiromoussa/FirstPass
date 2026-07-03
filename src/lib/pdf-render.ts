// High-fidelity PDF page rendering for the vision fallback pass (technique
// ported from CodeComply's pdf-render.server, reimplemented on mupdf so it
// stays pure-WASM / serverless-safe like the rest of the DWG path — no pdf.js,
// no native canvas).
//
// Why not just send the page image at the page's natural size: architectural
// sheets are mostly white margin. Rendering the full sheet into vision's
// typical downscale budget makes dimension text unreadable. Instead we
// (1) probe-render the page small, (2) scan for the drawing's actual content
// bounding box (ignoring near-white pixels), then (3) re-render JUST that
// region at a zoom that fills ~1900px, comfortably under vision providers'
// per-image size limits, so small dimension strings stay legible.
const MAX_PAGE_PX = 1900;
const PROBE_PX = 600; // probe render long edge for the content scan
const NEAR_WHITE = 250; // r,g,b all above → margin, not content
const PAD_PTS = 12; // padding around the detected content, in page points
const MAX_ZOOM = 8; // don't blow tiny content up absurdly

export interface RenderedPage {
  /** Image label for the extraction prompt, e.g. "page 3". */
  label: string;
  /** base64 PNG of the content-cropped page render. */
  data: string;
  /** 0-based page index in the source PDF. */
  page: number;
  /** The crop rect, normalized 0..1 on the FULL page — lets a bbox read on
   *  this image be mapped back to page coordinates. */
  crop: { x: number; y: number; w: number; h: number };
}

/**
 * Render up to `maxPages` pages of a PDF as content-cropped, legibility-scaled
 * PNGs. Pages that fail to render are skipped (best-effort — the caller merges
 * whatever pages did render with the document-pass results).
 */
export async function renderPdfPages(
  pdfBase64: string,
  maxPages = 8
): Promise<RenderedPage[]> {
  const out: RenderedPage[] = [];
  const mupdf = await import("mupdf");
  let doc: import("mupdf").Document | undefined;
  try {
    doc = mupdf.Document.openDocument(Buffer.from(pdfBase64, "base64"), "application/pdf");
  } catch {
    return out;
  }
  try {
    const n = Math.min(doc.countPages(), maxPages);
    for (let i = 0; i < n; i++) {
      let page: import("mupdf").Page | undefined;
      try {
        page = doc.loadPage(i);
        const rendered = renderPage(mupdf, page, i);
        if (rendered) out.push(rendered);
      } catch {
        /* skip unreadable page */
      } finally {
        try { page?.destroy(); } catch { /* best-effort */ }
      }
    }
    return out;
  } finally {
    try { doc?.destroy(); } catch { /* best-effort */ }
  }
}

function renderPage(
  mupdf: typeof import("mupdf"),
  page: import("mupdf").Page,
  index: number
): RenderedPage | null {
  const b = page.getBounds(); // [x0,y0,x1,y1] in points
  const pageW = b[2] - b[0];
  const pageH = b[3] - b[1];
  if (!pageW || !pageH) return null;

  // 1) Probe render + content scan.
  const probeZoom = PROBE_PX / Math.max(pageW, pageH);
  let content = { x0: b[0], y0: b[1], x1: b[2], y1: b[3] };
  let probe: import("mupdf").Pixmap | undefined;
  try {
    probe = page.toPixmap(mupdf.Matrix.scale(probeZoom, probeZoom), mupdf.ColorSpace.DeviceRGB, false);
    const found = scanContentBounds(probe);
    if (found) {
      content = {
        x0: Math.max(b[0], b[0] + found.minX / probeZoom - PAD_PTS),
        y0: Math.max(b[1], b[1] + found.minY / probeZoom - PAD_PTS),
        x1: Math.min(b[2], b[0] + (found.maxX + 1) / probeZoom + PAD_PTS),
        y1: Math.min(b[3], b[1] + (found.maxY + 1) / probeZoom + PAD_PTS),
      };
    }
  } catch {
    /* probe failed → render the full page */
  } finally {
    try { probe?.destroy(); } catch { /* best-effort */ }
  }

  const cropW = content.x1 - content.x0;
  const cropH = content.y1 - content.y0;
  if (cropW <= 0 || cropH <= 0) return null;

  // 2) Re-render just the content rect at legibility zoom.
  const zoom = Math.min(MAX_PAGE_PX / Math.max(cropW, cropH), MAX_ZOOM);
  const dx0 = Math.floor(content.x0 * zoom);
  const dy0 = Math.floor(content.y0 * zoom);
  const dx1 = Math.ceil(content.x1 * zoom);
  const dy1 = Math.ceil(content.y1 * zoom);
  let pix: import("mupdf").Pixmap | undefined;
  try {
    pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [dx0, dy0, dx1, dy1], false);
    pix.clear(255);
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    page.run(dev, mupdf.Matrix.scale(zoom, zoom));
    dev.close();
    return {
      label: `page ${index + 1}`,
      data: Buffer.from(pix.asPNG()).toString("base64"),
      page: index,
      crop: {
        x: (content.x0 - b[0]) / pageW,
        y: (content.y0 - b[1]) / pageH,
        w: cropW / pageW,
        h: cropH / pageH,
      },
    };
  } catch {
    return null;
  } finally {
    try { pix?.destroy(); } catch { /* best-effort */ }
  }
}

// Find the bounding box of non-near-white pixels in a probe render (probe-pixel
// coordinates). Returns null for a blank page.
function scanContentBounds(
  pix: import("mupdf").Pixmap
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const pixels = pix.getPixels();
  const w = pix.getWidth();
  const h = pix.getHeight();
  const stride = pix.getNumberOfComponents();
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const rowOff = y * w * stride;
    for (let x = 0; x < w; x++) {
      const i = rowOff + x * stride;
      if (pixels[i] > NEAR_WHITE && pixels[i + 1] > NEAR_WHITE && pixels[i + 2] > NEAR_WHITE) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { minX, minY, maxX, maxY };
}
