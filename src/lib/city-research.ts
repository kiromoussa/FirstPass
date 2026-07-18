// Autonomous jurisdiction researcher: given a city that has no code corpus,
// find the OFFICIAL places its codes live (its .gov site and its code-hosting
// platform — eCode360, Municode, American Legal, Code Publishing, Qcode…),
// fetch the zoning/ADU/building provisions, chunk + persist them durably, and
// derive that city's numeric compliance rules — all through APIs, no human in
// the loop. This is what turns "Jurisdiction mismatch: plans are for El
// Segundo" from a dead end into a city that's ready to run a few minutes later.
//
// Discovery uses OpenAI's web_search tool (Responses API) because finding the
// right portal is a judgment call — cities scatter their codes across vendors
// and the official source matters for citations. Fetching prefers a plain
// HTTPS GET (most code hosts server-render); Browserbase (headless Chrome over
// CDP) is the fallback for SPA-only portals. Everything persists through the
// same durable store committed corpora use, so a researched city behaves
// exactly like a hand-ingested one.
import { chunkDocuments, type IngestDoc } from "./city-store";
import { persistChunks, loadCityChunks, storedChunkCount, type CityMeta } from "./code-db";
import { kvGet, kvSet } from "./store";
import { llmExtractJson, PLAN_READER_LIVE } from "./integrations/llm";
import type { Rule } from "./types";

const RESEARCH_MODEL = process.env.OPENAI_RESEARCH_MODEL || "gpt-5-mini";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_SOURCES = 6;
const MAX_DOC_CHARS = 400_000; // per fetched document
const MIN_USEFUL_CHARS = 1_500; // below this a fetch is considered empty (SPA shell)

export const rulesKey = (slug: string) => `code:${slug}:rules`;
const lockKey = (slug: string) => `research:lock:${slug}`;
const LOCK_TTL_MS = 15 * 60 * 1000;

export function citySlugFor(city: string, state: string): string {
  return `${city} ${state}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface DiscoveredSource {
  url: string;
  title: string;
  kind: "zoning" | "adu" | "municipal_code" | "building" | "permits" | "state";
  why: string;
}

export interface ResearchResult {
  ok: boolean;
  slug: string;
  city: string;
  state: string;
  chunks: number;
  rules: number;
  sources: DiscoveredSource[];
  note?: string;
}

// ---------------------------------------------------------------------------
// 1. Discovery — web search for the official code sources.
// ---------------------------------------------------------------------------

// One Responses-API call with the web_search tool. Output is coerced to JSON by
// instruction (the web_search tool and strict structured outputs don't always
// compose), then parsed defensively.
export async function discoverCodeSources(
  city: string,
  state: string
): Promise<DiscoveredSource[]> {
  if (!process.env.OPENAI_API_KEY) return [];
  const prompt =
    `Find the OFFICIAL online sources for the municipal code of ${city}, ${state}, ` +
    "for a building-permit compliance tool. Search the web. Strongly prefer: " +
    "(1) the city's own .gov/.org code pages, (2) the city's code-hosting platform " +
    "(ecode360.com, library.municode.com, codelibrary.amlegal.com, codepublishing.com, qcode.us, " +
    "sterlingcodifiers.com) — the ZONING title (setbacks, height, lot coverage, FAR, off-street " +
    "parking, residential zones) and the ADU ordinance specifically, (3) the city's ADU/permit " +
    "requirements page, (4) California HCD ADU guidance if the city is in CA. " +
    "Reject blogs, law-firm pages, and aggregator SEO sites. Return STRICT JSON only, no prose: " +
    `{"sources":[{"url":"...","title":"...","kind":"zoning|adu|municipal_code|building|permits|state","why":"..."}]} ` +
    `with at most ${MAX_SOURCES} entries, best first. Direct deep links to the zoning/ADU chapters ` +
    "beat portal homepages.";
  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: RESEARCH_MODEL,
        tools: [{ type: "web_search" }],
        input: prompt,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) {
      console.error(`[city-research] discovery failed: HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 300)}`);
      return [];
    }
    const json = (await r.json()) as {
      output?: { type: string; content?: { type: string; text?: string }[] }[];
    };
    let text = "";
    for (const item of json.output ?? []) {
      if (item.type !== "message") continue;
      for (const c of item.content ?? []) {
        if (c.type === "output_text" && c.text) text += c.text;
      }
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return [];
    const parsed = JSON.parse(text.slice(start, end + 1)) as { sources?: DiscoveredSource[] };
    const kinds = new Set(["zoning", "adu", "municipal_code", "building", "permits", "state"]);
    return (parsed.sources ?? [])
      .filter((s) => s && typeof s.url === "string" && /^https?:\/\//i.test(s.url))
      .map((s) => ({
        url: s.url,
        title: typeof s.title === "string" ? s.title.slice(0, 200) : s.url,
        kind: kinds.has(s.kind) ? s.kind : "municipal_code",
        why: typeof s.why === "string" ? s.why.slice(0, 300) : "",
      }))
      .slice(0, MAX_SOURCES);
  } catch (e) {
    console.error("[city-research] discovery failed:", (e as Error)?.message ?? e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// 2. Fetch — pull readable text out of a code page.
// ---------------------------------------------------------------------------

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&sect;/gi, "§")
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

async function plainFetchText(url: string): Promise<string> {
  const r = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const ct = r.headers.get("content-type") ?? "";
  const body = await r.text();
  return /html/i.test(ct) || /^\s*</.test(body) ? htmlToText(body) : body;
}

// SPA fallback: render the page in Browserbase headless Chrome and read the
// DOM's innerText. Only used when the plain fetch came back as an app shell.
async function browserFetchText(url: string): Promise<string> {
  if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) return "";
  const res = await fetch("https://api.browserbase.com/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BB-API-Key": process.env.BROWSERBASE_API_KEY },
    body: JSON.stringify({ projectId: process.env.BROWSERBASE_PROJECT_ID }),
  });
  if (!res.ok) return "";
  const session = (await res.json()) as { connectUrl?: string };
  if (!session.connectUrl) return "";
  try {
    const mod = "playwright-core";
    const { chromium } = (await import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ mod
    )) as any;
    const browser = await chromium.connectOverCDP(session.connectUrl);
    try {
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      const text: string = await page.evaluate(() => document.body?.innerText ?? "");
      return text.trim();
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (e) {
    console.error("[city-research] browser fetch failed:", (e as Error)?.message ?? e);
    return "";
  }
}

export async function fetchSourceText(url: string): Promise<string> {
  let text = "";
  try {
    text = await plainFetchText(url);
  } catch (e) {
    console.error(`[city-research] fetch ${url} failed:`, (e as Error)?.message ?? e);
  }
  if (text.length < MIN_USEFUL_CHARS) {
    const rendered = await browserFetchText(url);
    if (rendered.length > text.length) text = rendered;
  }
  return text.slice(0, MAX_DOC_CHARS);
}

// ---------------------------------------------------------------------------
// 3. Rules — derive the city's numeric limits from the fetched provisions.
// ---------------------------------------------------------------------------

// Sanity bounds per rule key (unit'd): a derived threshold outside these is a
// misread or a hallucination and is dropped. Wide on purpose — they only catch
// nonsense (a 4000 ft height limit), not unusual-but-real ordinances.
const RULE_BOUNDS: Record<string, { min: number; max: number; unit: string }> = {
  maxSize: { min: 150, max: 5000, unit: "sqft" },
  height: { min: 8, max: 200, unit: "ft" },
  setbackFront: { min: 0, max: 100, unit: "ft" },
  setbackRear: { min: 0, max: 100, unit: "ft" },
  setbackSide: { min: 0, max: 100, unit: "ft" },
  lotCoverage: { min: 5, max: 100, unit: "pct" },
  far: { min: 0.1, max: 15, unit: "far" },
  parking: { min: 0, max: 10, unit: "spaces" },
};
const RULE_OPERATORS: Record<string, "<=" | ">="> = {
  maxSize: "<=",
  height: "<=",
  setbackFront: ">=",
  setbackRear: ">=",
  setbackSide: ">=",
  lotCoverage: "<=",
  far: "<=",
  parking: ">=",
};

export async function deriveCityRules(
  cityLabel: string,
  corpusText: string
): Promise<Rule[]> {
  if (!PLAN_READER_LIVE || corpusText.length < MIN_USEFUL_CHARS) return [];
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      rules: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            key: {
              type: "string",
              enum: Object.keys(RULE_BOUNDS),
            },
            appliesTo: {
              type: "string",
              enum: ["single_family", "multi_family", "detached_adu", "attached_adu", "any"],
            },
            threshold: { type: "number" },
            quote: { type: "string" },
            citation: { type: "string" },
          },
          required: ["key", "appliesTo", "threshold", "quote", "citation"],
        },
      },
    },
    required: ["rules"],
  };
  const text =
    `You are extracting NUMERIC development standards for ${cityLabel} from its municipal code text below. ` +
    "For each standard you can actually find, emit: key (maxSize sqft for ADUs; height ft; setbackFront/" +
    "setbackRear/setbackSide ft; lotCoverage percent; far ratio; parking required spaces), appliesTo " +
    "(single_family, multi_family, detached_adu, attached_adu, or any), threshold (the number), quote (the " +
    "EXACT sentence from the text stating it, verbatim), citation (the section identifier, e.g. 'ESMC " +
    "§15-4A-6'). Only emit standards LITERALLY stated in the text — never infer, never use knowledge from " +
    "outside the text. Emit one entry per (key, appliesTo) pair at most.\n\n--- CODE TEXT ---\n" +
    corpusText.slice(0, 180_000);
  try {
    const out = await llmExtractJson(text, schema, "deriveCityRules", 16000);
    if (!out) return [];
    const parsed = JSON.parse(out) as {
      rules?: { key: string; appliesTo: string; threshold: number; quote: string; citation: string }[];
    };
    const seen = new Set<string>();
    const rules: Rule[] = [];
    const hay = corpusText.replace(/\s+/g, " ");
    for (const r of parsed.rules ?? []) {
      const bounds = RULE_BOUNDS[r.key];
      if (!bounds || typeof r.threshold !== "number" || !Number.isFinite(r.threshold)) continue;
      if (r.threshold < bounds.min || r.threshold > bounds.max) continue;
      // Anti-hallucination cross-check: the threshold number must literally
      // appear in the fetched text (as integer, decimal, or comma'd form).
      const n = r.threshold;
      const forms = [
        String(n),
        n.toLocaleString("en-US"),
        Number.isInteger(n) ? `${n}.0` : "",
        Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100),
      ].filter(Boolean);
      if (!forms.some((f) => hay.includes(f))) continue;
      const dedupe = `${r.key}:${r.appliesTo}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      rules.push({
        key: r.key,
        label:
          r.key === "maxSize" ? "Maximum unit size"
          : r.key === "height" ? "Height limit"
          : r.key === "setbackFront" ? "Front setback"
          : r.key === "setbackRear" ? "Rear setback"
          : r.key === "setbackSide" ? "Side setback"
          : r.key === "lotCoverage" ? "Lot coverage"
          : r.key === "far" ? "Floor area ratio"
          : "Off-street parking",
        appliesTo: (r.appliesTo || "any") as Rule["appliesTo"],
        operator: RULE_OPERATORS[r.key],
        threshold: r.threshold,
        unit: bounds.unit as Rule["unit"],
        sourceId: "S1",
        description: `${(r.citation || "").slice(0, 120)} — ${(r.quote || "").slice(0, 300)}`.trim(),
      });
    }
    return rules;
  } catch (e) {
    console.error("[city-research] rule derivation failed:", (e as Error)?.message ?? e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// 4. Orchestration — the full research → ingest run.
// ---------------------------------------------------------------------------

// True when a corpus already exists for the slug (committed or store-backed).
export async function cityCorpusExists(slug: string): Promise<boolean> {
  if (loadCityChunks(slug)) return true;
  return (await storedChunkCount(slug)) > 0;
}

/**
 * Research a city end-to-end and make it runnable: discover official sources,
 * fetch their text, chunk + persist durably, derive numeric rules. Idempotent
 * and lock-guarded so concurrent triggers (project create + pipeline mismatch)
 * don't double-spend. Returns a summary either way.
 */
export async function researchAndIngestCity(opts: {
  city: string;
  state: string;
  force?: boolean;
  onNote?: (note: string) => void;
}): Promise<ResearchResult> {
  const city = opts.city.trim();
  const state = (opts.state || "CA").trim().toUpperCase().slice(0, 2);
  const slug = citySlugFor(city, state);
  const note = (s: string) => {
    console.log(`[city-research:${slug}] ${s}`);
    opts.onNote?.(s);
  };
  const fail = (why: string): ResearchResult => ({
    ok: false, slug, city, state, chunks: 0, rules: 0, sources: [], note: why,
  });

  if (!/^[a-z][a-z .'-]{1,40}$/i.test(city)) return fail("city name looks invalid");
  if (!process.env.OPENAI_API_KEY) return fail("OPENAI_API_KEY is not configured");

  if (!opts.force && (await cityCorpusExists(slug))) {
    return { ok: true, slug, city, state, chunks: await storedChunkCount(slug), rules: 0, sources: [], note: "corpus already exists" };
  }
  // In-flight lock: another invocation started recently — don't double-run.
  const lock = await kvGet<{ ts: number }>(lockKey(slug));
  if (!opts.force && lock && Date.now() - lock.ts < LOCK_TTL_MS) {
    return fail("research already in progress");
  }
  await kvSet(lockKey(slug), { ts: Date.now() });

  note(`Searching for ${city}, ${state}'s official code sources…`);
  const discovered = await discoverCodeSources(city, state);
  // Web search is nondeterministic: a re-run can surface a different (worse)
  // source mix. Union with anything a previous run already ingested so the
  // corpus only ever grows.
  const prior = await kvGet<CityMeta>(`code:${slug}:meta`);
  const seenUrls = new Set(discovered.map((s) => s.url));
  const sources: DiscoveredSource[] = [
    ...discovered,
    ...(prior?.sources ?? [])
      .filter((s) => s.url && !seenUrls.has(s.url))
      .map((s) => ({ url: s.url, title: s.title, kind: "municipal_code" as const, why: "previously ingested" })),
  ];
  if (sources.length === 0) return fail("no official sources found");
  note(`Found ${sources.length} sources: ${sources.map((s) => s.kind).join(", ")}`);

  const docs: IngestDoc[] = [];
  const rawSources: Record<string, string> = {};
  const metaSources: { id: string; url: string; title: string }[] = [];
  let si = 0;
  for (const s of sources.slice(0, MAX_SOURCES + 4)) {
    const text = await fetchSourceText(s.url);
    if (text.length < MIN_USEFUL_CHARS) {
      note(`Skipped ${s.url} (no readable text)`);
      continue;
    }
    si++;
    const id = `S${si}`;
    // Doc name drives category detection in the chunker: zoning/ADU/permit
    // pages are city law; state guidance is state law.
    const name = `${s.kind === "state" ? "state" : "city"}-${s.kind}-${si}.txt`;
    docs.push({ name, content: text });
    rawSources[name] = id;
    metaSources.push({ id, url: s.url, title: s.title });
    note(`Fetched ${s.title} (${Math.round(text.length / 1000)}k chars)`);
  }
  if (docs.length === 0) return fail("every discovered source came back unreadable");

  const meta: CityMeta = {
    slug,
    city,
    state,
    jurisdictionId: slug,
    sources: metaSources,
    rawSources,
  };
  const chunks = chunkDocuments(slug, docs, meta);
  if (chunks.length === 0) return fail("fetched text produced no code chunks");
  const persisted = await persistChunks(slug, chunks, meta);
  note(`Ingested ${persisted} code chunks`);

  // Rules from the zoning/ADU documents specifically (they carry the numbers).
  const ruleText = docs
    .filter((d) => /zoning|adu|municipal/.test(d.name))
    .map((d) => d.content)
    .join("\n\n")
    || docs.map((d) => d.content).join("\n\n");
  const rules = await deriveCityRules(`${city}, ${state}`, ruleText);
  if (rules.length) {
    await kvSet(rulesKey(slug), rules, 0);
    note(`Derived ${rules.length} numeric rules (each cross-checked against the source text)`);
  } else {
    note("No numeric rules could be derived — runs will use state-default rules with the fetched corpus for citations");
  }

  return { ok: true, slug, city, state, chunks: persisted, rules: rules.length, sources, note: "researched and ingested" };
}
