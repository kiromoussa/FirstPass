import { NextResponse } from "next/server";
import { getViewerToken } from "@/lib/integrations/aps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Short-lived viewables:read token for the in-browser APS Viewer.
export async function GET() {
  const tok = await getViewerToken();
  if (!tok) return NextResponse.json({ error: "APS not configured" }, { status: 503 });
  return NextResponse.json(tok);
}
