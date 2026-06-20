import { NextRequest, NextResponse } from "next/server";
import { kvSet } from "@/lib/store";
import { JURISDICTION_ID } from "@/lib/fixtures";
import type { Project } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    address?: string;
    dwgName?: string;
    apsUrn?: string;
  };
  const id = crypto.randomUUID();
  const project: Project = {
    id,
    name: body.name?.trim() || "Untitled ADU Project",
    address: body.address?.trim() || "Alameda, CA",
    projectType: "detached_adu",
    jurisdictionId: JURISDICTION_ID,
    status: "created",
    createdAt: Date.now(),
    dwgName: body.dwgName,
    apsUrn: body.apsUrn,
  };
  await kvSet(`proj:${id}`, project);
  return NextResponse.json({ id });
}
