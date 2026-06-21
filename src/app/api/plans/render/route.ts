import { NextRequest, NextResponse } from "next/server";
import { kvGet } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PlotMeta {
  status: "ready" | "failed";
  sheets: { name: string }[];
  reason?: string;
}

// Serves the AutoCAD-plotted DWG sheets for the in-app viewer. Without `i`,
// returns the sheet metadata (`{ status, sheets }`); the pipeline writes this
// once plotting finishes, so until then we report `pending` and the viewer polls.
// With `i=<n>`, returns that sheet's PNG bytes (rendered from the plot in the
// pipeline). This replaces the Model Derivative SVF2 viewer, which cannot
// reliably display DWG plan sets.
export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }

  const idx = req.nextUrl.searchParams.get("i");
  if (idx != null) {
    const png = await kvGet<string>(`plot:${projectId}:${idx}`);
    if (!png) return new NextResponse("not found", { status: 404 });
    return new NextResponse(Buffer.from(png, "base64"), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=600",
      },
    });
  }

  const meta = await kvGet<PlotMeta>(`plot:${projectId}`);
  // No marker yet → the pipeline hasn't reached the plot step. Tell the viewer to
  // keep polling rather than surface a "no sheets" message prematurely.
  if (!meta) return NextResponse.json({ status: "pending", sheets: [] });
  return NextResponse.json(meta);
}
