import { NextResponse } from "next/server";
import { listCityCorpora } from "@/lib/code-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// List every researched city committed to the repo, with its chunk count and
// the code layers present. Powers a jurisdiction picker on the new-project form
// and lets a client confirm a city is ready before running against it.
export async function GET() {
  return NextResponse.json({ cities: listCityCorpora() });
}
