// Disk-backed project records — survives Next.js dev hot reloads that wipe the
// in-memory kv Map. Each project lives under projects/{id}/project.json.
import fs from "fs/promises";
import path from "path";
import type { Project } from "./types";
import { kvGet, kvSet, listProjectIds } from "./store";
import { persistActiveProject } from "./active-project";
import { ensureProjectDir, projectMetaPath, PROJECTS_ROOT } from "./project-files";

/** @deprecated flat cache from earlier builds */
const LEGACY_CACHE_DIR = path.join(process.cwd(), ".cache", "projects");

function legacyProjectPath(id: string): string {
  return path.join(LEGACY_CACHE_DIR, `${id}.json`);
}

export async function persistProject(project: Project): Promise<void> {
  await ensureProjectDir(project.id);
  await fs.writeFile(projectMetaPath(project.id), JSON.stringify(project, null, 2), "utf-8");
  await kvSet(`proj:${project.id}`, project);
  await persistActiveProject(project);
}

export async function loadProject(id: string): Promise<Project | null> {
  // Disk first so /api/run can open SSE immediately when Redis is down.
  for (const p of [projectMetaPath(id), legacyProjectPath(id)]) {
    try {
      const raw = await fs.readFile(p, "utf-8");
      return JSON.parse(raw) as Project;
    } catch {
      /* try next */
    }
  }
  return kvGet<Project>(`proj:${id}`);
}

/** Resolve project for Band Compare Codes — kv, disk cache, then active_project.json. */
export async function resolveProjectForCompare(projectId?: string): Promise<Project | null> {
  if (projectId) {
    const loaded = await loadProject(projectId);
    if (loaded) return loaded;
  }
  try {
    const { loadActiveProject } = await import("./active-project");
    const active = await loadActiveProject();
    if (active) {
      if (projectId && active.id !== projectId) {
        return (await loadProject(projectId)) ?? active;
      }
      return (await loadProject(active.id)) ?? active;
    }
  } catch {
    /* fall through to latest-project fallback */
  }
  // Last resort (demo-safe): never hard-fail Compare Codes — use the most
  // recently created project so a missing/stale active_project.json can't block
  // the run.
  try {
    const [latest] = await listProjectIds();
    if (latest) return loadProject(latest);
  } catch {
    /* nothing else to try */
  }
  return null;
}

export { PROJECTS_ROOT, projectDir, projectMetaPath } from "./project-files";
