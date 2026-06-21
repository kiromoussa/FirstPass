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

export async function getPlotViewerMeta(projectId: string): Promise<PlotViewerMeta | null> {
  return kvGet<PlotViewerMeta>(metaKey(projectId));
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
  return meta;
}

/** Build viewer cache from durable projects/{id}/plans/* on disk. */
export async function hydratePlotViewerFromDisk(projectId: string): Promise<PlotViewerMeta | null> {
  const plansDir = path.join(projectDir(projectId), "plans");
  let files: string[];
  try {
    files = (await fs.readdir(plansDir))
      .filter((n) => /\.(pdf|png|jpe?g|webp)$/i.test(n))
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
  return meta;
}

export async function getPlotViewerPng(projectId: string, index: number): Promise<string | null> {
  return kvGet<string>(pngKey(projectId, index));
}
