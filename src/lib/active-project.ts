// Tracks the in-flight FirstPass project on disk so Band agents (Python) can
// invoke the TypeScript Compare Codes pipeline without sharing the Next.js memory store.
import fs from "fs/promises";
import path from "path";
import type { Project } from "./types";
import { OUTPUT_DIR } from "./band-output";

const ACTIVE_PATH = path.join(OUTPUT_DIR, "active_project.json");

export async function persistActiveProject(project: Project): Promise<void> {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(ACTIVE_PATH, JSON.stringify(project, null, 2), "utf-8");
}

export async function loadActiveProject(): Promise<Project | null> {
  try {
    const raw = await fs.readFile(ACTIVE_PATH, "utf-8");
    return JSON.parse(raw) as Project;
  } catch {
    return null;
  }
}
