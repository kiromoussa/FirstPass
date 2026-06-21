import fs from "fs/promises";
import path from "path";
import { renderSheetPng } from "./integrations/autocad-da";
import type { PlottedSheet } from "./integrations/autocad-da";
import { kvGet, kvSet } from "./store";
import { projectDir } from "./project-files";

export interface PlotViewerMeta {
  status: "ready" | "failed" | "pending";
  sheets: { name: string }[];
  reason?: string;
}

const metaKey = (projectId: string) => `plot:${projectId}`;
const pngKey = (projectId: string, i: number) => `plot:${projectId}:${i}`;

function viewerDir(projectId: string): string {
  return path.join(projectDir(projectId), "plans", ".viewer");
}

/** Durable PNG cache on disk — survives KV TTL and avoids re-rasterizing PDFs. */
async function loadViewerFromDiskCache(projectId: string): Promise<PlotViewerMeta | null> {
  const dir = viewerDir(projectId);
  let metaRaw: string;
  try {
    metaRaw = await fs.readFile(path.join(dir, "meta.json"), "utf-8");
  } catch {
    return null;
  }
  let meta: PlotViewerMeta;
  try {
    meta = JSON.parse(metaRaw) as PlotViewerMeta;
  } catch {
    return null;
  }
  if (meta.status !== "ready" || !meta.sheets.length) return null;

  for (let i = 0; i < meta.sheets.length; i++) {
    try {
      const png = (await fs.readFile(path.join(dir, `${i}.png`))).toString("base64");
      await kvSet(pngKey(projectId, i), png);
    } catch {
      return null;
    }
  }
  await kvSet(metaKey(projectId), meta);
  return meta;
}

async function saveViewerToDiskCache(projectId: string, meta: PlotViewerMeta): Promise<void> {
  const dir = viewerDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta), "utf-8");
  for (let i = 0; i < meta.sheets.length; i++) {
    const png = await kvGet<string>(pngKey(projectId, i));
    if (png) await fs.writeFile(path.join(dir, `${i}.png`), Buffer.from(png, "base64"));
  }
}

export async function getPlotViewerMeta(projectId: string): Promise<PlotViewerMeta | null> {
  const fromKv = await kvGet<PlotViewerMeta>(metaKey(projectId));
  if (fromKv?.status === "ready" && fromKv.sheets.length > 0) return fromKv;
  return loadViewerFromDiskCache(projectId);
}

export async function setPlotViewerPending(projectId: string): Promise<void> {
  await kvSet(metaKey(projectId), { status: "pending", sheets: [] } satisfies PlotViewerMeta);
}

export async function setPlotViewerFailed(projectId: string, reason?: string): Promise<void> {
  await kvSet(metaKey(projectId), {
    status: "failed",
    sheets: [],
    reason: reason ?? "DWG plot failed",
  } satisfies PlotViewerMeta);
}

/** Write PNG tiles + metadata for PlanSheetViewer from plotted PDF sheets. */
export async function persistPlotViewerFromSheets(
  projectId: string,
  sheets: PlottedSheet[]
): Promise<PlotViewerMeta> {
  const names: { name: string }[] = [];
  for (let si = 0; si < sheets.length && si < 12; si++) {
    const png = await renderSheetPng(sheets[si].data);
    if (png) {
      await kvSet(pngKey(projectId, names.length), png);
      names.push({ name: sheets[si].name });
    }
  }
  const meta: PlotViewerMeta = {
    status: names.length ? "ready" : "failed",
    sheets: names,
    reason: names.length ? undefined : "Plotted PDFs could not be rendered for preview",
  };
  await kvSet(metaKey(projectId), meta);
  if (names.length) await saveViewerToDiskCache(projectId, meta);
  return meta;
}

/** Build viewer cache from durable projects/{id}/plans/* on disk. */
export async function hydratePlotViewerFromDisk(projectId: string): Promise<PlotViewerMeta | null> {
  const cached = await loadViewerFromDiskCache(projectId);
  if (cached) return cached;

  const plansDir = path.join(projectDir(projectId), "plans");
  let files: string[];
  try {
    files = (await fs.readdir(plansDir))
      .filter((n) => /\.(pdf|png|jpe?g|webp)$/i.test(n) && !n.startsWith("."))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return null;
  }
  if (!files.length) return null;

  const names: { name: string }[] = [];
  for (const file of files.slice(0, 12)) {
    const ext = path.extname(file).toLowerCase();
    const buf = await fs.readFile(path.join(plansDir, file));
    const png =
      ext === ".pdf"
        ? await renderSheetPng(buf.toString("base64"))
        : buf.toString("base64");
    if (png) {
      await kvSet(pngKey(projectId, names.length), png);
      names.push({ name: path.basename(file, ext) });
    }
  }
  const meta: PlotViewerMeta = {
    status: names.length ? "ready" : "failed",
    sheets: names,
    reason: names.length ? undefined : "Could not render plan sheets for preview",
  };
  await kvSet(metaKey(projectId), meta);
  if (names.length) await saveViewerToDiskCache(projectId, meta);
  return meta;
}

export async function getPlotViewerPng(projectId: string, index: number): Promise<string | null> {
  const fromKv = await kvGet<string>(pngKey(projectId, index));
  if (fromKv) return fromKv;
  try {
    return (await fs.readFile(path.join(viewerDir(projectId), `${index}.png`))).toString("base64");
  } catch {
    return null;
  }
}
