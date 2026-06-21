// Autodesk Platform Services — Design Automation for AutoCAD.
// Runs a headless AutoCAD (accoreconsole) in Autodesk's cloud to PLOT every
// paper-space layout of a DWG to a legible PDF (one per sheet), zipped. This is
// the only reliable way to turn a DWG into pages Claude can actually read —
// APS Model Derivative properties are empty and its rasters cap at 400px.
//
// The plot routine is embedded as a LISP expression in the activity's script
// (an AppBundle autoload fails to register the command in core console). The
// exact -PLOT answer sequence below was validated against a real plan set.
import { unzipSync } from "fflate";
import {
  APS_LIVE,
  BUCKET_KEY,
  decodeUrn,
  getDaToken,
  signedDownloadUrl,
  signedUploadTarget,
  finalizeUpload,
} from "./aps";

const DA = "https://developer.api.autodesk.com/da/us-east/v3";
const ENGINE = "Autodesk.AutoCAD+25_1";
const ACTNAME = "FirstPassPlotPdf";
const ALIAS = "v1";
const NICK = process.env.APS_CLIENT_ID || "";

// Embedded LISP: enumerate layouts from the ACAD_LAYOUT dict and -PLOT each to
// ./result/<layout>.pdf via the "DWG To PDF.pc3" device (ARCH D, fit to extents).
const PLOT_LISP = [
  "(progn (vl-load-com)",
  ' (setvar "FILEDIA" 0)(setvar "CMDECHO" 0)(setvar "BACKGROUNDPLOT" 0)',
  ' (vl-mkdir (strcat (getvar "DWGPREFIX") "result"))',
  " (setq lays (list))",
  ' (foreach e (dictsearch (namedobjdict) "ACAD_LAYOUT")',
  '  (if (and (= 3 (car e)) (/= (strcase (cdr e)) "MODEL")) (setq lays (cons (cdr e) lays))))',
  " (foreach lay lays",
  '  (setvar "CTAB" lay)',
  '  (command "-PLOT" "Yes" lay "DWG To PDF.pc3" "ARCH D (24.00 x 36.00 Inches)"',
  '    "Inches" "Landscape" "No" "Extents" "Fit" "Center" "Yes" "." "Yes" "No" "No" "No"',
  '    (strcat (getvar "DWGPREFIX") "result\\\\" lay ".pdf") "No" "Yes")',
  '  (while (> (getvar "CMDACTIVE") 0) (command "")))',
  ' (princ "DONE"))',
].join(" ");

let activityEnsured = false;

async function ensureActivity(token: string): Promise<boolean> {
  if (activityEnsured) return true;
  const JH = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const def = {
    id: ACTNAME,
    engine: ENGINE,
    commandLine: [`$(engine.path)\\accoreconsole.exe /i "$(args[HostDwg].path)" /s "$(settings[script].path)"`],
    parameters: {
      HostDwg: { verb: "get", required: true, localName: "input.dwg" },
      Result: { verb: "put", required: true, localName: "result", zip: true },
    },
    settings: { script: PLOT_LISP + "\n" },
  };
  let r = await fetch(`${DA}/activities`, { method: "POST", headers: JH, body: JSON.stringify(def) });
  if (r.status === 409) {
    const { id: _omit, ...noId } = def;
    r = await fetch(`${DA}/activities/${ACTNAME}/versions`, { method: "POST", headers: JH, body: JSON.stringify(noId) });
  }
  if (!r.ok && r.status !== 409) return false;
  const version = r.ok ? (await r.json()).version : 1;
  let a = await fetch(`${DA}/activities/${ACTNAME}/aliases`, { method: "POST", headers: JH, body: JSON.stringify({ id: ALIAS, version }) });
  if (a.status === 409) {
    await fetch(`${DA}/activities/${ACTNAME}/aliases/${ALIAS}`, { method: "PATCH", headers: JH, body: JSON.stringify({ version }) });
  }
  activityEnsured = true;
  return true;
}

export interface PlottedSheet {
  name: string;
  data: string; // base64 PDF
}

// Result of a plot attempt. `sheets` is empty on failure, in which case
// `failure` carries a specific, human-readable reason (which of the ~11 distinct
// failure points was hit) so the pipeline's manual-review flag is debuggable
// instead of opaque.
export interface PlotResult {
  sheets: PlottedSheet[];
  failure?: string;
}

export interface SheetTile {
  label: string; // e.g. "A2.0 (row 1, col 2)"
  data: string; // base64 PNG
}

// Render a plotted sheet PDF into high-DPI PNG tiles so fine dimension text is
// legible to vision (a full ARCH-D sheet downsampled to ~1568px is not). Uses
// mupdf (pure WASM, in-memory) to rasterize region crops — no poppler/system
// binaries, so it works identically in local dev and on serverless (Vercel).
// dpi gives detail; the grid is computed so every tile is <= MAX_TILE_PX, which
// the Anthropic API requires for many-image requests (each dimension <= 2000px).
const MAX_TILE_PX = 1900;
export async function tilesFromPdf(
  pdfBase64: string,
  sheetName: string,
  dpi = 150
): Promise<SheetTile[]> {
  const tiles: SheetTile[] = [];
  // mupdf is ESM-only and ships a sizable WASM payload — load it lazily so it
  // isn't pulled in until a DWG is actually plotted.
  const mupdf = await import("mupdf");
  let doc: import("mupdf").Document | undefined;
  let page: import("mupdf").Page | undefined;
  try {
    doc = mupdf.Document.openDocument(Buffer.from(pdfBase64, "base64"), "application/pdf");
    page = doc.loadPage(0); // each plotted PDF is one sheet
  } catch {
    return tiles; // unreadable PDF → caller falls back to whole-doc vision
  }
  try {
    const zoom = dpi / 72; // PDF points → pixels
    const matrix = mupdf.Matrix.scale(zoom, zoom);
    const b = page.getBounds(); // [x0,y0,x1,y1] in points
    const dx0 = Math.floor(b[0] * zoom), dy0 = Math.floor(b[1] * zoom);
    const dx1 = Math.ceil(b[2] * zoom), dy1 = Math.ceil(b[3] * zoom);
    const wPx = dx1 - dx0, hPx = dy1 - dy0;
    if (!wPx || !hPx) return tiles;

    // Grid sized so each tile <= MAX_TILE_PX (keeps fine dimension text legible
    // while satisfying the 2000px/image cap).
    const cols = Math.max(1, Math.ceil(wPx / MAX_TILE_PX));
    const rows = Math.max(1, Math.ceil(hPx / MAX_TILE_PX));
    if (cols === 1 && rows === 1) {
      // Small sheet — one render, no cropping.
      const pix = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);
      tiles.push({ label: sheetName, data: Buffer.from(pix.asPNG()).toString("base64") });
      pix.destroy();
      return tiles;
    }
    const tileW = Math.ceil(wPx / cols), tileH = Math.ceil(hPx / rows);
    for (let r = 0; r < rows; r++) {
      for (let cc = 0; cc < cols; cc++) {
        // Allocate a pixmap covering just this tile's device-space rect; the
        // draw device clips the rendered page to that bbox.
        const tx0 = dx0 + cc * tileW, ty0 = dy0 + r * tileH;
        const tx1 = Math.min(tx0 + tileW, dx1), ty1 = Math.min(ty0 + tileH, dy1);
        const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [tx0, ty0, tx1, ty1], false);
        pix.clear(255); // white background
        const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
        page.run(dev, matrix);
        dev.close();
        tiles.push({ label: `${sheetName} (row ${r + 1}, col ${cc + 1})`, data: Buffer.from(pix.asPNG()).toString("base64") });
        pix.destroy();
      }
    }
    return tiles;
  } catch {
    return tiles;
  } finally {
    try { page?.destroy(); } catch { /* best-effort */ }
    try { doc?.destroy(); } catch { /* best-effort */ }
  }
}

// Long edge for the in-app sheet viewer — higher than the old 2000px cap so linework
// stays crisp when the panel is large. CSS invert filters destroy anti-aliasing;
// dark mode is applied at the pixel level in applyViewerDarkTheme instead.
export const VIEWER_SHEET_MAX_PX = 4000;

const VIEWER_BG = [13, 34, 53] as const; // matches .blueprint-grid

/** Invert a white plotted sheet onto the blueprint background with bold linework. */
function applyViewerDarkTheme(pix: import("mupdf").Pixmap): void {
  const pixels = pix.getPixels();
  const stride = pix.getNumberOfComponents();
  for (let i = 0; i < pixels.length; i += stride) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    let nr = 255 - r;
    let ng = 255 - g;
    let nb = 255 - b;
    const nlum = 0.299 * nr + 0.587 * ng + 0.114 * nb;
    // Crush pale anti-alias halos (were light gray on white) into the background.
    if (nlum < 40) {
      pixels[i] = VIEWER_BG[0];
      pixels[i + 1] = VIEWER_BG[1];
      pixels[i + 2] = VIEWER_BG[2];
      continue;
    }
    // Stretch each pixel toward full brightness so lines read bold on dark paper.
    const max = Math.max(nr, ng, nb);
    if (max > 0 && max < 255) {
      const scale = 255 / max;
      nr = Math.min(255, nr * scale);
      ng = Math.min(255, ng * scale);
      nb = Math.min(255, nb * scale);
    }
    pixels[i] = nr;
    pixels[i + 1] = ng;
    pixels[i + 2] = nb;
  }
}

// Render a plotted sheet PDF to a single display PNG (page 0), scaled so its long
// edge is <= maxPx. This feeds the in-app sheet viewer: it shows the user the
// exact AutoCAD plot Claude reads. We render here (not via the Model Derivative
// SVF2 viewer) because SVF2 cannot reliably display DWG plan sets — it throws the
// "we can't display this item" page. Returns base64 PNG, or null if unreadable.
export async function renderSheetPng(
  pdfBase64: string,
  maxPx = 2000,
  dark = false
): Promise<string | null> {
  const mupdf = await import("mupdf");
  let doc: import("mupdf").Document | undefined;
  let page: import("mupdf").Page | undefined;
  let pix: import("mupdf").Pixmap | undefined;
  try {
    doc = mupdf.Document.openDocument(Buffer.from(pdfBase64, "base64"), "application/pdf");
    page = doc.loadPage(0); // each plotted PDF is one sheet
    const b = page.getBounds(); // [x0,y0,x1,y1] in points
    const longEdge = Math.max(b[2] - b[0], b[3] - b[1]);
    if (!longEdge) return null;
    const zoom = Math.min(maxPx / longEdge, 6);
    pix = page.toPixmap(mupdf.Matrix.scale(zoom, zoom), mupdf.ColorSpace.DeviceRGB, false);
    if (dark) applyViewerDarkTheme(pix);
    const png = Buffer.from(pix.asPNG()).toString("base64");
    return png;
  } catch {
    return null;
  } finally {
    try { pix?.destroy(); } catch { /* best-effort */ }
    try { page?.destroy(); } catch { /* best-effort */ }
    try { doc?.destroy(); } catch { /* best-effort */ }
  }
}

/** Re-theme an existing light viewer PNG (legacy cache) for dark display. */
export async function convertPngToDarkViewer(pngBase64: string): Promise<string | null> {
  const mupdf = await import("mupdf");
  let img: import("mupdf").Image | undefined;
  let pix: import("mupdf").Pixmap | undefined;
  try {
    img = new mupdf.Image(Buffer.from(pngBase64, "base64"));
    pix = img.toPixmap();
    applyViewerDarkTheme(pix);
    return Buffer.from(pix.asPNG()).toString("base64");
  } catch {
    return null;
  } finally {
    try { pix?.destroy(); } catch { /* best-effort */ }
    try { img?.destroy(); } catch { /* best-effort */ }
  }
}

// Fetch the tail of an AutoCAD workitem report (the accoreconsole log) — by far
// the most useful diagnostic when a plot fails: it names the exact LISP/-PLOT
// step that errored. Best-effort; returns "" if the report can't be read.
async function reportTail(reportUrl: string | undefined): Promise<string> {
  if (!reportUrl) return "";
  try {
    const txt = await (await fetch(reportUrl)).text();
    const tail = txt.trim().slice(-600);
    return tail ? ` — report tail: …${tail}` : "";
  } catch {
    return "";
  }
}

// Plot every layout of the DWG (referenced by its Model Derivative URN, which we
// decode back to the OSS object) to PDF via Design Automation, returning the
// per-sheet PDFs. `onProgress` reports the workitem status. On failure returns
// `{ sheets: [], failure }` with a SPECIFIC reason for which of the ~11 distinct
// failure points was hit, so the pipeline's manual-review flag is debuggable.
export async function plotDwgSheets(
  urn: string,
  onProgress?: (status: string) => void
): Promise<PlotResult> {
  const fail = (failure: string): PlotResult => ({ sheets: [], failure });

  if (!APS_LIVE) return fail("Autodesk credentials not configured (APS_CLIENT_ID/APS_CLIENT_SECRET)");
  if (!NICK) return fail("APS nickname missing (APS_CLIENT_ID not set)");
  const decoded = decodeUrn(urn);
  if (!decoded) return fail("could not decode the storage URN back to an OSS object");
  // Token mint can blip (429/5xx at Autodesk's auth endpoint) — retry a couple
  // times with short backoff before giving up.
  let token = await getDaToken();
  for (let attempt = 0; !token && attempt < 2; attempt++) {
    await new Promise((res) => setTimeout(res, 1500));
    token = await getDaToken();
  }
  if (!token) return fail("Autodesk auth failed — could not mint a Design Automation (code:all) token");
  const JH = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  try {
    if (!(await ensureActivity(token))) return fail("could not register the Design Automation plot activity");

    onProgress?.("signing OSS download URL…");
    const inSigned = await signedDownloadUrl(decoded.bucket, decoded.key);
    const outKey = `da-out/${decoded.key.replace(/[^a-zA-Z0-9]/g, "_")}-${ALIAS}.zip`;
    const outSigned = await signedUploadTarget(BUCKET_KEY, outKey);
    if ("error" in inSigned) return fail(`could not sign the input DWG download URL (${inSigned.error})`);
    if ("error" in outSigned) return fail(`could not sign the result-archive upload URL (${outSigned.error})`);
    const inUrl = inSigned.url;
    const outTarget = outSigned;

    // Submit the workitem, retrying transient rejections (429 rate-limit / 5xx).
    // Other 4xx (bad activity ref, etc.) is NOT transient — fail fast. Backoff is
    // kept short so retries don't eat into the request's ~300s maxDuration; the
    // long poll below is not retried for the same reason.
    const WI_BODY = JSON.stringify({
      activityId: `${NICK}.${ACTNAME}+${ALIAS}`,
      arguments: { HostDwg: { url: inUrl }, Result: { verb: "put", url: outTarget.url } },
    });
    const WI_BACKOFF_MS = [2000, 5000]; // up to 3 attempts total
    let wi: { id: string; status: string; reportUrl?: string } | null = null;
    let lastReject = "";
    for (let attempt = 0; attempt <= WI_BACKOFF_MS.length; attempt++) {
      const r = await fetch(`${DA}/workitems`, { method: "POST", headers: JH, body: WI_BODY });
      if (r.ok) {
        wi = (await r.json()) as { id: string; status: string; reportUrl?: string };
        break;
      }
      const body = (await r.text().catch(() => "")).slice(0, 300);
      lastReject = `HTTP ${r.status}${body ? `: ${body}` : ""}`;
      const transient = r.status === 429 || r.status >= 500;
      if (!transient || attempt === WI_BACKOFF_MS.length) {
        return fail(`Design Automation rejected the workitem (${lastReject})`);
      }
      await new Promise((res) => setTimeout(res, WI_BACKOFF_MS[attempt]));
    }
    if (!wi) return fail(`Design Automation rejected the workitem (${lastReject || "no response"})`);
    onProgress?.(wi.status);
    let i = 0;
    for (; i < 60 && /pending|inprogress/.test(wi.status); i++) {
      await new Promise((res) => setTimeout(res, 4000));
      wi = (await (await fetch(`${DA}/workitems/${wi.id}`, { headers: { Authorization: `Bearer ${token}` } })).json()) as typeof wi;
      onProgress?.(wi.status);
    }
    if (/pending|inprogress/.test(wi.status)) {
      return fail(`Design Automation timed out — still "${wi.status}" after ~${(i * 4)}s`);
    }
    if (wi.status !== "success") {
      return fail(`AutoCAD plot did not succeed (status "${wi.status}")${await reportTail(wi.reportUrl)}`);
    }

    const dlUrl = await finalizeUpload(BUCKET_KEY, outKey, outTarget.uploadKey);
    if (!dlUrl) return fail("plot succeeded but the result archive could not be retrieved from storage");
    const zipBuf = Buffer.from(await (await fetch(dlUrl)).arrayBuffer());
    return unzipPdfs(zipBuf);
  } catch (e) {
    return fail(`unexpected error during plot: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Unzip the result archive into per-sheet PDFs. Uses fflate (pure JS, in-memory)
// rather than the system `unzip` binary — the binary isn't present on serverless
// (Vercel) functions, which would silently break the only accurate DWG path.
function unzipPdfs(zipBuf: Buffer): PlotResult {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(zipBuf));
  } catch {
    return { sheets: [], failure: "the plotted result archive was not a readable zip" };
  }
  const sheets: PlottedSheet[] = [];
  for (const [name, bytes] of Object.entries(entries)) {
    if (!name.toLowerCase().endsWith(".pdf")) continue; // skip dirs/other files
    const base = name.split("/").pop()!.replace(/\.pdf$/i, "");
    sheets.push({ name: base, data: Buffer.from(bytes).toString("base64") });
  }
  if (sheets.length === 0) {
    return { sheets, failure: "the plotted archive contained no PDF sheets (no paper-space layouts plotted?)" };
  }
  // Stable order (TS, A0.1, A1.0 … S2.0)
  sheets.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { sheets };
}
