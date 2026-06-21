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
import { RULES } from "./fixtures";
import type { Rule } from "./types";

export const DEFAULT_CITY = "alameda-ca";

export interface CodeChunk {
  id: string;
  section: string;
  topics: string[]; // rule keys this chunk governs
  text: string; // the verbatim code text (what we cite/display)
  sourceId: string;
  category?: string; // code layer: green | plumbing | building | residential | county | state | city | ...

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

const REGISTRY_KEY = "code:cities";
const metaKey = (slug: string) => `code:${slug}:meta`;

// Idempotently writes a city's chunked corpus to Redis and returns the count.
export async function seedCodeChunks(
  slug: string = DEFAULT_CITY
): Promise<number> {
  const disk = loadCityChunks(slug);
  const existing = await kvGet<string[]>(indexKey(slug));
  // If there's no on-disk corpus but a durable Redis index already exists (a city
  // ingested at runtime — e.g. on serverless, where the filesystem is ephemeral),
  // trust Redis and never clobber it with the built-in fallback corpus.
  if (!disk && existing && existing.length) return existing.length;
  const corpus = disk ?? CODE_CHUNKS;
  if (existing && existing.length === corpus.length) return existing.length;
  for (const c of corpus) await kvSet(chunkKey(slug, c.id), c);
  await kvSet(indexKey(slug), corpus.map((c) => c.id));
  return corpus.length;
}

// Durably persist a chunked corpus to Redis (the same keys retrieveCode reads),
// store its meta, and register the slug. This is how a runtime ingest survives on
// serverless. Returns the chunk count.
export async function persistChunks(
  slug: string,
  chunks: CodeChunk[],
  meta?: CityMeta
): Promise<number> {
  for (const c of chunks) await kvSet(chunkKey(slug, c.id), c);
  await kvSet(indexKey(slug), chunks.map((c) => c.id));
  if (meta) await kvSet(metaKey(slug), meta);
  const registry = (await kvGet<string[]>(REGISTRY_KEY)) ?? [];
  if (!registry.includes(slug)) await kvSet(REGISTRY_KEY, [...registry, slug]);
  return chunks.length;
}

// Slugs of cities held in the durable store (registered via persistChunks).
export async function listStoredCities(): Promise<string[]> {
  return (await kvGet<string[]>(REGISTRY_KEY)) ?? [];
}

// Meta for a store-only city (no on-disk meta.json). Null if absent.
export async function loadStoredMeta(slug: string): Promise<CityMeta | null> {
  return (await kvGet<CityMeta>(metaKey(slug))) ?? null;
}

// Chunk count for a store-backed city, from its Redis index.
export async function storedChunkCount(slug: string): Promise<number> {
  const ids = await kvGet<string[]>(indexKey(slug));
  return ids?.length ?? 0;
}

// All chunks for a store-backed city, read from Redis. [] if none.
export async function loadStoredChunks(slug: string): Promise<CodeChunk[]> {
  const ids = await kvGet<string[]>(indexKey(slug));
  if (!ids?.length) return [];
  const out: CodeChunk[] = [];
  for (const id of ids) {
    const c = await kvGet<CodeChunk>(chunkKey(slug, id));
    if (c) out.push(c);
  }
  return out;
}

// Retrieve the single most relevant code chunk for a rule key (+ optional
// applicability hint, e.g. "detached_adu" vs "attached_adu") within a city.
// Reads from Redis when available, else the city's on-disk / built-in corpus.
export async function retrieveCode(
  ruleKey: string,
  appliesTo?: string,
  slug: string = DEFAULT_CITY,
  category?: string // optionally scope to one code layer (green/plumbing/…)
): Promise<CodeChunk | null> {
  const corpus = corpusFor(slug);
  const ids = (await kvGet<string[]>(indexKey(slug))) ?? corpus.map((c) => c.id);
  let chunks: CodeChunk[] = [];
  for (const id of ids) {
    const c =
      (await kvGet<CodeChunk>(chunkKey(slug, id))) ??
      corpus.find((x) => x.id === id);
    if (c) chunks.push(c);
  }
  if (category) chunks = chunks.filter((c) => c.category === category);
  // Topic-tagged chunks are the primary pool; if a real (untagged) scrape
  // tagged nothing, fall back to scoring the whole corpus so recall survives.
  const tagged = chunks.filter((c) => c.topics.includes(ruleKey));
  const pool = tagged.length ? tagged : chunks;
  const ranked = pool
    .map((c) => ({ c, s: scoreChunk(c, ruleKey, appliesTo) }))
    .filter((r) => r.s > 0)
    .sort(
      (a, b) =>
        b.s - a.s ||
        (a.c.tokensEst ?? a.c.text.length) - (b.c.tokensEst ?? b.c.text.length) ||
        a.c.id.localeCompare(b.c.id) // deterministic tie-break
    );
  return ranked.length ? ranked[0].c : tagged[0] ?? null;
}

// Lexical query terms per rule, used to rank candidate chunks (BM25-style term
// scoring — see docs/CHUNKING.md). Codes hinge on exact terms, so this matters
// far more than embedding similarity for picking the right provision.
const RULE_TERMS: Record<string, string[]> = {
  maxSize: ["floor area", "square feet", "square foot", "maximum", "exceed", "size"],
  unitSize: ["floor area", "conditioned space", "size"],
  height: ["height", "feet in height", "roof pitch", "stories", "story"],
  setbackSide: ["side setback", "side yard"],
  setbackRear: ["rear setback", "rear yard"],
  setbackFront: ["front setback", "front yard", "prevailing setback"],
  lotCoverage: ["lot coverage", "buildable area", "percent of the lot"],
  far: ["floor area ratio", "residential floor area", "floor area"],
  parking: ["parking", "off-street", "covered parking", "spaces per unit"],
  requiredDocs: ["site plan", "plot plan", "floor plan", "elevation", "title-24", "submittal", "checklist", "application"],
};

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

// Relevance of a chunk to a (ruleKey, applicability) query. Combines topic
// membership, lexical term hits, and a detached/attached preference.
function scoreChunk(c: CodeChunk, ruleKey: string, appliesTo?: string): number {
  const hay = indexText(c).toLowerCase();
  const terms = RULE_TERMS[ruleKey] ?? [ruleKey.toLowerCase()];
  let score = terms.reduce((s, t) => s + countOccurrences(hay, t), 0);
  if (c.topics.includes(ruleKey)) score += 5; // strong signal: tagged for this rule
  // Applicability: reward the matching chunk and penalize the wrong one
  // symmetrically, so an attached query can't be won by a detached chunk that
  // merely mentions "height" more often (and vice-versa).
  if (appliesTo === "attached_adu") score += c.topics.includes("attached") ? 4 : -4;
  else if (appliesTo === "detached_adu") score += c.topics.includes("attached") ? -4 : 1;
  return score;
}

export interface CityMeta {
  slug: string;
  city: string;
  state: string;
  jurisdictionId?: string;
  sources?: { id: string; url: string; title: string }[];
  rawSources?: Record<string, string>; // raw filename -> sourceId (untagged scrapes)
}

// Read a city's meta.json (identity + source citations). Null if not present.
export function loadCityMeta(slug: string): CityMeta | null {
  try {
    const file = path.join(process.cwd(), "data", "cities", slug, "meta.json");
    return JSON.parse(fs.readFileSync(file, "utf-8")) as CityMeta;
  } catch {
    return null;
  }
}

// A city's compliance rules (numeric thresholds + applicability + citations),
// committed to data/cities/<slug>/rules.json. This is what makes an LA plan get
// graded against LA limits and an Alameda plan against Alameda limits. Null when
// the city ships no rules file — callers then fall back to the built-in RULES.
export function loadCityRules(slug: string): Rule[] | null {
  try {
    const file = path.join(process.cwd(), "data", "cities", slug, "rules.json");
    const rules = JSON.parse(fs.readFileSync(file, "utf-8")) as Rule[];
    return Array.isArray(rules) && rules.length > 0 ? rules : null;
  } catch {
    return null;
  }
}

// The active rule set for a city: its committed rules if present, else the
// built-in (Alameda) rules. Always returns a usable set.
export function rulesFor(slug: string): Rule[] {
  return loadCityRules(slug) ?? RULES;
}

// "City, ST" display label for a city slug.
export function cityLabel(slug: string): string {
  const m = loadCityMeta(slug);
  return m ? [m.city, m.state].filter(Boolean).join(", ") : slug;
}

// Slugs of every researched city committed under data/cities.
export function listCities(): string[] {
  try {
    return fs
      .readdirSync(path.join(process.cwd(), "data", "cities"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export interface CitySummary {
  slug: string;
  label: string;
  city?: string;
  state?: string;
  chunks: number;
  categories: string[]; // code layers present (green/plumbing/building/…)
  source?: "committed" | "store"; // on-disk (committed) vs durable runtime store
}

// Summary of every researched city committed to the repo — for a city picker.
export function listCityCorpora(): CitySummary[] {
  return listCities().map((slug) => {
    const meta = loadCityMeta(slug);
    const chunks = loadCityChunks(slug) ?? [];
    const categories = [
      ...new Set(chunks.map((c) => c.category).filter((c): c is string => !!c)),
    ].sort();
    return {
      slug,
      label: cityLabel(slug),
      city: meta?.city,
      state: meta?.state,
      chunks: chunks.length,
      categories,
    };
  });
}

// Best-effort map an address string to an available city slug (matches the
// city name in meta.json), falling back to the default demo city.
export function resolveCitySlug(address?: string): string {
  if (!address) return DEFAULT_CITY;
  const a = address.toLowerCase();
  for (const slug of listCities()) {
    const m = loadCityMeta(slug);
    if (m?.city && a.includes(m.city.toLowerCase())) return slug;
  }
  return DEFAULT_CITY;
}
