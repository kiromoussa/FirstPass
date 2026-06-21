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

/** Encode an OSS object key exactly once for URL paths (avoids double-encoding URN keys). */
export function ossObjectUrlSegment(objectKey: string): string {
  let decoded = objectKey;
  try {
    decoded = decodeURIComponent(objectKey);
  } catch {
    /* key was not percent-encoded */
  }
  return encodeURIComponent(decoded);
}

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
    const objectKey = fileName;
    const keyPath = ossObjectUrlSegment(objectKey);
    // 1. Get signed S3 upload URL(s)
    const signRes = await fetch(
      `${APS_BASE}/oss/v2/buckets/${BUCKET_KEY}/objects/${keyPath}/signeds3upload?minutesExpiration=15`,
      { headers: auth(t) }
    );
    if (!signRes.ok) throw new Error(`signeds3upload GET ${signRes.status}`);
    const sign = (await signRes.json()) as { uploadKey: string; urls: string[] };
    // 2. PUT the bytes to the signed URL
    const put = await fetch(sign.urls[0], { method: "PUT", body: new Uint8Array(bytes) });
    if (!put.ok) throw new Error(`s3 PUT ${put.status}`);
    // 3. Finalize the upload
    const fin = await fetch(
      `${APS_BASE}/oss/v2/buckets/${BUCKET_KEY}/objects/${keyPath}/signeds3upload`,
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

// List every viewable (sheet/layout) in a translated DWG. A plan set is
// translated as MANY 2D viewables — one per layout — each with its own guid.
export interface Viewable {
  guid: string;
  name: string;
  role?: string;
}
export async function listViewables(urn: string): Promise<Viewable[]> {
  const t = await getToken();
  if (!t) return [];
  try {
    const res = await fetch(`${APS_BASE}/modelderivative/v2/designdata/${urn}/metadata`, {
      headers: auth(t),
    });
    if (!res.ok) return [];
    const meta = (await res.json()) as {
      data?: { metadata?: { guid: string; name?: string; role?: string }[] };
    };
    return (meta.data?.metadata ?? []).map((m) => ({
      guid: m.guid,
      name: m.name ?? m.guid,
      role: m.role,
    }));
  } catch {
    return [];
  }
}

// Recursively flatten a property value into "key: value" strings so nested
// property groups (where dimensions/annotations often live) aren't dropped.
function flattenProps(prefix: string, v: unknown, out: string[], depth = 0): void {
  if (depth > 4 || out.length > 6000) return;
  if (v == null) return;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    const s = String(v).trim();
    if (s) out.push(prefix ? `${prefix}: ${s}` : s);
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) flattenProps(prefix, item, out, depth + 1);
    return;
  }
  if (typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      flattenProps(prefix ? `${prefix}.${k}` : k, val, out, depth + 1);
    }
  }
}

// Pull text/property strings from ONE sheet (viewable) of the translated model.
// Each line is tagged with the sheet name so Claude knows its origin.
export async function extractSheetText(urn: string, v: Viewable): Promise<string[]> {
  const t = await getToken();
  if (!t) return [];
  try {
    const propRes = await fetch(
      `${APS_BASE}/modelderivative/v2/designdata/${urn}/metadata/${v.guid}/properties?forceget=true`,
      { headers: auth(t) }
    );
    if (!propRes.ok) return [];
    const props = (await propRes.json()) as {
      data?: { collection?: { name?: string; properties?: Record<string, unknown> }[] };
    };
    const out: string[] = [];
    for (const c of props.data?.collection ?? []) {
      const lines: string[] = [];
      if (c.name) lines.push(c.name);
      flattenProps("", c.properties, lines);
      for (const line of lines) out.push(`[${v.name}] ${line}`);
    }
    return out;
  } catch {
    return [];
  }
}

// Pull text/property strings from EVERY sheet of the translated model so Claude
// can interpret them into typed facts. Returns de-duplicated raw strings tagged
// with the sheet they came from. `onSheet` reports progress as sheets are read.
export async function extractText(
  urn: string,
  onSheet?: (sheet: string, index: number, total: number) => void
): Promise<string[]> {
  const viewables = await listViewables(urn);
  if (viewables.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < viewables.length; i++) {
    onSheet?.(viewables[i].name, i, viewables.length);
    for (const line of await extractSheetText(urn, viewables[i])) {
      if (!seen.has(line)) {
        seen.add(line);
        out.push(line);
      }
    }
  }
  return out.slice(0, 4000);
}

// Decode a Model Derivative URN back to its OSS objectId / bucket / key. The
// URN is url-safe base64 of `urn:adsk.objects:os.object:<bucket>/<key>`.
export function decodeUrn(urn: string): { objectId: string; bucket: string; key: string } | null {
  try {
    const b64 = urn.replace(/-/g, "+").replace(/_/g, "/");
    const objectId = Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64").toString("utf-8");
    const m = objectId.match(/^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/);
    if (!m) return null;
    return { objectId, bucket: m[1], key: m[2] };
  } catch {
    return null;
  }
}

// A signed, time-limited GET url for an OSS object (used to feed the DWG to
// Design Automation as a workitem input).
export async function signedDownloadUrl(
  bucket: string,
  objectKey: string
): Promise<{ url: string } | { error: string }> {
  const t = await getToken();
  if (!t) return { error: "APS auth failed (data:read token)" };
  try {
    const keyPath = ossObjectUrlSegment(objectKey);
    const r = await fetch(
      `${APS_BASE}/oss/v2/buckets/${bucket}/objects/${keyPath}/signeds3download?minutesExpiration=60`,
      { headers: auth(t) }
    );
    if (!r.ok) {
      const body = (await r.text().catch(() => "")).slice(0, 200);
      return { error: `signeds3download HTTP ${r.status}${body ? `: ${body}` : ""} (bucket=${bucket}, key=${objectKey})` };
    }
    return { url: ((await r.json()) as { url: string }).url };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// A signed PUT url for a (new) OSS object plus the uploadKey needed to finalize
// it — used as the Design Automation workitem output target.
export async function signedUploadTarget(
  bucket: string,
  objectKey: string
): Promise<{ url: string; uploadKey: string } | { error: string }> {
  const t = await getToken();
  if (!t) return { error: "APS auth failed (data:write token)" };
  try {
    const keyPath = ossObjectUrlSegment(objectKey);
    const r = await fetch(
      `${APS_BASE}/oss/v2/buckets/${bucket}/objects/${keyPath}/signeds3upload?minutesExpiration=60`,
      { headers: auth(t) }
    );
    if (!r.ok) {
      const body = (await r.text().catch(() => "")).slice(0, 200);
      return { error: `signeds3upload HTTP ${r.status}${body ? `: ${body}` : ""}` };
    }
    const j = (await r.json()) as { urls: string[]; uploadKey: string };
    return { url: j.urls[0], uploadKey: j.uploadKey };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function finalizeUpload(bucket: string, objectKey: string, uploadKey: string): Promise<string | null> {
  const t = await getToken();
  if (!t) return null;
  try {
    const keyPath = ossObjectUrlSegment(objectKey);
    await fetch(`${APS_BASE}/oss/v2/buckets/${bucket}/objects/${keyPath}/signeds3upload`, {
      method: "POST",
      headers: { ...auth(t), "Content-Type": "application/json" },
      body: JSON.stringify({ uploadKey }),
    });
    const r = await fetch(
      `${APS_BASE}/oss/v2/buckets/${bucket}/objects/${keyPath}/signeds3download`,
      { headers: auth(t) }
    );
    if (!r.ok) return null;
    return ((await r.json()) as { url: string }).url;
  } catch {
    return null;
  }
}

// Token with the `code:all` scope Design Automation requires.
export async function getDaToken(): Promise<string | null> {
  return getToken("code:all data:read data:write bucket:create bucket:read");
}

export { BUCKET_KEY };
