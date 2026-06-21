// Per-project workspace on disk: projects/{id}/project.json, plan.dwg, plans/, etc.
import fs from "fs/promises";
import path from "path";
import type { Project } from "./types";

export const PROJECTS_ROOT = path.join(process.cwd(), "projects");

/** @deprecated legacy flat upload dir — read-only fallback */
const LEGACY_UPLOADS_DIR = path.join(process.cwd(), "uploads");

export function projectDir(projectId: string): string {
  return path.join(PROJECTS_ROOT, projectId);
}

export function projectMetaPath(projectId: string): string {
  return path.join(projectDir(projectId), "project.json");
}

export function projectStatePath(projectId: string): string {
  return path.join(projectDir(projectId), "state.json");
}

export function safeFilename(name: string, fallback = "plan.dwg"): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").trim() || fallback;
}

export function projectDwgPaths(projectId: string, originalName?: string): {
  canonical: string;
  named: string | null;
} {
  const dir = projectDir(projectId);
  const canonical = path.join(dir, "plan.dwg");
  const named = originalName ? path.join(dir, safeFilename(originalName)) : null;
  return { canonical, named };
}

export async function ensureProjectDir(projectId: string): Promise<string> {
  const dir = projectDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** All projects with a project.json on disk (newest first). */
export async function listDiskProjects(): Promise<{ id: string; createdAt: number }[]> {
  try {
    const entries = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true });
    const out: { id: string; createdAt: number }[] = [];
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith("_") || ent.name.startsWith(".")) continue;
      const metaPath = projectMetaPath(ent.name);
      try {
        const raw = await fs.readFile(metaPath, "utf-8");
        const meta = JSON.parse(raw) as { id?: string; createdAt?: number };
        out.push({ id: meta.id ?? ent.name, createdAt: meta.createdAt ?? 0 });
      } catch {
        /* skip dirs without readable project.json */
      }
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  } catch {
    return [];
  }
}

/** Write a DWG into projects/{id}/plan.dwg (+ original safe filename). */
export async function writeProjectDwg(
  projectId: string,
  originalName: string,
  bytes: Buffer
): Promise<{ dir: string; dwgPath: string; namedPath: string | null }> {
  await ensureProjectDir(projectId);
  const { canonical, named } = projectDwgPaths(projectId, originalName);
  await fs.writeFile(canonical, bytes);
  if (named && named !== canonical) {
    await fs.writeFile(named, bytes);
  }
  return { dir: projectDir(projectId), dwgPath: canonical, namedPath: named };
}

async function tryRead(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

/** Load staged DWG bytes for a project (project dir first, then legacy uploads/). */
export async function readProjectDwg(project: Project): Promise<Buffer | null> {
  if (project.dwgPath) {
    const fromPath = await tryRead(project.dwgPath);
    if (fromPath) return fromPath;
  }

  const { canonical, named } = projectDwgPaths(project.id, project.dwgName);
  for (const p of [canonical, named].filter(Boolean) as string[]) {
    const bytes = await tryRead(p);
    if (bytes) return bytes;
  }

  const legacyNames = [
    `${project.id}.dwg`,
    project.dwgName ? safeFilename(project.dwgName) : "",
    "los-angeles.dwg",
  ].filter(Boolean);
  for (const name of legacyNames) {
    const bytes = await tryRead(path.join(LEGACY_UPLOADS_DIR, name));
    if (bytes) return bytes;
  }
  return null;
}
