// Autodesk Platform Services — Design Automation for AutoCAD.
// Runs a headless AutoCAD (accoreconsole) in Autodesk's cloud to PLOT every
// paper-space layout of a DWG to a legible PDF (one per sheet), zipped. This is
// the only reliable way to turn a DWG into pages Claude can actually read —
// APS Model Derivative properties are empty and its rasters cap at 400px.
//
// The plot routine is embedded as a LISP expression in the activity's script
// (an AppBundle autoload fails to register the command in core console). The
// exact -PLOT answer sequence below was validated against a real plan set.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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

const execFileP = promisify(execFile);
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

export interface SheetTile {
  label: string; // e.g. "A2.0 (row 1, col 2)"
  data: string; // base64 PNG
}

// Render a plotted sheet PDF into high-DPI PNG tiles so fine dimension text is
// legible to vision (a full ARCH-D sheet downsampled to ~1568px is not). Uses
// poppler's pdftoppm with region crops; falls back to a single full-page render.
// dpi gives detail; the grid is computed so every tile is <= MAX_TILE_PX, which
// the Anthropic API requires for many-image requests (each dimension <= 2000px).
const MAX_TILE_PX = 1900;
export async function tilesFromPdf(
  pdfBase64: string,
  sheetName: string,
  dpi = 150
): Promise<SheetTile[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "firstpass-tile-"));
  const pdfPath = path.join(dir, "sheet.pdf");
  fs.writeFileSync(pdfPath, Buffer.from(pdfBase64, "base64"));
  const tiles: SheetTile[] = [];
  try {
    // Page size in points → pixels at dpi.
    let wPx = 0, hPx = 0;
    try {
      const { stdout } = await execFileP("pdfinfo", [pdfPath]);
      const m = stdout.match(/Page size:\s*([\d.]+)\s*x\s*([\d.]+)\s*pts/);
      if (m) { wPx = Math.round((parseFloat(m[1]) / 72) * dpi); hPx = Math.round((parseFloat(m[2]) / 72) * dpi); }
    } catch { /* pdfinfo missing → single render below */ }

    if (!wPx || !hPx) {
      const out = path.join(dir, "full");
      await execFileP("pdftoppm", ["-png", "-r", "110", pdfPath, out]); // ~<=2000px on a 17" sheet
      const f = fs.readdirSync(dir).find((x) => x.startsWith("full") && x.endsWith(".png"));
      if (f) tiles.push({ label: sheetName, data: fs.readFileSync(path.join(dir, f)).toString("base64") });
      return tiles;
    }

    // Grid sized so each tile <= MAX_TILE_PX (keeps fine dimension text legible
    // while satisfying the 2000px/image cap).
    const cols = Math.max(1, Math.ceil(wPx / MAX_TILE_PX));
    const rows = Math.max(1, Math.ceil(hPx / MAX_TILE_PX));
    const tileW = Math.ceil(wPx / cols), tileH = Math.ceil(hPx / rows);
    for (let r = 0; r < rows; r++) {
      for (let cc = 0; cc < cols; cc++) {
        const x = cc * tileW, y = r * tileH;
        const base = path.join(dir, `t_${r}_${cc}`);
        await execFileP("pdftoppm", ["-png", "-r", String(dpi), "-x", String(x), "-y", String(y), "-W", String(tileW), "-H", String(tileH), pdfPath, base]);
        const f = fs.readdirSync(dir).find((x2) => x2.startsWith(`t_${r}_${cc}`) && x2.endsWith(".png"));
        if (f) tiles.push({ label: `${sheetName} (row ${r + 1}, col ${cc + 1})`, data: fs.readFileSync(path.join(dir, f)).toString("base64") });
      }
    }
    return tiles;
  } catch {
    return tiles;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// Plot every layout of the DWG (referenced by its Model Derivative URN, which we
// decode back to the OSS object) to PDF via Design Automation, returning the
// per-sheet PDFs. `onProgress` reports the workitem status. Returns [] on any
// failure so the pipeline can fall back gracefully.
export async function plotDwgSheets(
  urn: string,
  onProgress?: (status: string) => void
): Promise<PlottedSheet[]> {
  if (!APS_LIVE || !NICK) return [];
  const decoded = decodeUrn(urn);
  if (!decoded) return [];
  const token = await getDaToken();
  if (!token) return [];
  const JH = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  try {
    if (!(await ensureActivity(token))) return [];

    const inUrl = await signedDownloadUrl(decoded.bucket, decoded.key);
    const outKey = `da-out/${decoded.key.replace(/[^a-zA-Z0-9]/g, "_")}-${ALIAS}.zip`;
    const outTarget = await signedUploadTarget(BUCKET_KEY, outKey);
    if (!inUrl || !outTarget) return [];

    let r = await fetch(`${DA}/workitems`, {
      method: "POST",
      headers: JH,
      body: JSON.stringify({
        activityId: `${NICK}.${ACTNAME}+${ALIAS}`,
        arguments: { HostDwg: { url: inUrl }, Result: { verb: "put", url: outTarget.url } },
      }),
    });
    if (!r.ok) return [];
    let wi = (await r.json()) as { id: string; status: string };
    onProgress?.(wi.status);
    for (let i = 0; i < 60 && /pending|inprogress/.test(wi.status); i++) {
      await new Promise((res) => setTimeout(res, 4000));
      wi = (await (await fetch(`${DA}/workitems/${wi.id}`, { headers: { Authorization: `Bearer ${token}` } })).json()) as typeof wi;
      onProgress?.(wi.status);
    }
    if (wi.status !== "success") return [];

    const dlUrl = await finalizeUpload(BUCKET_KEY, outKey, outTarget.uploadKey);
    if (!dlUrl) return [];
    const zipBuf = Buffer.from(await (await fetch(dlUrl)).arrayBuffer());
    return unzipPdfs(zipBuf);
  } catch {
    return [];
  }
}

// Unzip the result archive into per-sheet PDFs. Uses fflate (pure JS, in-memory)
// rather than the system `unzip` binary — the binary isn't present on serverless
// (Vercel) functions, which would silently break the only accurate DWG path.
function unzipPdfs(zipBuf: Buffer): PlottedSheet[] {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(zipBuf));
  } catch {
    return [];
  }
  const sheets: PlottedSheet[] = [];
  for (const [name, bytes] of Object.entries(entries)) {
    if (!name.toLowerCase().endsWith(".pdf")) continue; // skip dirs/other files
    const base = name.split("/").pop()!.replace(/\.pdf$/i, "");
    sheets.push({ name: base, data: Buffer.from(bytes).toString("base64") });
  }
  // Stable order (TS, A0.1, A1.0 … S2.0)
  sheets.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return sheets;
}
