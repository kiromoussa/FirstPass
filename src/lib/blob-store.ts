// Thin wrapper over Vercel Blob for durable artifact storage. On serverless
// hosts /tmp is wiped between invocations, so anything expensive to regenerate
// (APS-plotted DWG sheets) is mirrored here to survive cold starts.
//
// The store is PRIVATE (plan PDFs are user content): blobs are written and read
// with access: "private" and require the read-write token to fetch.
//
// Every function is a no-op / empty when BLOB_READ_WRITE_TOKEN is absent, so
// local dev and non-Vercel hosts keep working off the /tmp cache alone. Blob is
// a best-effort accelerator, never a hard dependency.
import { put, list, get } from "@vercel/blob";

function token(): string | undefined {
  return process.env.BLOB_READ_WRITE_TOKEN || undefined;
}

export function blobEnabled(): boolean {
  return !!token();
}

/** Upload bytes to `key`, overwriting any existing blob at that pathname. */
export async function putBlob(
  key: string,
  bytes: Buffer,
  contentType?: string
): Promise<string | null> {
  if (!blobEnabled()) return null;
  try {
    const res = await put(key, bytes, {
      access: "private",
      token: token(),
      contentType,
      // Deterministic pathname (URN-keyed) so re-plotting the same file
      // overwrites rather than piling up random-suffixed copies.
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return res.url;
  } catch (e) {
    console.warn("[blob] put skipped:", (e as Error)?.message ?? e);
    return null;
  }
}

/** List blob pathnames under a `prefix/` (returns pathnames, not URLs). */
export async function listBlobs(prefix: string): Promise<string[]> {
  if (!blobEnabled()) return [];
  try {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, token: token(), cursor });
      for (const b of page.blobs) out.push(b.pathname);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  } catch (e) {
    console.warn("[blob] list skipped:", (e as Error)?.message ?? e);
    return [];
  }
}

/** Download a blob's bytes by pathname, or null if missing / disabled. */
export async function getBlob(key: string): Promise<Buffer | null> {
  if (!blobEnabled()) return null;
  try {
    const res = await get(key, { access: "private", token: token() });
    if (!res || !res.stream) return null;
    return Buffer.from(await new Response(res.stream).arrayBuffer());
  } catch (e) {
    console.warn("[blob] get skipped:", (e as Error)?.message ?? e);
    return null;
  }
}
