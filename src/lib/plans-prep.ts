// Prepare plan sheets on disk for the Band Visual/Compare agents.
//
// Two stores, deliberately separated:
//   • projects/{id}/plans/  — DURABLE, per-project. The source of truth for a
//     project's plotted DWG sheets. Survives dropped SSE connections and re-runs,
//     so a run never has to re-plot (or get orphaned mid-plot) once sheets exist.
//   • plans/                — the GLOBAL scratch dir the Python Band agents read
//     (plan_analysis_tool.py hardcodes it). It is REBUILT at the start of every
//     run to contain EXACTLY the current project's sheets — so one project can
//     never be compared against another project's leftover plans.
import fs from "fs/promises";
import path from "path";
import { plotDwgSheets } from "./integrations/autocad-da";
import { APS_LIVE } from "./integrations/aps";
import { kvGet } from "./store";
import { projectDir } from "./project-files";
import { DATA_ROOT } from "./data-root";
import {
  hydratePlotViewerFromDisk,
  setPlotViewerFailed,
  setPlotViewerPending,
} from "./plot-viewer-cache";
import { restoreDwgPlotCache, saveDwgPlotCache } from "./dwg-plot-cache";
import { ensureDemoPlanSheets } from "./demo-plan-cache";
import type { Project } from "./types";

export const PLANS_DIR = path.join(DATA_ROOT, "plans");
const PLAN_EXT = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp"]);

export interface PlansPrepResult {
  ok: boolean;
  files: string[];
  source?: "cache" | "disk" | "upload" | "dwg";
  message?: string;
  /** Partial capture: sheets the plot enumerated but could not produce. */
  warning?: string;
}

/** Durable per-project plan store (survives connection drops / re-runs). */
function projectPlansDir(projectId: string): string {
  return path.join(projectDir(projectId), "plans");
}

function planFilesIn(names: string[]): string[] {
  return names.filter((n) => PLAN_EXT.has(path.extname(n).toLowerCase()));
}

async function listIn(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    return planFilesIn(names);
  } catch {
    return [];
  }
}

export async function listPlanFiles(): Promise<string[]> {
  await fs.mkdir(PLANS_DIR, { recursive: true });
  return listIn(PLANS_DIR);
}

// Wipe the global scratch dir so it can be repopulated with ONLY the current
// project's sheets. Without this, listPlanFiles() would surface a previous
// project's leftover PDFs and the new DWG would never be plotted (or worse, be
// compared against the wrong plan set).
async function resetGlobalPlans(): Promise<void> {
  await fs.mkdir(PLANS_DIR, { recursive: true });
  // Remove only plan files — preserve .gitkeep and any non-plan housekeeping
  // files so the tracked, empty plans/ dir survives.
  for (const name of await listIn(PLANS_DIR)) {
    await fs.rm(path.join(PLANS_DIR, name), { force: true });
  }
}

/** Copy every plan sheet from the durable project store into the global dir. */
async function mirrorToGlobal(projectId: string): Promise<string[]> {
  const src = projectPlansDir(projectId);
  const names = await listIn(src);
  for (const name of names) {
    await fs.copyFile(path.join(src, name), path.join(PLANS_DIR, name));
  }
  return listPlanFiles();
}

// Publish durable plan sheets to the in-app viewer cache (plot:{id} KV keys).
export async function publishViewerSheets(projectId: string): Promise<void> {
  await hydratePlotViewerFromDisk(projectId);
}

// Capture-schema marker for a project's durable plan store. v2 plots model
// space alongside the paper layouts and reconciles the layout manifest — a
// durable store WITHOUT the marker predates that (e.g. holds 1 of N sheets of
// a model-space-heavy DWG) and must be re-captured, not served forever.
const PLOT_SCHEMA_MARKER = "_plot-schema.txt";
const PLOT_SCHEMA = "v2-model-space";

async function hasCurrentPlotSchema(projectId: string): Promise<boolean> {
  try {
    const txt = await fs.readFile(path.join(projectPlansDir(projectId), PLOT_SCHEMA_MARKER), "utf8");
    return txt.trim() === PLOT_SCHEMA;
  } catch {
    return false;
  }
}

async function markPlotSchema(projectId: string): Promise<void> {
  try {
    const dir = projectPlansDir(projectId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, PLOT_SCHEMA_MARKER), PLOT_SCHEMA);
  } catch {
    /* marker is an optimization — a failed write just re-captures next run */
  }
}

/** Stage plan PDFs on disk from bundled demo sheets or prior URN plot cache. */
export async function ensureProjectPlansStaged(project: Project): Promise<string[]> {
  const durableDir = projectPlansDir(project.id);
  let durable = await listIn(durableDir);
  if (durable.length > 0) {
    // DWG-sourced stores must come from the current capture schema; stale
    // pre-v2 plots (partial sets) are cleared and re-captured below.
    if (!project.apsUrn || (await hasCurrentPlotSchema(project.id))) return durable;
    for (const name of durable) {
      await fs.rm(path.join(durableDir, name), { force: true });
    }
    // The viewer's disk cache renders the OLD capture — drop it so hydrate
    // rebuilds from the re-captured sheets instead of short-circuiting.
    await fs.rm(path.join(durableDir, ".viewer"), { recursive: true, force: true });
    durable = [];
  }

  const demo = await ensureDemoPlanSheets(project);
  if (demo.length > 0) {
    await markPlotSchema(project.id);
    return demo;
  }

  if (project.apsUrn) {
    const restored = await restoreDwgPlotCache(project.apsUrn, project.id);
    if (restored.length > 0) {
      await markPlotSchema(project.id);
      return restored;
    }
  }

  return [];
}

/**
 * Load this project's staged plan sheets (projects/{id}/plans/*.pdf) as
 * base64 PDFs — the shape the per-sheet vision reader consumes. Names are the
 * plotted layout names (TS, A1.0 …).
 */
export async function loadProjectPlanSheets(
  projectId: string
): Promise<{ name: string; data: string }[]> {
  const dir = projectPlansDir(projectId);
  const names = (await listIn(dir)).filter((n) => n.toLowerCase().endsWith(".pdf"));
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const sheets: { name: string; data: string }[] = [];
  for (const name of names) {
    try {
      const buf = await fs.readFile(path.join(dir, name));
      sheets.push({ name: name.replace(/\.pdf$/i, ""), data: buf.toString("base64") });
    } catch {
      /* skip unreadable file */
    }
  }
  return sheets;
}

function safePlanName(name: string, fallbackExt: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_").trim();
  if (!cleaned) return `plan${fallbackExt}`;
  if (PLAN_EXT.has(path.extname(cleaned).toLowerCase())) return cleaned;
  return `${cleaned}${fallbackExt}`;
}

const prepLocks = new Map<string, Promise<PlansPrepResult>>();

/**
 * Ensure the global plans/ dir holds EXACTLY this project's sheets, ready for the
 * Band Visual/Compare agents. Order of precedence:
 *   1. Durable project store (projects/{id}/plans/) — restore, no re-plot.
 *   2. Uploaded PDF/image (kv plan:{id}) — mirror to durable + global.
 *   3. DWG (apsUrn) — plot via Design Automation, persist to durable + global.
 * Always resets the global dir first so a prior project's plans can't leak in.
 */
export async function ensurePlansReady(
  project: Project,
  onProgress?: (status: string) => void
): Promise<PlansPrepResult> {
  const existing = prepLocks.get(project.id);
  if (existing) return existing;

  const work = prepPlansAndPublish(project, onProgress).finally(() => {
    prepLocks.delete(project.id);
  });
  prepLocks.set(project.id, work);
  return work;
}

async function prepPlansAndPublish(
  project: Project,
  onProgress?: (status: string) => void
): Promise<PlansPrepResult> {
  const result = await prepPlans(project, onProgress);
  if (result.ok && result.files.length > 0) {
    try {
      await publishViewerSheets(project.id);
    } catch {
      /* viewer falls back to the schematic */
    }
  } else if (!result.ok && project.apsUrn) {
    await setPlotViewerFailed(project.id, result.message);
  }
  return result;
}

async function prepPlans(
  project: Project,
  onProgress?: (status: string) => void
): Promise<PlansPrepResult> {
  const durableDir = projectPlansDir(project.id);

  // 0. Durable store, bundled demo sheets, or prior URN plot — no Autodesk
  // wait. (Staleness of pre-v2 DWG captures is handled inside.)
  const durable = await ensureProjectPlansStaged(project);

  // 1. Durable cache hit — this project was already plotted/staged. Restore it.
  if (durable.length > 0) {
    await resetGlobalPlans();
    const files = await mirrorToGlobal(project.id);
    return {
      ok: files.length > 0,
      files,
      source: "cache",
      message: `Restored ${files.length} cached sheet${files.length === 1 ? "" : "s"} for this project.`,
    };
  }

  // Nothing cached yet — the global dir must be rebuilt from scratch for THIS
  // project, so clear any other project's leftovers first.
  await resetGlobalPlans();
  await fs.mkdir(durableDir, { recursive: true });

  // 2. Uploaded PDF/image stored per-project in kv.
  const stored = await kvGet<{ mediaType: string; data: string }>(`plan:${project.id}`);
  if (stored?.data) {
    const ext = /pdf/i.test(stored.mediaType) ? ".pdf" : ".png";
    const diskName = safePlanName(project.pdfName ?? `plan-${project.id.slice(0, 8)}`, ext);
    const buf = Buffer.from(stored.data, "base64");
    await fs.writeFile(path.join(durableDir, diskName), buf);
    await fs.writeFile(path.join(PLANS_DIR, diskName), buf);
    await markPlotSchema(project.id);
    const files = await listPlanFiles();
    return {
      ok: files.length > 0,
      files,
      source: "upload",
      message: files.length ? `Staged uploaded plan to plans/${diskName}` : "Upload could not be written to plans/",
    };
  }

  // 3. DWG → plot every paper-space layout to PDF via Design Automation.
  if (project.apsUrn) {
    if (!APS_LIVE) {
      return {
        ok: false,
        files: [],
        source: "dwg",
        message: "DWG uploaded but Autodesk APS credentials are not configured (APS_CLIENT_ID/SECRET).",
      };
    }
    onProgress?.("submitting workitem to Autodesk Design Automation…");
    await setPlotViewerPending(project.id);
    const { sheets, failure, warning } = await plotDwgSheets(project.apsUrn, onProgress);
    if (sheets.length === 0) {
      await setPlotViewerFailed(project.id, failure);
      return {
        ok: false,
        files: [],
        source: "dwg",
        message: failure ?? "DWG plot returned no sheets",
      };
    }
    for (const sheet of sheets) {
      const diskName = safePlanName(sheet.name, ".pdf");
      const buf = Buffer.from(sheet.data, "base64");
      await fs.writeFile(path.join(durableDir, diskName), buf);
      await fs.writeFile(path.join(PLANS_DIR, diskName), buf);
    }
    await markPlotSchema(project.id);
    if (project.apsUrn) await saveDwgPlotCache(project.apsUrn, project.id);
    const files = await listPlanFiles();
    return {
      ok: files.length > 0,
      files,
      source: "dwg",
      message: `Plotted ${sheets.length} sheet${sheets.length === 1 ? "" : "s"} from DWG into plans/`,
      warning,
    };
  }

  return {
    ok: false,
    files: [],
    message: "No plan set for this project — upload a PDF or DWG when starting the project.",
  };
}
