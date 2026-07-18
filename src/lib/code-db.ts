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
import { kvGet, kvSet, redisCommand } from "./store";
import { RULES } from "./fixtures";
import type { Rule } from "./types";

// Name of the RedisVL hybrid-search index built by scripts/index_codes_redisvl.py.
const VL_INDEX = "firstpass:codes";

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

  // Large committed corpora (e.g. los-angeles-ca ~10k chunks) are read directly
  // from disk in retrieveCode() — mirroring every chunk into Redis on each run
  // is slow and brittle. Store only the index stub when over the threshold.
  const LARGE_CORPUS = 500;
  if (disk && disk.length > LARGE_CORPUS) {
    if (!existing || existing.length !== disk.length) {
      await kvSet(
        indexKey(slug),
        disk.map((c) => c.id)
      );
    }
    return disk.length;
  }

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
  // TTL 0 = no expiry: a runtime-ingested corpus is the only copy on
  // serverless, and letting it lapse on the default 6h TTL silently reverts
  // the city to the fallback rules.
  for (const c of chunks) await kvSet(chunkKey(slug, c.id), c, 0);
  await kvSet(indexKey(slug), chunks.map((c) => c.id), 0);
  if (meta) await kvSet(metaKey(slug), meta, 0);
  const registry = (await kvGet<string[]>(REGISTRY_KEY)) ?? [];
  if (!registry.includes(slug)) await kvSet(REGISTRY_KEY, [...registry, slug], 0);
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
  category?: string, // optionally scope to one code layer (green/plumbing/…)
  // When true, only ever return a chunk actually tagged for this topic — no
  // widening to the rest of the (possibly category-filtered) corpus. Callers
  // that try several categories in order (e.g. retrieveTopicChunk) need this:
  // otherwise the widen-fallback below makes the FIRST category tried always
  // return *something*, so the loop never reaches the category the topic
  // actually lives in (ventilation is centrally a Mechanical Code topic, but
  // a "building"-scoped call would otherwise always find a plausible-looking
  // Building Code chunk first and never even try "mechanical").
  requireTag = false
): Promise<CodeChunk | null> {
  // Prefer the committed on-disk corpus (scripts/chunk_codes.py output) in memory —
  // avoids 10k+ Redis round-trips for cities like los-angeles-ca (~10k chunks).
  const disk = loadCityChunks(slug);
  let chunks: CodeChunk[] = disk ?? CODE_CHUNKS;
  if (!disk) {
    const ids = await kvGet<string[]>(indexKey(slug));
    if (ids?.length) {
      chunks = [];
      for (const id of ids) {
        const c = await kvGet<CodeChunk>(chunkKey(slug, id));
        if (c) chunks.push(c);
      }
    }
  }
  if (category) chunks = chunks.filter((c) => c.category === category);

  const rank = (list: CodeChunk[]) =>
    list
      .map((c) => ({ c, s: scoreChunk(c, ruleKey, appliesTo) }))
      .filter((r) => r.s > 0)
      .sort(
        (a, b) =>
          b.s - a.s ||
          (a.c.tokensEst ?? a.c.text.length) - (b.c.tokensEst ?? b.c.text.length) ||
          a.c.id.localeCompare(b.c.id) // deterministic tie-break
      );

  // Topic-tagged chunks are the primary pool; if a real (untagged) scrape
  // tagged nothing, fall back to scoring the whole corpus so recall survives.
  const tagged = chunks.filter((c) => c.topics.includes(ruleKey));

  if (requireTag) {
    // Never fall through to scoring the (possibly category-filtered) whole
    // corpus — if this category has no chunk actually tagged for the topic,
    // that's a real "not here" signal the caller needs to advance to the
    // next category, not a same-category chunk that merely uses a couple of
    // the topic's words in passing.
    const ranked = rank(tagged);
    return ranked.length ? ranked[0].c : null;
  }

  // Rank the WHOLE corpus, not just the tagged pool. Auto-tagging on scraped
  // corpora is noisy both ways: the correct provision is often untagged while
  // an unrelated section carries the tag (LA: the only setbackFront-tagged
  // chunk is a no-parking-on-lawns ordinance, while the real §12.08 R1 yard
  // standards are untagged). The +5 tag bonus in scoreChunk still breaks ties
  // toward tagged chunks when they are genuinely relevant; the negative-term
  // penalties push wrong-context tagged chunks below legitimate untagged ones.
  // Never return an unscored guess — null means "verify manually, no
  // citation," which is honest.
  const ranked = rank(chunks);
  return ranked.length ? ranked[0].c : null;
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
  setbackFront: ["front setback", "front yard", "prevailing setback", "depth of the lot"],
  lotCoverage: ["lot coverage", "buildable area", "percent of the lot"],
  far: ["floor area ratio", "residential floor area", "floor area"],
  // Phrase-level terms only: the generic word "parking" matches hundreds of
  // traffic/valet/meter provisions, but only a development standard says how
  // many spaces must be PROVIDED per dwelling.
  parking: [
    "off-street parking space",
    "off street parking",
    "parking spaces shall be provided",
    "automobile parking space",
    "spaces per dwelling",
    "covered parking",
    "parking space is required",
    "parking spaces are required",
    "parking spaces per",
  ],
  requiredDocs: ["site plan", "plot plan", "floor plan", "elevation", "title-24", "submittal", "checklist", "application"],
  // Topics tagged by scripts/chunk_codes.py (broader code layers)
  waterEfficiency: ["water closet", "gallons per", "gpf", "gpm", "water conserving", "flow rate", "lavatory"],
  smokeAlarm: ["smoke alarm", "carbon monoxide"],
  egress: ["egress", "emergency escape", "exit discharge", "means of egress"],
  fireProtection: ["sprinkler", "fire-resistance", "fire resistance", "fire separation"],
  ventilation: ["ventilation", "mechanical ventilation", "exhaust"],
  evCharging: ["electric vehicle", "ev charging", "ev capable", "ev ready"],
  solar: ["photovoltaic", "solar"],
  occupancy: ["occupancy", "occupant load", "occupant-load"],
  foundation: ["foundation", "footing", "slab"],
  // Title 24 Part 6 (California Energy Code) — envelope, fenestration, HVAC,
  // water heating, plus the CF1R compliance path. Matches the ~3,858
  // category:"energy" chunks ingested from the CEC Restructured 2025 Energy Code.
  energyTitle24: [
    "low-rise residential",
    "single-family",
    "dwelling unit",
    "section 150.1",
    "section 150.0",
    "fenestration",
    "mandatory measures",
    "prescriptive",
    "water heating",
    "insulation",
  ],
};

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

// Disqualifying contexts per rule key. Large scraped corpora auto-tag chunks
// whose text merely SHARES WORDS with a topic — LA's only "setbackFront"-tagged
// chunk is §80.71.3 "PARKING IN FRONT YARDS" (a no-parking-on-lawns traffic
// ordinance), "far" tags §19.11 (an inspection-fee section), and "parking" tags
// §88.00 "PARKING METER ZONES AND RATES". A compliance citation must be the
// development standard itself, so chunks matching these contexts are pushed
// firmly below every legitimate candidate.
const RULE_NEGATIVE_TERMS: Record<string, { title: string[]; body: string[] }> = {
  setbackFront: { title: ["parking"], body: ["park any vehicle", "parking meter"] },
  setbackSide: { title: ["parking"], body: ["park any vehicle", "parking meter"] },
  setbackRear: { title: ["parking"], body: ["park any vehicle", "parking meter"] },
  far: { title: ["annual inspection", "fee"], body: ["fee shall be charged", "fee shall be collected"] },
  maxSize: { title: ["annual inspection", "fee"], body: ["fee shall be charged"] },
  parking: {
    title: ["parking meter", "meter zone", "loading zone", "lp-gas", "parking notice", "unauthorized", "stopping", "failure", "signs", "citation"],
    body: ["parking meter", "hourly rates", "tank vehicle", "impound"],
  },
  lotCoverage: { title: ["parking"], body: ["park any vehicle", "parking meter"] },
  height: { title: ["fee"], body: [] },
};

// Zoning development standards live in the municipal code ("city" layer). A
// fire-code extinguisher table or a CEQA guideline can out-count a zoning
// section on generic terms ("square feet", "maximum") — steer these keys to
// the layer that actually governs them unless a caller scoped the category.
const ZONING_KEYS = new Set([
  "maxSize",
  "unitSize",
  "height",
  "setbackFront",
  "setbackRear",
  "setbackSide",
  "lotCoverage",
  "far",
  "parking",
]);

// Relevance of a chunk to a (ruleKey, applicability) query. Combines topic
// membership, lexical term hits (section titles weighted above body text, and
// per-term body counts CAPPED so a 400KB catch-all section can't outscore the
// short provision that actually governs), disqualifying-context penalties, a
// mega-chunk length penalty, and a detached/attached preference.
function scoreChunk(c: CodeChunk, ruleKey: string, appliesTo?: string): number {
  const hay = indexText(c).toLowerCase();
  const title = (c.section ?? "").toLowerCase();
  const terms = RULE_TERMS[ruleKey] ?? [ruleKey.toLowerCase()];
  let score = terms.reduce(
    // A term in the section TITLE is a far stronger signal than one buried in
    // the body — "§12.08 R1 One-Family Zone" beats a section that merely
    // mentions "front yard" once in passing. Body counts cap at 3 per term so
    // sheer chunk size is not a relevance signal.
    (s, t) =>
      s +
      Math.min(countOccurrences(hay, t), 3) +
      Math.min(countOccurrences(title, t), 2) * 3,
    0
  );
  if (c.topics.includes(ruleKey)) score += 5; // strong signal: tagged for this rule
  // Mega-chunk penalty: a 458KB "EXCEPTIONS" blob mentions every zoning term
  // somewhere. It is a terrible citation (unreadable, unquotable) even when it
  // technically contains the standard — prefer the focused section.
  score -= Math.min(10, Math.floor(hay.length / 40_000));
  // Layer preference: a zoning metric cited from the fire/electrical/CEQA
  // layers is a wrong-context citation even when the terms match.
  if (ZONING_KEYS.has(ruleKey) && c.category && c.category !== "city") score -= 5;
  // Municipal-code chapter preference: LAMC-style numbering puts zoning in
  // chapter 1 (§12.x, §13.x); §5x is public safety, §8x traffic, §9x building,
  // §10x business regulation. A zoning standard cited from those chapters is
  // wrong even when the words match ("§89.40 PARKING IN PARKING AREA").
  if (ZONING_KEYS.has(ruleKey) && /§\s?(5\d|8\d|9\d|10\d)\./.test(c.section ?? "")) score -= 8;
  // Zone-title alignment: when checking a single-family project, the section
  // titled for the one-family zone IS the governing standard — prefer it over
  // other residential zones (mobilehome parks, zero-side-yard) that share the
  // same yard vocabulary.
  if (ZONING_KEYS.has(ruleKey)) {
    if (appliesTo === "single_family" && /one[- ]family/.test(title)) score += 6;
    if (appliesTo === "multi_family" && /(multiple dwelling|“?r3|“?r4)/.test(title)) score += 6;
    if (/mobilehome/.test(title)) score -= 6;
  }
  // Disqualify wrong-context chunks (traffic/fee/meter provisions) — the
  // penalty outweighs both the tag bonus and typical term counts.
  const negatives = RULE_NEGATIVE_TERMS[ruleKey];
  if (negatives) {
    for (const t of negatives.title) if (title.includes(t)) score -= 12;
    for (const t of negatives.body) score -= Math.min(countOccurrences(hay, t), 3) * 3;
  }
  // Applicability: reward the matching chunk and penalize the wrong one
  // symmetrically, so an attached query can't be won by a detached chunk that
  // merely mentions "height" more often (and vice-versa).
  if (appliesTo === "attached_adu") score += c.topics.includes("attached") ? 4 : -4;
  else if (appliesTo === "detached_adu") score += c.topics.includes("attached") ? -4 : 1;
  return score;
}

// RediSearch TAG values treat -, ., space, etc. as separators, so a slug like
// "los-angeles-ca" must be escaped to match as one token.
function escapeTag(v: string): string {
  return v.replace(/[-.\s:|{}()[\]"~*?\\/@$<>=]/g, "\\$&");
}

// Parse one FT.SEARCH ...WITHSCORES hit's flat [field, value, …] array into a
// CodeChunk. ioredis returns nested arrays of strings.
function chunkFromFields(fields: string[]): CodeChunk | null {
  const m: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) m[fields[i]] = fields[i + 1];
  if (!m.chunk_id) return null;
  const topics = (m.topics ?? "").split("|").filter((t) => t && t !== "none");
  return {
    id: m.chunk_id,
    section: m.section ?? "",
    topics,
    text: m.text ?? "",
    sourceId: m.source_id ?? "",
    category: m.category,
    citation: m.section,
  };
}

// Query the RedisVL index (firstpass:codes) via FT.SEARCH: full-text BM25 over
// the chunk body + context, narrowed by city / code-layer / applicability TAG
// filters. This is the "hybrid" retrieval the demo leans on — crucially the
// applies_to filter is what flips the attached/detached height check. Returns
// null when the index is absent or the Search module isn't installed (redisCommand
// swallows the error), so callers fall back to lexical retrieval.
export async function searchCodeIndex(
  ruleKey: string,
  appliesTo?: string,
  slug: string = DEFAULT_CITY,
  category?: string
): Promise<CodeChunk | null> {
  const filters = [`@city:{${escapeTag(slug)}}`];
  if (category) filters.push(`@category:{${escapeTag(category)}}`);
  if (appliesTo === "attached_adu") filters.push(`@applies_to:{attached_adu}`);
  else if (appliesTo === "detached_adu") filters.push(`@applies_to:{detached_adu}`);

  const terms = (RULE_TERMS[ruleKey] ?? [ruleKey.toLowerCase()]).map((t) =>
    t.includes(" ") ? `"${t}"` : t
  );
  const query = `${filters.join(" ")} @text:(${terms.join("|")})`;

  const res = (await redisCommand(
    "FT.SEARCH", VL_INDEX, query,
    "SCORER", "BM25", "WITHSCORES",
    "LIMIT", "0", "1",
    "RETURN", "6", "chunk_id", "section", "text", "source_id", "category", "topics",
    "DIALECT", "2"
  )) as unknown[] | null;

  // Shape with WITHSCORES: [total, docId, score, [f,v,…], …]. total === 0 → miss.
  if (!Array.isArray(res) || typeof res[0] !== "number" || res[0] === 0) return null;
  const fields = res[3];
  if (!Array.isArray(fields)) return null;
  return chunkFromFields(fields.map(String));
}

// Preferred retrieval: the deterministic lexical scorer over the committed
// corpus. It is reproducible, needs no Search module, and on this corpus style
// matches the index's results — so the RedisVL hybrid index is OPT-IN
// (FIRSTPASS_REDISVL=1 + scripts/index_codes_redisvl.py) for when a corpus
// outgrows lexical scoring, with lexical still the fallback on index misses.
export async function retrieveCodeHybrid(
  ruleKey: string,
  appliesTo?: string,
  slug: string = DEFAULT_CITY,
  category?: string,
  requireTag = false
): Promise<CodeChunk | null> {
  if (process.env.FIRSTPASS_REDISVL === "1" && !requireTag) {
    const viaIndex = await searchCodeIndex(ruleKey, appliesTo, slug, category);
    if (viaIndex) return viaIndex;
  }
  return retrieveCode(ruleKey, appliesTo, slug, category, requireTag);
}

const RULE_CATEGORY_ORDER: Record<string, string[]> = {
  maxSize: ["city", "state"],
  height: ["city", "state"],
  setbackSide: ["city", "state"],
  setbackRear: ["city", "state"],
  requiredDocs: ["city", "state"],
};

function chunkMatchesRule(chunk: CodeChunk, ruleKey: string): boolean {
  const terms = RULE_TERMS[ruleKey] ?? [ruleKey.toLowerCase()];
  const hay = indexText(chunk).toLowerCase();
  return terms.some((t) => hay.includes(t.toLowerCase()));
}

/** Retrieve the best-matching chunk for a compliance rule, trying code layers in order. */
export async function retrieveCodeForRule(
  ruleKey: string,
  appliesTo: string | undefined,
  slug: string = DEFAULT_CITY
): Promise<CodeChunk | null> {
  const layers = RULE_CATEGORY_ORDER[ruleKey] ?? [];
  for (const cat of layers) {
    const chunk = await retrieveCodeHybrid(ruleKey, appliesTo, slug, cat);
    if (chunk && chunkMatchesRule(chunk, ruleKey)) return chunk;
  }
  const fallback = await retrieveCodeHybrid(ruleKey, appliesTo, slug);
  if (fallback && chunkMatchesRule(fallback, ruleKey)) return fallback;
  return fallback ?? (await retrieveCode(ruleKey, appliesTo, slug));
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

// Async variant that also checks the durable store — a city researched at
// runtime (city-research.ts) persists its derived rules to Redis under
// code:<slug>:rules, which the sync disk-only loader can't see.
export async function rulesForAsync(slug: string): Promise<Rule[]> {
  const disk = loadCityRules(slug);
  if (disk) return disk;
  const stored = await kvGet<Rule[]>(`code:${slug}:rules`);
  if (Array.isArray(stored) && stored.length > 0) return stored;
  return RULES;
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
// Intentionally lightweight: never parse chunks.json here (LA alone is ~10MB).
export function listCityCorpora(): CitySummary[] {
  return listCities().map((slug) => {
    const meta = loadCityMeta(slug);
    const chunksFile = path.join(process.cwd(), "data", "cities", slug, "chunks.json");
    const hasCorpus = fs.existsSync(chunksFile);
    return {
      slug,
      label: cityLabel(slug),
      city: meta?.city,
      state: meta?.state,
      chunks: hasCorpus ? 1 : 0,
      categories: [],
    };
  });
}

// Best-effort map an address string to an available city slug (matches the
// city name against the address), falling back to the default demo city.
// Checks committed on-disk cities first, then the durable store — on serverless
// the filesystem is ephemeral, so a runtime-ingested city (e.g. Los Angeles)
// only exists in Redis and would otherwise never match.
export async function resolveCitySlug(address?: string): Promise<string> {
  if (!address) return DEFAULT_CITY;
  const a = address.toLowerCase();
  for (const slug of listCities()) {
    const m = loadCityMeta(slug);
    if (m?.city && a.includes(m.city.toLowerCase())) return slug;
  }
  for (const slug of await listStoredCities()) {
    const m = await loadStoredMeta(slug);
    if (m?.city && a.includes(m.city.toLowerCase())) return slug;
  }
  return DEFAULT_CITY;
}
