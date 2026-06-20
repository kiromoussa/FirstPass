// Autodesk Platform Services (APS) adapter — DWG upload + Model Derivative
// translation (PLAN.md addendum: DWG input). Live with APS_CLIENT_ID/SECRET;
// every method degrades gracefully so the pipeline never hard-fails.
//
// Flow: 2-legged token → OSS bucket → signed-S3 upload → Model Derivative job
// (svf2, 2d/3d) → poll manifest → metadata/properties. The frontend APS Viewer
// loads the resulting URN with a viewables:read token.

const APS_BASE = "https://developer.api.autodesk.com";
export const APS_LIVE =
  !!process.env.APS_CLIENT_ID && !!process.env.APS_CLIENT_SECRET;

const BUCKET_KEY = `firstpass-${(process.env.APS_CLIENT_ID || "dev")
  .toLowerCase()
  .replace(/[^a-z0-9]/g, "")
  .slice(0, 20)}`;

interface Token {
  access_token: string;
  expires_at: number;
}
let cached: Token | null = null;

export async function getToken(
  scope = "data:read data:write data:create bucket:create bucket:read viewables:read"
): Promise<string | null> {
  if (!APS_LIVE) return null;
  if (cached && cached.expires_at > Date.now() + 60_000) return cached.access_token;
  try {
    const res = await fetch(`${APS_BASE}/authentication/v2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " +
          Buffer.from(
            `${process.env.APS_CLIENT_ID}:${process.env.APS_CLIENT_SECRET}`
          ).toString("base64"),
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope }),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { access_token: string; expires_in: number };
    cached = { access_token: d.access_token, expires_at: Date.now() + d.expires_in * 1000 };
    return cached.access_token;
  } catch {
    return null;
  }
}

// A short-lived viewables:read token for the in-browser Viewer.
export async function getViewerToken(): Promise<{ access_token: string; expires_in: number } | null> {
  if (!APS_LIVE) return null;
  try {
    const res = await fetch(`${APS_BASE}/authentication/v2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " +
          Buffer.from(
            `${process.env.APS_CLIENT_ID}:${process.env.APS_CLIENT_SECRET}`
          ).toString("base64"),
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "viewables:read" }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { access_token: string; expires_in: number };
  } catch {
    return null;
  }
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
export const urnOf = (objectId: string) =>
  Buffer.from(objectId).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

async function ensureBucket(t: string): Promise<void> {
  const res = await fetch(`${APS_BASE}/oss/v2/buckets`, {
    method: "POST",
    headers: { ...auth(t), "Content-Type": "application/json" },
    body: JSON.stringify({ bucketKey: BUCKET_KEY, policyKey: "transient" }),
  });
  // 409 = already exists, which is fine.
  if (!res.ok && res.status !== 409) {
    throw new Error(`bucket create ${res.status}`);
  }
}

// Upload bytes to OSS via the signed-S3 flow and return the translation URN.
export async function uploadDwg(
  fileName: string,
  bytes: Buffer
): Promise<{ urn: string; objectId: string } | null> {
  const t = await getToken();
  if (!t) return null;
  try {
    await ensureBucket(t);
    const objectKey = encodeURIComponent(fileName);
    // 1. Get signed S3 upload URL(s)
    const signRes = await fetch(
      `${APS_BASE}/oss/v2/buckets/${BUCKET_KEY}/objects/${objectKey}/signeds3upload?minutesExpiration=15`,
      { headers: auth(t) }
    );
    if (!signRes.ok) throw new Error(`signeds3upload GET ${signRes.status}`);
    const sign = (await signRes.json()) as { uploadKey: string; urls: string[] };
    // 2. PUT the bytes to the signed URL
    const put = await fetch(sign.urls[0], { method: "PUT", body: new Uint8Array(bytes) });
    if (!put.ok) throw new Error(`s3 PUT ${put.status}`);
    // 3. Finalize the upload
    const fin = await fetch(
      `${APS_BASE}/oss/v2/buckets/${BUCKET_KEY}/objects/${objectKey}/signeds3upload`,
      {
        method: "POST",
        headers: { ...auth(t), "Content-Type": "application/json" },
        body: JSON.stringify({ uploadKey: sign.uploadKey }),
      }
    );
    if (!fin.ok) throw new Error(`signeds3upload POST ${fin.status}`);
    const obj = (await fin.json()) as { objectId: string };
    return { urn: urnOf(obj.objectId), objectId: obj.objectId };
  } catch {
    return null;
  }
}

// Kick off SVF2 translation (2D + 3D) for a DWG URN.
export async function translate(urn: string): Promise<boolean> {
  const t = await getToken();
  if (!t) return false;
  try {
    const res = await fetch(`${APS_BASE}/modelderivative/v2/designdata/job`, {
      method: "POST",
      headers: { ...auth(t), "Content-Type": "application/json", "x-ads-force": "true" },
      body: JSON.stringify({
        input: { urn },
        output: { formats: [{ type: "svf2", views: ["2d", "3d"] }] },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface ManifestStatus {
  status: string; // pending | inprogress | success | failed | timeout
  progress: string;
}

export async function manifest(urn: string): Promise<ManifestStatus | null> {
  const t = await getToken();
  if (!t) return null;
  try {
    const res = await fetch(`${APS_BASE}/modelderivative/v2/designdata/${urn}/manifest`, {
      headers: auth(t),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { status: string; progress: string };
    return { status: d.status, progress: d.progress };
  } catch {
    return null;
  }
}

// Poll the manifest until translation finishes (or times out).
export async function waitForTranslation(
  urn: string,
  timeoutMs = 90_000,
  onTick?: (s: ManifestStatus) => void
): Promise<ManifestStatus | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const m = await manifest(urn);
    if (m) {
      onTick?.(m);
      if (m.status === "success" || m.status === "failed" || m.status === "timeout") return m;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  return manifest(urn);
}

// Best-effort fact extraction: pull text/property strings from the translated
// model so Claude can interpret them into typed facts. Returns raw strings.
export async function extractText(urn: string): Promise<string[]> {
  const t = await getToken();
  if (!t) return [];
  try {
    const metaRes = await fetch(`${APS_BASE}/modelderivative/v2/designdata/${urn}/metadata`, {
      headers: auth(t),
    });
    if (!metaRes.ok) return [];
    const meta = (await metaRes.json()) as { data?: { metadata?: { guid: string }[] } };
    const guid = meta.data?.metadata?.[0]?.guid;
    if (!guid) return [];
    const propRes = await fetch(
      `${APS_BASE}/modelderivative/v2/designdata/${urn}/metadata/${guid}/properties`,
      { headers: auth(t) }
    );
    if (!propRes.ok) return [];
    const props = (await propRes.json()) as {
      data?: { collection?: { name?: string; properties?: Record<string, unknown> }[] };
    };
    const out: string[] = [];
    for (const c of props.data?.collection ?? []) {
      if (c.name) out.push(c.name);
      for (const [k, v] of Object.entries(c.properties ?? {})) {
        if (typeof v === "string" || typeof v === "number") out.push(`${k}: ${v}`);
      }
    }
    return out.slice(0, 500);
  } catch {
    return [];
  }
}

export { BUCKET_KEY };
