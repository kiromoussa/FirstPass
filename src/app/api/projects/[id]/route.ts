import { NextRequest, NextResponse } from "next/server";
import { loadState, kvGet, kvSet, saveState, deleteProject } from "@/lib/store";
import type { Project } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const state = await loadState(id);
  if (state) return NextResponse.json(state);
  const project = await kvGet<Project>(`proj:${id}`);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ project, sources: [], rules: [], facts: [], findings: [], checklist: [], messages: [] });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await kvGet<Project>(`proj:${id}`);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Partial<Project>;
  const updated: Project = {
    ...project,
    ...(body.apsUrn !== undefined ? { apsUrn: body.apsUrn } : {}),
    ...(body.dwgName !== undefined ? { dwgName: body.dwgName } : {}),
    ...(body.pdfName !== undefined ? { pdfName: body.pdfName } : {}),
    ...(body.planMime !== undefined ? { planMime: body.planMime } : {}),
  };
  await kvSet(`proj:${id}`, updated);
  const state = await loadState(id);
  if (state) await saveState({ ...state, project: updated });
  return NextResponse.json({ ok: true, project: updated });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const exists =
    (await loadState(id)) ?? (await kvGet<Project>(`proj:${id}`));
  if (!exists) return NextResponse.json({ error: "not found" }, { status: 404 });
  await deleteProject(id);
  return NextResponse.json({ ok: true });
}
