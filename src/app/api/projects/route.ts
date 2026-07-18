import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { kvSet, kvGet, addToProjectIndex, listProjectIds, loadState } from "@/lib/store";
import { loadProject } from "@/lib/project-persistence";
import { resolveCitySlug, loadCityMeta, cityLabel, DEFAULT_CITY } from "@/lib/code-db";
import type { Project, ProjectType } from "@/lib/types";
import { PROJECT_TYPES, DEFAULT_PROJECT_TYPE } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const ids = await listProjectIds();
  const projects: Project[] = [];
  for (const id of ids) {
    const state = await loadState(id);
    if (state?.project) {
      if (state.project.ownerId === userId) projects.push(state.project);
      continue;
    }
    const project = (await kvGet<Project>(`proj:${id}`)) ?? (await loadProject(id));
    if (project && project.ownerId === userId) projects.push(project);
  }
  projects.sort((a, b) => b.createdAt - a.createdAt);
  return NextResponse.json({ projects });
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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
    : DEFAULT_PROJECT_TYPE;
  // Resolve the jurisdiction: infer from address when it names a researched city;
  // explicit citySlug only applies when the address doesn't resolve (empty/generic).
  const inferred = await resolveCitySlug(body.address);
  const citySlug =
    inferred !== DEFAULT_CITY
      ? inferred
      : body.citySlug?.trim() || inferred;
  const meta = loadCityMeta(citySlug);
  const project: Project = {
    id,
    ownerId: userId,
    name: body.name?.trim() || "Untitled Project",
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
  const { persistProject } = await import("@/lib/project-persistence");
  await persistProject(project);
  if (project.dwgName) {
    try {
      const { ensureDemoPlanSheets } = await import("@/lib/demo-plan-cache");
      const { publishViewerSheets } = await import("@/lib/plans-prep");
      await ensureDemoPlanSheets(project);
      await publishViewerSheets(id);
    } catch {
      /* viewer hydrates on first GET */
    }
  }

  // Auto-research: the address names a city we have no corpus for (it fell
  // through to the default). Kick the jurisdiction researcher off in the
  // background so by the time the user reviews results — or re-runs — the
  // city's own code is retrievable. Fire-and-forget; the run works either way.
  const addressCity = body.address?.split(",")[1]?.trim();
  const addressState = body.address?.match(/,\s*([A-Z]{2})[\s,]*\d{5}/)?.[1] ?? "CA";
  if (inferred === DEFAULT_CITY && addressCity && /^[a-z][a-z .'-]{1,40}$/i.test(addressCity)) {
    try {
      const { after } = await import("next/server");
      const { researchAndIngestCity, cityCorpusExists, citySlugFor } = await import("@/lib/city-research");
      if (!(await cityCorpusExists(citySlugFor(addressCity, addressState)))) {
        after(async () => {
          const res = await researchAndIngestCity({ city: addressCity, state: addressState });
          console.log(`[projects] auto-research ${res.slug}:`, res.note, `chunks=${res.chunks} rules=${res.rules}`);
        });
      }
    } catch (e) {
      console.error("[projects] auto-research scheduling failed:", (e as Error)?.message ?? e);
    }
  }
  return NextResponse.json({ id, citySlug });
}
