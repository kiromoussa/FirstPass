// Shared on-disk cache for APS-plotted DWG sheets, keyed by OSS object (apsUrn).
// The same uploaded file (same URN) plots once — new projects with the same DWG
// copy sheets from here instead of re-running Design Automation.
import fs from "fs/promises";
import path from "path";
import { decodeUrn } from "./integrations/aps";
import { projectDir } from "./project-files";
import { DATA_ROOT } from "./data-root";
import { blobEnabled, putBlob, getBlob, listBlobs } from "./blob-store";

const CACHE_ROOT = path.join(DATA_ROOT, "projects", "_dwg_plots");
const PLAN_EXT = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp"]);

// Blob pathname prefix for the durable (cross-invocation) plot mirror.
const BLOB_ROOT = "dwg-plots";

function cacheKeyFromUrn(urn: string): string | null {
  const decoded = decodeUrn(urn);
  if (!decoded?.key) return null;
  return decoded.key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
}

function cacheDirForUrn(urn: string): string | null {
  const key = cacheKeyFromUrn(urn);
  return key ? path.join(CACHE_ROOT, key) : null;
}

function blobPrefixForUrn(urn: string): string | null {
  const key = cacheKeyFromUrn(urn);
  return key ? `${BLOB_ROOT}/${key}` : null;
}

function contentTypeFor(name: string): string {
  switch (path.extname(name).toLowerCase()) {
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

async function listPlans(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    return names.filter((n) => PLAN_EXT.has(path.extname(n).toLowerCase()));
  } catch {
    return [];
  }
}

/**
 * Restore cached sheets for this URN into projects/{id}/plans/.
 * Tries the fast local /tmp cache first; on a miss (cold start wiped /tmp)
 * falls back to the durable Blob mirror and warms /tmp on the way through.
 */
export async function restoreDwgPlotCache(urn: string, projectId: string): Promise<string[]> {
  const src = cacheDirForUrn(urn);
  if (!src) return [];

  const dest = path.join(projectDir(projectId), "plans");
  const local = await listPlans(src);
  if (local.length) {
    await fs.mkdir(dest, { recursive: true });
    for (const name of local) {
      await fs.copyFile(path.join(src, name), path.join(dest, name));
    }
    return local;
  }

  // Local miss - pull from the durable Blob mirror if available.
  return restoreFromBlob(urn, projectId, src, dest);
}

async function restoreFromBlob(
  urn: string,
  projectId: string,
  localCacheDir: string,
  dest: string
): Promise<string[]> {
  const prefix = blobPrefixForUrn(urn);
  if (!prefix || !blobEnabled()) return [];

  const pathnames = await listBlobs(`${prefix}/`);
  if (!pathnames.length) return [];

  await fs.mkdir(dest, { recursive: true });
  await fs.mkdir(localCacheDir, { recursive: true });
  const restored: string[] = [];
  for (const pathname of pathnames) {
    const name = path.basename(pathname);
    if (!PLAN_EXT.has(path.extname(name).toLowerCase())) continue;
    const bytes = await getBlob(pathname);
    if (!bytes) continue;
    await fs.writeFile(path.join(dest, name), bytes);
    // Warm the local cache so repeat reads in this invocation stay on disk.
    await fs.writeFile(path.join(localCacheDir, name), bytes);
    restored.push(name);
  }
  return restored;
}

/**
 * Persist projects/{id}/plans/* into the URN-keyed cache: the local /tmp cache
 * (fast, same-invocation reuse) and the durable Blob mirror (survives cold
 * starts so the same DWG never re-runs 2-4 min Design Automation).
 */
export async function saveDwgPlotCache(urn: string, projectId: string): Promise<void> {
  const src = path.join(projectDir(projectId), "plans");
  const files = await listPlans(src);
  if (!files.length) return;

  const dest = cacheDirForUrn(urn);
  if (dest) {
    await fs.mkdir(dest, { recursive: true });
    for (const name of files) {
      await fs.copyFile(path.join(src, name), path.join(dest, name));
    }
  }

  const prefix = blobPrefixForUrn(urn);
  if (prefix && blobEnabled()) {
    for (const name of files) {
      try {
        const bytes = await fs.readFile(path.join(src, name));
        await putBlob(`${prefix}/${name}`, bytes, contentTypeFor(name));
      } catch (e) {
        console.warn("[dwg-plot-cache] blob mirror skipped:", (e as Error)?.message ?? e);
      }
    }
  }
}

export function urnHasPlotCache(urn: string): boolean {
  const dir = cacheDirForUrn(urn);
  return !!dir;
}
