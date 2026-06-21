import { NextRequest, NextResponse } from "next/server";
import { kvGet, kvSet } from "@/lib/store";
import type { Project } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

    const project = await kvGet<Project>(`proj:${projectId}`);
    if (project) {
      await kvSet(`proj:${projectId}`, { ...project, planMime: mediaType, pdfName: file.name });
    }
    return NextResponse.json({ ok: true, mediaType });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: (e as Error).message }, { status: 500 });
  }
}
