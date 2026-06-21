import { NextResponse } from "next/server";
import {
  DEFAULT_CITY,
  loadCityChunks,
  loadCityMeta,
  loadStoredChunks,
  loadStoredMeta,
  cityLabel,
  type CodeChunk,
} from "@/lib/code-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const categoriesOf = (chunks: CodeChunk[]) =>
  [...new Set(chunks.map((c) => c.category).filter(Boolean))].sort();

// Health check for one city: reports whether it resolves from the committed
// on-disk corpus, the durable Redis store, or neither — and which source a run
// would actually retrieve from. Use this in the deployed env to confirm a
// runtime-ingested city persisted (expect source/retrievesFrom = "redis").
//
//   GET /api/cities/los-angeles-ca
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const diskChunks = loadCityChunks(slug); // CodeChunk[] | null (reads chunks.json)
  const diskMeta = loadCityMeta(slug);
  const storedChunks = await loadStoredChunks(slug); // from Redis index
  const storedMeta = await loadStoredMeta(slug);

  const onDisk = !!diskChunks?.length;
  const inRedis = storedChunks.length > 0;
  const resolved = onDisk || inRedis;

  // retrieveCode() prefers the Redis index, then the on-disk corpus, then the
  // built-in fallback — mirror that here so the report matches real behavior.
  const retrievesFrom = inRedis ? "redis" : onDisk ? "disk" : "builtin-fallback";

  const meta = diskMeta ?? storedMeta;
  return NextResponse.json(
    {
      slug,
      resolved,
      label: meta ? [meta.city, meta.state].filter(Boolean).join(", ") || slug : cityLabel(slug),
      // Where the corpus exists right now:
      sources: {
        disk: { present: onDisk, chunks: diskChunks?.length ?? 0, categories: onDisk ? categoriesOf(diskChunks!) : [] },
        redis: { present: inRedis, chunks: storedChunks.length, categories: inRedis ? categoriesOf(storedChunks) : [] },
      },
      // Where a run for this city would read code from:
      retrievesFrom,
      isDefaultCity: slug === DEFAULT_CITY,
      note: resolved
        ? `Resolved from ${retrievesFrom}. ${onDisk ? "Committed to the repo (permanent)." : "Durable in Redis; commit data/cities/" + slug + "/ to persist across deploys."}`
        : "Not found on disk or in Redis. Ingest it via POST /api/cities/ingest.",
    },
    { status: resolved ? 200 : 404 }
  );
}
