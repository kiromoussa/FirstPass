import { NextRequest, NextResponse } from "next/server";
import { searchCodeIndex, retrieveCode, DEFAULT_CITY } from "@/lib/code-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hybrid code retrieval endpoint (docs/REDIS_PLAN.md §4). Given a rule key +
// jurisdiction + applicability, returns the single most relevant code chunk,
// preferring the RedisVL index (FT.SEARCH BM25 over body+context, filtered by
// city / category / applies_to) and falling back to the deterministic lexical
// scorer when the index isn't built. The `via` field tells the caller (and the
// Finding Inspector) which path served the result, so the demo can show the
// upgrade from lexical → RedisVL honestly.
//
// POST { ruleKey, appliesTo?, slug?, category? }

interface Body {
  ruleKey?: string;
  appliesTo?: string;
  slug?: string;
  category?: string;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const ruleKey = body.ruleKey?.trim();
  if (!ruleKey) {
    return NextResponse.json({ error: "ruleKey is required" }, { status: 400 });
  }
  const slug = body.slug?.trim() || DEFAULT_CITY;

  const indexed = await searchCodeIndex(ruleKey, body.appliesTo, slug, body.category);
  if (indexed) {
    return NextResponse.json({ via: "redisvl", chunk: indexed });
  }

  const lexical = await retrieveCode(ruleKey, body.appliesTo, slug, body.category);
  return NextResponse.json({ via: "lexical", chunk: lexical });
}
