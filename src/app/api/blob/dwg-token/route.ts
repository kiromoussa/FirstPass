import { NextRequest, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { auth } from "@clerk/nextjs/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Issues a short-lived client token so a plan set (DWG or PDF) uploads directly
// from the browser to Vercel Blob. Vercel Functions cap the request body at
// 4.5MB, so routing the raw file through a Function here would reject any
// real-world DWG. The file bytes never pass through this handler.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json()) as HandleUploadBody;
  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [
          "application/acad",
          "image/vnd.dwg",
          "application/dxf",
          "application/octet-stream",
          "application/pdf",
          "image/png",
          "image/jpeg",
        ],
        addRandomSuffix: true,
        maximumSizeInBytes: 200 * 1024 * 1024,
      }),
    });
    return NextResponse.json(jsonResponse);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
