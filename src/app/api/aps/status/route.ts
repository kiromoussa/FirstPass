import { NextRequest, NextResponse } from "next/server";
import { manifest } from "@/lib/integrations/aps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Translation status for a URN (polled by the Viewer before it loads the model).
export async function GET(req: NextRequest) {
  const urn = req.nextUrl.searchParams.get("urn");
  if (!urn) return NextResponse.json({ error: "urn required" }, { status: 400 });
  const m = await manifest(urn);
  if (!m) return NextResponse.json({ status: "unknown", progress: "0%" });
  return NextResponse.json(m);
}
