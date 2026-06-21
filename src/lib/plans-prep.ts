// Prepare plan sheets on disk for the Band Visual agent (plans/ → plan_facts.txt).
import fs from "fs/promises";
import path from "path";
import { plotDwgSheets } from "./integrations/autocad-da";
import { APS_LIVE } from "./integrations/aps";
import { kvGet } from "./store";
import type { Project } from "./types";

export const PLANS_DIR = path.join(process.cwd(), "plans");
const PLAN_EXT = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp"]);

export interface PlansPrepResult {
  ok: boolean;
  files: string[];
  source?: "disk" | "upload" | "dwg";
  message?: string;
}

export async function listPlanFiles(): Promise<string[]> {
  try {
    await fs.mkdir(PLANS_DIR, { recursive: true });
    const names = await fs.readdir(PLANS_DIR);
    return names.filter((n) => PLAN_EXT.has(path.extname(n).toLowerCase()));
  } catch {
    return [];
  }
}

function safePlanName(name: string, fallbackExt: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_").trim();
  if (!cleaned) return `plan${fallbackExt}`;
  if (PLAN_EXT.has(path.extname(cleaned).toLowerCase())) return cleaned;
  return `${cleaned}${fallbackExt}`;
}

/** Ensure PDF/PNG sheets exist in plans/ for the Visual Band agent. */
export async function ensurePlansReady(
  project: Project,
  onProgress?: (status: string) => void
): Promise<PlansPrepResult> {
  let files = await listPlanFiles();
  if (files.length > 0) {
    return { ok: true, files, source: "disk" };
  }

  const stored = await kvGet<{ mediaType: string; data: string }>(`plan:${project.id}`);
  if (stored?.data) {
    const ext = /pdf/i.test(stored.mediaType) ? ".pdf" : ".png";
    const diskName = safePlanName(project.pdfName ?? `plan-${project.id.slice(0, 8)}`, ext);
    await fs.mkdir(PLANS_DIR, { recursive: true });
    await fs.writeFile(path.join(PLANS_DIR, diskName), Buffer.from(stored.data, "base64"));
    files = await listPlanFiles();
    return {
      ok: files.length > 0,
      files,
      source: "upload",
      message: files.length ? `Mirrored uploaded plan to plans/${diskName}` : "Upload could not be written to plans/",
    };
  }

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
    await fs.mkdir(PLANS_DIR, { recursive: true });
    const prefix = project.id.slice(0, 8);
    for (const sheet of sheets) {
      const diskName = safePlanName(`${prefix}_${sheet.name}`, ".pdf");
      await fs.writeFile(path.join(PLANS_DIR, diskName), Buffer.from(sheet.data, "base64"));
    }
    files = await listPlanFiles();
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
    message: "No plan set in plans/ — upload a PDF or DWG when starting the project.",
  };
}
