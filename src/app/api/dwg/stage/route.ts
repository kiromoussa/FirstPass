import { NextRequest, NextResponse } from "next/server";
import { loadProject, persistProject } from "@/lib/project-persistence";
import { writeProjectDwg } from "@/lib/project-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Stage a DWG under projects/{projectId}/ for Compare Codes (Band). */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    const projectId = form.get("projectId") as string | null;
    if (!file || !projectId) {
      return NextResponse.json({ ok: false, reason: "missing file or projectId" }, { status: 400 });
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const { dir, dwgPath } = await writeProjectDwg(projectId, file.name, bytes);

    const project = await loadProject(projectId);
    if (project) {
      await persistProject({ ...project, dwgName: file.name, dwgPath });
    }
    return NextResponse.json({ ok: true, path: dwgPath, dir });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: (e as Error).message }, { status: 500 });
  }
}
