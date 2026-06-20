import { NextRequest, NextResponse } from "next/server";
import { kvSet } from "@/lib/store";
import { resolveCitySlug, loadCityMeta, cityLabel } from "@/lib/code-db";
import type { Project } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    address?: string;
    citySlug?: string;
    dwgName?: string;
    apsUrn?: string;
  };
  const id = crypto.randomUUID();
  // Resolve the jurisdiction: explicit citySlug wins, else infer from address.
  // Falls back to the default demo city when nothing matches a researched city.
  const citySlug = body.citySlug || resolveCitySlug(body.address);
  const meta = loadCityMeta(citySlug);
  const project: Project = {
    id,
    name: body.name?.trim() || "Untitled ADU Project",
    address: body.address?.trim() || cityLabel(citySlug),
    projectType: "detached_adu",
    jurisdictionId: meta?.jurisdictionId || citySlug,
    citySlug,
    status: "created",
    createdAt: Date.now(),
    dwgName: body.dwgName,
    apsUrn: body.apsUrn,
  };
  await kvSet(`proj:${id}`, project);
  return NextResponse.json({ id, citySlug });
}
