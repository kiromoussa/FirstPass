import { NextRequest, NextResponse } from "next/server";
import { loadState, kvGet } from "@/lib/store";
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
