import { NextRequest, NextResponse } from "next/server";
import { uploadDwg, translate, APS_LIVE } from "@/lib/integrations/aps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Accepts a DWG (multipart form, field "file"), uploads it to APS OSS and kicks
// off SVF2 translation. Returns the Model Derivative URN. If APS isn't
// configured, returns ok:false so the client proceeds with the cached demo set.
export async function POST(req: NextRequest) {
  if (!APS_LIVE) return NextResponse.json({ ok: false, reason: "APS not configured" });
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ ok: false, reason: "no file" }, { status: 400 });
    const bytes = Buffer.from(await file.arrayBuffer());
    const up = await uploadDwg(file.name, bytes);
    if (!up) return NextResponse.json({ ok: false, reason: "upload failed" });
    const started = await translate(up.urn);
    return NextResponse.json({ ok: true, urn: up.urn, objectId: up.objectId, translating: started });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: (e as Error).message }, { status: 500 });
  }
}
