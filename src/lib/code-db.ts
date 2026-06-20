// Chunked building-code database with Redis-backed retrieval (PLAN.md addendum:
// token-efficient code RAG). Building-code text is chunked and tagged by topic;
// each compliance check retrieves ONLY its relevant chunk to cite, instead of
// stuffing the whole code into the prompt. Falls back to in-process retrieval
// when Redis is absent. No embedding provider needed — retrieval is tag + term
// scored, which is deterministic and reproducible for the demo.
//
// Corpus source: a city's chunks are produced once by scripts/chunk_codes.py
// from its researched raw code and committed to data/cities/<slug>/chunks.json.
// At request time we load that pre-built file from disk (instant + token-cheap),
// so any already-researched city works straight from the codebase. The built-in
// CODE_CHUNKS below remain the fallback when a city has no committed corpus.
import fs from "node:fs";
import path from "node:path";
import { kvGet, kvSet } from "./store";

export const DEFAULT_CITY = "alameda-ca";

export interface CodeChunk {
  id: string;
  section: string;
  topics: string[]; // rule keys this chunk governs
  text: string; // the verbatim code text (what we cite/display)
  sourceId: string;
  // --- contextual-retrieval metadata (see docs/CHUNKING.md) ---
  // A short situating header ("Alameda, CA · Municipal code · §30-5.21(b) Unit
  // Size") prepended to the text when indexing/embedding so a chunk retrieves
  // even when the query terms aren't in the body. Display still uses `text`.
  context?: string;
  citation?: string; // the section/code identifier for the report citation
  tokensEst?: number; // rough token estimate (chars/4) for budgeting
}

// Text to index/embed for a chunk: its context header + body (Anthropic
// "contextual retrieval"). Display/citation still uses chunk.text alone.
export function indexText(c: CodeChunk): string {
  return c.context ? `${c.context}\n${c.text}` : c.text;
}

// The corpus, pre-chunked. In production this is ingested from the official
// code; here it is the Alameda/CA ADU provisions split into retrievable units.
export const CODE_CHUNKS: CodeChunk[] = [
  {
    id: "c-size",
    section: "AMC §30-5.21(b) — Unit Size",
    topics: ["maxSize", "unitSize"],
    text: "The maximum floor area of a detached accessory dwelling unit shall not exceed 1,200 square feet of conditioned space.",
    sourceId: "S1",
  },
  {
    id: "c-height-detached",
    section: "CA Gov. Code §65852.2 / HCD — Height (Detached)",
    topics: ["height"],
    text: "A detached accessory dwelling unit may be up to 18 feet in height; an additional two feet is permitted to align roof pitches with the primary dwelling.",
    sourceId: "S2",
  },
  {
    id: "c-height-attached",
    section: "CA HCD — Height (Attached)",
    topics: ["height", "attached"],
    text: "An attached accessory dwelling unit is limited to 16 feet in height where it must match the height of the primary dwelling.",
    sourceId: "S2",
  },
  {
    id: "c-setback-side",
    section: "AMC §30-5.21(c) — Side Setback",
    topics: ["setbackSide"],
    text: "A minimum side setback of 4 feet shall be provided for an accessory dwelling unit.",
    sourceId: "S3",
  },
  {
    id: "c-setback-rear",
    section: "AMC §30-5.21(c) — Rear Setback",
    topics: ["setbackRear"],
    text: "A minimum rear setback of 4 feet shall be provided for an accessory dwelling unit.",
    sourceId: "S3",
  },
  {
    id: "c-docs",
    section: "Alameda P&B — Submittal Checklist",
    topics: ["requiredDocs"],
    text: "A complete ADU submittal must include a site plan, floor plan, building elevations, and a Title-24 energy compliance report.",
    sourceId: "S4",
  },
];

const indexKey = (slug: string) => `code:${slug}:index`;
const chunkKey = (slug: string, id: string) => `code:${slug}:chunk:${id}`;

// Load a city's pre-built, committed chunks from disk (produced by
// scripts/chunk_codes.py). Returns null when the city hasn't been researched
// yet — callers then fall back to the built-in CODE_CHUNKS.
export function loadCityChunks(slug: string): CodeChunk[] | null {
  try {
    const file = path.join(process.cwd(), "data", "cities", slug, "chunks.json");
    const chunks = JSON.parse(fs.readFileSync(file, "utf-8")) as CodeChunk[];
    return Array.isArray(chunks) && chunks.length > 0 ? chunks : null;
  } catch {
    return null;
  }
}

// The active corpus for a city: its committed chunks if researched, else the
// built-in demo corpus.
function corpusFor(slug: string): CodeChunk[] {
  return loadCityChunks(slug) ?? CODE_CHUNKS;
}

// Idempotently writes a city's chunked corpus to Redis and returns the count.
export async function seedCodeChunks(
  slug: string = DEFAULT_CITY
): Promise<number> {
  const corpus = corpusFor(slug);
  const existing = await kvGet<string[]>(indexKey(slug));
  if (existing && existing.length === corpus.length) return existing.length;
  for (const c of corpus) await kvSet(chunkKey(slug, c.id), c);
  await kvSet(indexKey(slug), corpus.map((c) => c.id));
  return corpus.length;
}

// Retrieve the single most relevant code chunk for a rule key (+ optional
// applicability hint, e.g. "detached_adu" vs "attached_adu") within a city.
// Reads from Redis when available, else the city's on-disk / built-in corpus.
export async function retrieveCode(
  ruleKey: string,
  appliesTo?: string,
  slug: string = DEFAULT_CITY
): Promise<CodeChunk | null> {
  const corpus = corpusFor(slug);
  const ids = (await kvGet<string[]>(indexKey(slug))) ?? corpus.map((c) => c.id);
  const chunks: CodeChunk[] = [];
  for (const id of ids) {
    const c =
      (await kvGet<CodeChunk>(chunkKey(slug, id))) ??
      corpus.find((x) => x.id === id);
    if (c) chunks.push(c);
  }
  const candidates = chunks.filter((c) => c.topics.includes(ruleKey));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  // Disambiguate by applicability (e.g. detached vs attached height chunk).
  if (appliesTo === "attached_adu") return candidates.find((c) => c.topics.includes("attached")) ?? candidates[0];
  return candidates.find((c) => !c.topics.includes("attached")) ?? candidates[0];
}
