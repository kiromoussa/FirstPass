import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { loadState, saveState, deleteProject } from "@/lib/store";
import { loadProject, persistProject } from "@/lib/project-persistence";
import type { Project } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const state = await loadState(id);
  if (state) {
    if (state.project.ownerId !== userId) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(state);
  }
  const project = await loadProject(id);
  if (!project || project.ownerId !== userId) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ project, sources: [], rules: [], facts: [], findings: [], checklist: [], messages: [] });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await params;
    const project = await loadProject(id);
    if (!project || project.ownerId !== userId) return NextResponse.json({ error: "not found" }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as Partial<Project>;
    const updated: Project = {
      ...project,
      ...(body.apsUrn !== undefined ? { apsUrn: body.apsUrn } : {}),
      ...(body.dwgName !== undefined ? { dwgName: body.dwgName } : {}),
      ...(body.pdfName !== undefined ? { pdfName: body.pdfName } : {}),
      ...(body.planMime !== undefined ? { planMime: body.planMime } : {}),
      ...(body.citySlug !== undefined ? { citySlug: body.citySlug } : {}),
    };
    await persistProject(updated);
    if (body.dwgName !== undefined) {
      try {
        const { ensureDemoPlanSheets } = await import("@/lib/demo-plan-cache");
        await ensureDemoPlanSheets(updated);
      } catch {
        /* viewer hydrates on first GET via /api/plans/render */
      }
    }
    const state = await loadState(id);
    if (state) await saveState({ ...state, project: updated });
    return NextResponse.json({ ok: true, project: updated });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const state = await loadState(id);
  const owner = state?.project.ownerId ?? (await loadProject(id))?.ownerId;
  if (!owner) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (owner !== userId) return NextResponse.json({ error: "not found" }, { status: 404 });
  await deleteProject(id);
  return NextResponse.json({ ok: true });
}
