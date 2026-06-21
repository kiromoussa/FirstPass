// Shared on-disk cache for APS-plotted DWG sheets, keyed by OSS object (apsUrn).
// The same uploaded file (same URN) plots once — new projects with the same DWG
// copy sheets from here instead of re-running Design Automation.
import fs from "fs/promises";
import path from "path";
import { decodeUrn } from "./integrations/aps";
import { projectDir } from "./project-files";

const CACHE_ROOT = path.join(process.cwd(), "projects", "_dwg_plots");
const PLAN_EXT = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp"]);

function cacheKeyFromUrn(urn: string): string | null {
  const decoded = decodeUrn(urn);
  if (!decoded?.key) return null;
  return decoded.key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
}

function cacheDirForUrn(urn: string): string | null {
  const key = cacheKeyFromUrn(urn);
  return key ? path.join(CACHE_ROOT, key) : null;
}

async function listPlans(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    return names.filter((n) => PLAN_EXT.has(path.extname(n).toLowerCase()));
  } catch {
    return [];
  }
}

/** Copy cached PDFs for this URN into projects/{id}/plans/ if present. */
export async function restoreDwgPlotCache(urn: string, projectId: string): Promise<string[]> {
  const src = cacheDirForUrn(urn);
  if (!src) return [];
  const files = await listPlans(src);
  if (!files.length) return [];

  const dest = path.join(projectDir(projectId), "plans");
  await fs.mkdir(dest, { recursive: true });
  for (const name of files) {
    await fs.copyFile(path.join(src, name), path.join(dest, name));
  }
  return files;
}

/** Persist projects/{id}/plans/*.pdf into the URN-keyed global cache. */
export async function saveDwgPlotCache(urn: string, projectId: string): Promise<void> {
  const src = path.join(projectDir(projectId), "plans");
  const files = await listPlans(src);
  if (!files.length) return;

  const dest = cacheDirForUrn(urn);
  if (!dest) return;
  await fs.mkdir(dest, { recursive: true });
  for (const name of files) {
    await fs.copyFile(path.join(src, name), path.join(dest, name));
  }
}

export function urnHasPlotCache(urn: string): boolean {
  const dir = cacheDirForUrn(urn);
  return !!dir;
}
