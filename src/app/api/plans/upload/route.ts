import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { loadProject, persistProject } from "@/lib/project-persistence";
import { kvSet } from "@/lib/store";
import { PLANS_DIR } from "@/lib/plans-prep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Accepts a plan set (PDF or image) for native vision reading. Stores the
// bytes under `plan:<projectId>` and flags the project so the pipeline reads it.
// PDFs are read page-by-page by the plan reader directly — no rasterization needed.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    const projectId = form.get("projectId") as string | null;
    if (!file || !projectId) {
      return NextResponse.json({ ok: false, reason: "missing file or projectId" }, { status: 400 });
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    // Conservative cap for a base64-inlined PDF/image upload.
    if (bytes.length > 32 * 1024 * 1024) {
      return NextResponse.json({ ok: false, reason: "file exceeds 32MB" }, { status: 413 });
    }
    const mediaType = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/png");
    await kvSet(`plan:${projectId}`, { mediaType, data: bytes.toString("base64") });

    // Band visual agent reads from plans/ on disk — mirror UI uploads there.
    // Best-effort only: the durable copy is the kvSet above, so a read-only
    // filesystem (Vercel outside /tmp) must never fail the upload.
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "plan.pdf";
    let diskPath: string | null = null;
    try {
      await fs.mkdir(PLANS_DIR, { recursive: true });
      const target = path.join(PLANS_DIR, safeName);
      await fs.writeFile(target, bytes);
      diskPath = `plans/${safeName}`;
    } catch (e) {
      console.warn("[plans/upload] disk mirror skipped (read-only filesystem?):", (e as Error)?.message ?? e);
    }

    const project = await loadProject(projectId);
    if (project) {
      await persistProject({ ...project, planMime: mediaType, pdfName: file.name });
    }
    return NextResponse.json({ ok: true, mediaType, diskPath });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: (e as Error).message }, { status: 500 });
  }
}
