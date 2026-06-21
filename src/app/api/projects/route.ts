import { NextRequest, NextResponse } from "next/server";
import { kvSet, kvGet, addToProjectIndex, listProjectIds, loadState } from "@/lib/store";
import { resolveCitySlug, loadCityMeta, cityLabel } from "@/lib/code-db";
import type { Project, ProjectType } from "@/lib/types";
import { PROJECT_TYPES } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const ids = await listProjectIds();
  const projects: Project[] = [];
  for (const id of ids) {
    const state = await loadState(id);
    if (state?.project) {
      projects.push(state.project);
      continue;
    }
    const project = await kvGet<Project>(`proj:${id}`);
    if (project) projects.push(project);
  }
  projects.sort((a, b) => b.createdAt - a.createdAt);
  return NextResponse.json({ projects });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    address?: string;
    citySlug?: string;
    projectType?: string;
    dwgName?: string;
    apsUrn?: string;
  };
  const id = crypto.randomUUID();
  // Validate the requested subtype against the known set; default to detached.
  const projectType: ProjectType = PROJECT_TYPES.some((t) => t.value === body.projectType)
    ? (body.projectType as ProjectType)
    : "detached_adu";
  // Resolve the jurisdiction: explicit citySlug wins, else infer from address.
  // Falls back to the default demo city when nothing matches a researched city.
  const citySlug = body.citySlug || (await resolveCitySlug(body.address));
  const meta = loadCityMeta(citySlug);
  const project: Project = {
    id,
    name: body.name?.trim() || "Untitled ADU Project",
    address: body.address?.trim() || cityLabel(citySlug),
    projectType,
    jurisdictionId: meta?.jurisdictionId || citySlug,
    citySlug,
    status: "created",
    createdAt: Date.now(),
    dwgName: body.dwgName,
    apsUrn: body.apsUrn,
  };
  await kvSet(`proj:${id}`, project);
  await addToProjectIndex(id, project.createdAt);
  return NextResponse.json({ id, citySlug });
}
