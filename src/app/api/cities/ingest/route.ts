import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { persistChunks } from "@/lib/code-db";
import type { CityMeta } from "@/lib/code-db";
import { chunkDocuments } from "@/lib/city-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ingest a city's researched building code and turn it into a retrievable,
// chunked corpus — durably, so it survives on serverless.
//
// Flow:
//   1. chunk the raw research docs IN-PROCESS (TypeScript chunker) — no Python
//      subprocess, so this works inside a Vercel function
//   2. persist the chunks + meta to Redis (the durable source retrieveCode reads)
//   3. best-effort write the raw docs + chunks.json to disk too, so a local run
//      can `git commit` them (on read-only serverless FS this step is skipped)
//
// Once persisted to Redis, a run for this city retrieves its chunks even after
// the function's filesystem is gone. To make it permanent across deploys, commit
// the on-disk files (run locally, or use scripts/ingest_band_output.py --commit).
//
// Body: {
//   slug, city, state, jurisdictionId?, projectTypes?,
//   sources?: {id,url,title}[],
//   rawSources?: { [filename]: sourceId },
//   documents: { name, content }[]
// }
interface IngestBody {
  slug?: string;
  city?: string;
  state?: string;
  jurisdictionId?: string;
  projectTypes?: string[];
  sources?: { id: string; url: string; title: string }[];
  rawSources?: Record<string, string>;
  documents?: { name: string; content: string }[];
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

function safeTxtName(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  const stem = base.replace(/\.[^.]*$/, "") || "doc";
  return `${stem}.txt`;
}

export async function POST(req: NextRequest) {
  let body: IngestBody;
  try {
    body = (await req.json()) as IngestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const slug = (body.slug || "").trim();
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json(
      { error: "slug must be kebab-case [a-z0-9-], 2-64 chars" },
      { status: 400 }
    );
  }
  const docs = (body.documents || []).filter(
    (d) => d && typeof d.content === "string" && d.content.trim()
  );
  if (docs.length === 0) {
    return NextResponse.json(
      { error: "documents[] is required (raw research text)" },
      { status: 400 }
    );
  }

  // Normalize doc names to .txt and carry the rawSources mapping accordingly.
  const named = docs.map((d, i) => ({
    name: safeTxtName(d.name || `doc-${i + 1}`),
    content: d.content,
  }));
  const rawSources: Record<string, string> = {};
  for (const [k, v] of Object.entries(body.rawSources || {})) rawSources[safeTxtName(k)] = v;

  const meta: CityMeta = {
    slug,
    city: body.city || slug,
    state: body.state || "",
    jurisdictionId: body.jurisdictionId || slug,
    sources: body.sources || [],
    rawSources,
  };

  // 1. Chunk in-process.
  const chunks = chunkDocuments(slug, named, meta);
  if (chunks.length === 0) {
    return NextResponse.json(
      { error: "documents produced no chunks (no detectable sections)" },
      { status: 422 }
    );
  }

  // 2. Persist durably to Redis (survives serverless FS loss).
  const persisted = await persistChunks(slug, chunks, meta);

  // 3. Best-effort write to disk for local commit (skipped on read-only FS).
  let wroteDisk = false;
  let diskError: string | undefined;
  try {
    const cityDir = path.join(process.cwd(), "data", "cities", slug);
    const rawDir = path.join(cityDir, "raw");
    await fs.mkdir(rawDir, { recursive: true });
    for (const d of named) await fs.writeFile(path.join(rawDir, d.name), d.content, "utf-8");
    await fs.writeFile(path.join(cityDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8");
    await fs.writeFile(path.join(cityDir, "chunks.json"), JSON.stringify(chunks, null, 2) + "\n", "utf-8");
    wroteDisk = true;
  } catch (err) {
    diskError = (err as Error).message; // expected on serverless (read-only FS)
  }

  const categories = [...new Set(chunks.map((c) => c.category).filter(Boolean))];
  return NextResponse.json({
    ok: true,
    slug,
    chunks: persisted,
    categories,
    persisted: "redis",
    wroteDisk,
    ...(diskError ? { diskNote: `filesystem not written (${diskError}) — durable copy is in Redis` } : {}),
    note: wroteDisk
      ? `Commit data/cities/${slug}/ (or run scripts/ingest_band_output.py --commit) to make it permanent across deploys.`
      : "Persisted to Redis only (serverless). Re-ingest locally + commit for a permanent repo copy.",
  });
}
