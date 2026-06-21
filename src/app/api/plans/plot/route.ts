import { NextRequest, NextResponse } from "next/server";
import { loadProject } from "@/lib/project-persistence";
import { ensurePlansReady, ensureProjectPlansStaged } from "@/lib/plans-prep";
import {
  getPlotViewerMeta,
  hydratePlotViewerFromDisk,
  setPlotViewerFailed,
  setPlotViewerPending,
} from "@/lib/plot-viewer-cache";
import { APS_LIVE } from "@/lib/integrations/aps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Kick off (or resume) DWG plotting for the in-app sheet viewer. Safe to call
// while Band Chat 1 is running — shares the same durable plans/ cache.
export async function POST(req: NextRequest) {
  const projectId =
    req.nextUrl.searchParams.get("projectId") ??
    ((await req.json().catch(() => ({}))) as { projectId?: string }).projectId;
  if (!projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }

  const project = await loadProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }

  const existing = await getPlotViewerMeta(projectId);
  if (existing?.status === "ready" && existing.sheets.length > 0) {
    return NextResponse.json(existing);
  }

  await ensureProjectPlansStaged(project);
  const fromDisk = await hydratePlotViewerFromDisk(projectId);
  if (fromDisk?.status === "ready") {
    return NextResponse.json(fromDisk);
  }

  if (!project.apsUrn) {
    const meta = { status: "failed" as const, sheets: [], reason: "No DWG attached to this project" };
    await setPlotViewerFailed(projectId, meta.reason);
    return NextResponse.json(meta);
  }

  if (!APS_LIVE) {
    const reason = "Autodesk APS is not configured (APS_CLIENT_ID / APS_CLIENT_SECRET)";
    await setPlotViewerFailed(projectId, reason);
    return NextResponse.json({ status: "failed", sheets: [], reason });
  }

  await setPlotViewerPending(projectId);
  const prep = await ensurePlansReady(project);
  if (prep.ok && prep.files.length > 0) {
    const meta = await hydratePlotViewerFromDisk(projectId);
    if (meta?.status === "ready") return NextResponse.json(meta);
  }

  const reason = prep.message ?? "DWG plot returned no sheets";
  await setPlotViewerFailed(projectId, reason);
  return NextResponse.json({ status: "failed", sheets: [], reason });
}
