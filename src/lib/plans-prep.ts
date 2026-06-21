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
import type { Project } from "./types";

export const PLANS_DIR = path.join(process.cwd(), "plans");
const PLAN_EXT = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp"]);

export interface PlansPrepResult {
  ok: boolean;
  files: string[];
  source?: "cache" | "disk" | "upload" | "dwg";
  message?: string;
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

function safePlanName(name: string, fallbackExt: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_").trim();
  if (!cleaned) return `plan${fallbackExt}`;
  if (PLAN_EXT.has(path.extname(cleaned).toLowerCase())) return cleaned;
  return `${cleaned}${fallbackExt}`;
}

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
  const durableDir = projectPlansDir(project.id);

  // 1. Durable cache hit — this project was already plotted/staged. Restore it.
  const durable = await listIn(durableDir);
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
    const { sheets, failure } = await plotDwgSheets(project.apsUrn, onProgress);
    if (sheets.length === 0) {
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
      await fs.writeFile(path.join(durableDir, diskName), buf); // durable
      await fs.writeFile(path.join(PLANS_DIR, diskName), buf); // global scratch
    }
    const files = await listPlanFiles();
    return {
      ok: files.length > 0,
      files,
      source: "dwg",
      message: `Plotted ${sheets.length} sheet${sheets.length === 1 ? "" : "s"} from DWG into plans/`,
    };
  }

  return {
    ok: false,
    files: [],
    message: "No plan set for this project — upload a PDF or DWG when starting the project.",
  };
}
