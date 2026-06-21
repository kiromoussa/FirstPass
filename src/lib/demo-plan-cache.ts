// Bundled plan sheets for Los Angeles(1).dwg — instant viewer + Compare Codes
// without waiting on Autodesk Design Automation (2–4 min per plot).
import fs from "fs/promises";
import path from "path";
import { projectDir } from "./project-files";
import type { Project } from "./types";

const DEMO_ROOT = path.join(process.cwd(), "data", "demo", "los-angeles-1");
const PLAN_EXT = /\.(pdf|png|jpe?g|webp)$/i;

export function isLosAngelesDemoDwg(project: Pick<Project, "dwgName">): boolean {
  const name = (project.dwgName ?? "").toLowerCase().replace(/\s+/g, "");
  return name.includes("losangeles(1)");
}

async function listPlanFiles(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    return names.filter((n) => PLAN_EXT.test(n) && !n.startsWith("."));
  } catch {
    return [];
  }
}

/** Copy bundled demo PDFs + pre-rendered viewer cache into projects/{id}/plans/. */
export async function restoreDemoPlanSheets(projectId: string): Promise<string[]> {
  const srcPlans = path.join(DEMO_ROOT, "plans");
  const srcViewer = path.join(DEMO_ROOT, "viewer");
  const destPlans = path.join(projectDir(projectId), "plans");

  const demoFiles = await listPlanFiles(srcPlans);
  if (!demoFiles.length) return [];

  const existing = await listPlanFiles(destPlans);
  if (existing.length >= demoFiles.length) {
    await restoreDemoViewerCache(projectId);
    return existing;
  }

  await fs.mkdir(destPlans, { recursive: true });
  for (const name of demoFiles) {
    await fs.copyFile(path.join(srcPlans, name), path.join(destPlans, name));
  }
  await restoreDemoViewerCache(projectId);
  return demoFiles;
}

async function restoreDemoViewerCache(projectId: string): Promise<void> {
  const srcViewer = path.join(DEMO_ROOT, "viewer");
  const destViewer = path.join(projectDir(projectId), "plans", ".viewer");
  try {
    await fs.access(path.join(srcViewer, "meta.json"));
  } catch {
    return;
  }
  await fs.mkdir(destViewer, { recursive: true });
  await fs.copyFile(path.join(srcViewer, "meta.json"), path.join(destViewer, "meta.json"));
  const meta = JSON.parse(await fs.readFile(path.join(srcViewer, "meta.json"), "utf-8")) as {
    sheets: unknown[];
  };
  for (let i = 0; i < meta.sheets.length; i++) {
    try {
      await fs.copyFile(path.join(srcViewer, `${i}.png`), path.join(destViewer, `${i}.png`));
    } catch {
      /* partial cache ok — hydrate will rebuild missing tiles */
    }
  }
}

export async function ensureDemoPlanSheets(project: Project): Promise<string[]> {
  if (!isLosAngelesDemoDwg(project)) return [];
  return restoreDemoPlanSheets(project.id);
}
