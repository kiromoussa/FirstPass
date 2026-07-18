import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { researchAndIngestCity } from "@/lib/city-research";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Discovery (web search) + up to 6 page fetches + rule derivation — the whole
// run is bounded well under this, but code portals can be slow.
export const maxDuration = 300;

// Research a jurisdiction end-to-end and make it runnable: find its official
// code sources with AI web search, fetch and chunk them into the durable
// corpus store, and derive its numeric compliance rules. Idempotent — a city
// that already has a corpus returns immediately unless force is set.
//
// Body: { city: string, state?: string, force?: boolean }
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    city?: string;
    state?: string;
    force?: boolean;
  };
  if (!body.city?.trim()) {
    return NextResponse.json({ error: "city is required" }, { status: 400 });
  }

  const notes: string[] = [];
  const result = await researchAndIngestCity({
    city: body.city,
    state: body.state ?? "CA",
    force: body.force === true,
    onNote: (n) => notes.push(n),
  });
  return NextResponse.json({ ...result, notes }, { status: result.ok ? 200 : 422 });
}
