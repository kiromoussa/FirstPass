import { NextRequest, NextResponse } from "next/server";
import { uploadDwg, translate, APS_LIVE } from "@/lib/integrations/aps";
import { getBlob } from "@/lib/blob-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Accepts a { blobUrl, fileName } pointer to a DWG the browser already staged
// in Vercel Blob (see /api/blob/dwg-token), uploads it to APS OSS and kicks off
// SVF2 translation. Returns the Model Derivative URN. The file is fetched from
// Blob server-to-server, not from the request body, since Vercel Functions cap
// request bodies at 4.5MB and real DWGs routinely exceed that. If APS isn't
// configured, returns ok:false so the client proceeds with the cached demo set.
export async function POST(req: NextRequest) {
  if (!APS_LIVE) return NextResponse.json({ ok: false, reason: "APS not configured" });
  try {
    const { blobUrl, fileName } = (await req.json()) as { blobUrl?: string; fileName?: string };
    if (!blobUrl || !fileName) {
      return NextResponse.json({ ok: false, reason: "missing blobUrl or fileName" }, { status: 400 });
    }
    const bytes = await getBlob(blobUrl);
    if (!bytes) {
      return NextResponse.json(
        { ok: false, reason: "could not read the uploaded file from blob storage" },
        { status: 400 }
      );
    }
    const up = await uploadDwg(fileName, bytes);
    if (!up) return NextResponse.json({ ok: false, reason: "upload failed" });
    const started = await translate(up.urn);
    return NextResponse.json({ ok: true, urn: up.urn, objectId: up.objectId, translating: started });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: (e as Error).message }, { status: 500 });
  }
}
