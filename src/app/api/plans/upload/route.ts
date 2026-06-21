import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { loadProject, persistProject } from "@/lib/project-persistence";
import { kvSet } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PLANS_DIR = path.join(process.cwd(), "plans");

// Accepts a plan set (PDF or image) for native Claude-vision reading. Stores the
// bytes under `plan:<projectId>` and flags the project so the pipeline reads it.
// PDFs are read page-by-page by Claude directly — no rasterization needed.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    const projectId = form.get("projectId") as string | null;
    if (!file || !projectId) {
      return NextResponse.json({ ok: false, reason: "missing file or projectId" }, { status: 400 });
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    // Anthropic limit: 32MB / 100 pages for PDFs.
    if (bytes.length > 32 * 1024 * 1024) {
      return NextResponse.json({ ok: false, reason: "file exceeds 32MB" }, { status: 413 });
    }
    const mediaType = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/png");
    await kvSet(`plan:${projectId}`, { mediaType, data: bytes.toString("base64") });

    // Band visual agent reads from plans/ on disk — mirror UI uploads there.
    await fs.mkdir(PLANS_DIR, { recursive: true });
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "plan.pdf";
    const diskPath = path.join(PLANS_DIR, safeName);
    await fs.writeFile(diskPath, bytes);

    const project = await loadProject(projectId);
    if (project) {
      await persistProject({ ...project, planMime: mediaType, pdfName: file.name });
    }
    return NextResponse.json({ ok: true, mediaType, diskPath: `plans/${safeName}` });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: (e as Error).message }, { status: 500 });
  }
}
