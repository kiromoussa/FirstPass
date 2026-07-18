import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { loadProject, persistProject } from "@/lib/project-persistence";
import { writeProjectDwg } from "@/lib/project-files";
import { getBlob } from "@/lib/blob-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Stage a DWG under projects/{projectId}/ for Compare Codes (Band). Takes a
 * { blobUrl, fileName } pointer to a file the browser already staged in
 * Vercel Blob (see /api/blob/dwg-token) rather than the raw bytes, since
 * Vercel Functions cap request bodies at 4.5MB and real DWGs routinely
 * exceed that.
 */
export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

    const { blobUrl, fileName, projectId } = (await req.json()) as {
      blobUrl?: string;
      fileName?: string;
      projectId?: string;
    };
    if (!blobUrl || !fileName || !projectId) {
      return NextResponse.json(
        { ok: false, reason: "missing blobUrl, fileName or projectId" },
        { status: 400 }
      );
    }
    const project = await loadProject(projectId);
    if (!project || project.ownerId !== userId) {
      return NextResponse.json({ ok: false, reason: "project not found" }, { status: 404 });
    }
    const bytes = await getBlob(blobUrl);
    if (!bytes) {
      return NextResponse.json(
        { ok: false, reason: "could not read the uploaded file from blob storage" },
        { status: 400 }
      );
    }
    const { dir, dwgPath } = await writeProjectDwg(projectId, fileName, bytes);
    await persistProject({ ...project, dwgName: fileName, dwgPath });
    return NextResponse.json({ ok: true, path: dwgPath, dir });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: (e as Error).message }, { status: 500 });
  }
}
