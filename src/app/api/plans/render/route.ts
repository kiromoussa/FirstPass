import { NextRequest, NextResponse } from "next/server";
import {
  getPlotViewerMeta,
  getPlotViewerPng,
  hydratePlotViewerFromDisk,
} from "@/lib/plot-viewer-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Serves AutoCAD-plotted DWG sheets for the in-app viewer. Without `i`, returns
// `{ status, sheets }`. With `i=<n>`, returns that sheet's PNG bytes.
export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }

  const idx = req.nextUrl.searchParams.get("i");
  if (idx != null) {
    const png = await getPlotViewerPng(projectId, Number(idx));
    if (!png) return new NextResponse("not found", { status: 404 });
    return new NextResponse(Buffer.from(png, "base64"), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=600",
      },
    });
  }

  let meta = await getPlotViewerMeta(projectId);
  if (!meta || (meta.status !== "ready" && meta.status !== "failed")) {
    const hydrated = await hydratePlotViewerFromDisk(projectId);
    if (hydrated) meta = hydrated;
  }

  if (!meta) return NextResponse.json({ status: "pending", sheets: [] });
  return NextResponse.json(meta);
}
