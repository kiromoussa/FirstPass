import { NextResponse } from "next/server";
import {
  listCityCorpora,
  listStoredCities,
  loadStoredMeta,
  storedChunkCount,
  cityLabel,
  type CitySummary,
} from "@/lib/code-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// List every city available to run against — committed on-disk corpora plus any
// ingested at runtime into the durable store (Redis). Powers a jurisdiction
// picker and lets a client confirm a city is ready before running.
export async function GET() {
  const onDisk = listCityCorpora();
  const seen = new Set(onDisk.map((c) => c.slug));

  const storeOnly: CitySummary[] = [];
  try {
    for (const slug of await listStoredCities()) {
      if (seen.has(slug)) continue; // disk copy already covers it
      const meta = await loadStoredMeta(slug);
      storeOnly.push({
        slug,
        label: meta ? [meta.city, meta.state].filter(Boolean).join(", ") || slug : cityLabel(slug),
        city: meta?.city,
        state: meta?.state,
        chunks: await storedChunkCount(slug),
        categories: [],
        source: "store",
      });
    }
  } catch {
    /* Redis unavailable — on-disk corpora are enough for the picker */
  }

  return NextResponse.json({
    cities: [...onDisk.map((c) => ({ ...c, source: "committed" as const })), ...storeOnly],
  });
}
