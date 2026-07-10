// Plan-reader LLM adapter (PLAN.md §5). Live with OPENAI_API_KEY, else returns
// deterministic cached results so the pipeline always completes. (Requests are
// authored as small content-block objects — text/image/document — a shape
// that maps directly onto OpenAI's multimodal chat-completions parts.)
import { CACHED_FACTS } from "../fixtures";
import {
  gridToRegion,
  sanitizeExtractedFact,
  type FactRegion,
  type TileGrid,
} from "../fact-sanitize";
import { mergePlanFactSets, needsVisionPass } from "../fact-merge";
import type { PlanFact, Unit } from "../types";

export const PLAN_READER_LIVE = !!process.env.OPENAI_API_KEY;
const NOT_CONFIGURED = "the plan reader is not configured (no OPENAI_API_KEY)";

// Cheapest capable model — no escalation (cost control for agent workloads).
const MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
// Reasoning models (gpt-5*/o*) spend completion budget on reasoning tokens and
// reject legacy params — gate the reasoning-specific request shape on this.
const REASONING = /^(gpt-5|o\d)/.test(MODEL);

// Per-call timeout. Must stay well under the run route's maxDuration (300s) so a
// single slow call can't starve the rest of the pipeline. Override via env.
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 90_000;

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { media_type: string; data: string } }
  | { type: "document"; source: { media_type: string; data: string } };

type ExtractResult = { text: string; error: null } | { text: null; error: string };

type OpenAiPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

// Convert our content blocks to OpenAI chat parts. PDFs become file parts
// (base64 data URI), images become image_url data URIs.
function toOpenAiContent(content: ContentBlock[] | string): string | OpenAiPart[] {
  if (typeof content === "string") return content;
  let fileN = 0;
  return content.map((b): OpenAiPart => {
    if (b.type === "text") return { type: "text", text: b.text };
    if (b.type === "image") {
      return { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
    }
    fileN++;
    return {
      type: "file",
      file: { filename: `sheet-${fileN}.pdf`, file_data: `data:application/pdf;base64,${b.source.data}` },
    };
  });
}

// One OpenAI chat-completions call. Every failure mode is LOGGED rather than
// silently swallowed, so "couldn't read" can be told apart from "API rejected
// the request" / "ran out of tokens" / "refused" — the caller surfaces the
// distinction in the UI instead of a blanket "couldn't read".
async function generateText(
  content: ContentBlock[] | string,
  label: string,
  maxTokens: number,
  schema?: object
): Promise<ExtractResult> {
  if (!PLAN_READER_LIVE) return { text: null, error: NOT_CONFIGURED };
  // Floor the budget on reasoning models so small callers don't starve the
  // answer after reasoning tokens are spent.
  const budget = REASONING ? Math.max(maxTokens, 4000) : maxTokens;
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: [{ role: "user", content: toOpenAiContent(content) }],
    max_completion_tokens: budget,
  };
  if (REASONING) body.reasoning_effort = "low";
  if (schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "extraction", strict: true, schema },
    };
  }
  // Bound every call: raw fetch has NO default timeout, so a slow/stuck OpenAI
  // request would hang until the serverless function is killed at maxDuration
  // (300s), leaving the run stuck with no persisted state. On timeout we abort
  // and return the graceful "service call failed" error, so the pipeline
  // continues (the finding becomes NEEDS_REVIEW) instead of dying.
  const call = () =>
    fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });

  try {
    let r = await call();
    if (!r.ok && r.status === 400 && schema) {
      // Strict structured outputs reject some JSON-Schema keywords — retry once
      // non-strict (the sanitizer still validates every field downstream).
      const errText = await r.text();
      if (/schema|unsupported/i.test(errText)) {
        console.error(`[llm:${label}:${MODEL}] strict schema rejected — retrying non-strict: ${errText.slice(0, 200)}`);
        (body.response_format as { json_schema: { strict: boolean } }).json_schema.strict = false;
        r = await call();
      } else {
        console.error(`[llm:${label}:${MODEL}] API call failed: ${errText.slice(0, 300)}`);
        return { text: null, error: "the plan reader service call failed" };
      }
    }
    if (!r.ok) {
      console.error(`[llm:${label}:${MODEL}] API call failed: HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 300)}`);
      return { text: null, error: "the plan reader service call failed" };
    }
    const json = (await r.json()) as {
      choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
    };
    const choice = json.choices?.[0];
    if (choice?.message?.refusal) {
      console.error(`[llm:${label}:${MODEL}] request refused — ${choice.message.refusal.slice(0, 200)}`);
      return { text: null, error: "the plan reader declined to process this document" };
    }
    if (choice?.finish_reason === "length") {
      console.error(`[llm:${label}:${MODEL}] hit the completion budget (${budget}) before finishing — output truncated.`);
      return { text: null, error: "the plan reader ran out of token budget before finishing (the plan set may be too large or too dense)" };
    }
    const text = choice?.message?.content;
    if (typeof text !== "string" || !text) {
      console.error(`[llm:${label}:${MODEL}] no content in response (finish_reason=${choice?.finish_reason}).`);
      return { text: null, error: "the plan reader returned no readable result" };
    }
    return { text, error: null };
  } catch (e) {
    console.error(`[llm:${label}:${MODEL}] API call failed:`, (e as Error)?.message ?? e);
    return { text: null, error: "the plan reader service call failed" };
  }
}

// Structured-output extraction — same transport as generateText, schema required.
async function extractJson(
  content: ContentBlock[],
  schema: object,
  label: string,
  maxTokens = 16000
): Promise<ExtractResult> {
  return generateText(content, label, maxTokens, schema);
}

// Structured extraction of plan facts from blueprint page images.
// `pageImages` are base64 PNGs (without data: prefix). Empty → cached facts.
export async function extractPlanFacts(
  pageImages: string[]
): Promise<PlanFact[]> {
  if (!PLAN_READER_LIVE || pageImages.length === 0) return CACHED_FACTS;

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      facts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            key: { type: "string" },
            label: { type: "string" },
            value: { type: "string" },
            unit: { type: "string", enum: ["ft", "sqft", "docs"] },
            sheet: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["key", "label", "value", "unit", "sheet", "confidence"],
        },
      },
    },
    required: ["facts"],
  };

  try {
    const content: ContentBlock[] = [
      {
        type: "text",
        text:
          "You are a residential plan reader. " +
          RESIDENTIAL_METRICS_HINT +
          " Also return the list of sheets present under key 'sheets'.",
      },
      ...pageImages.map((data): ContentBlock => ({ type: "image", source: { media_type: "image/png", data } })),
    ];
    const { text } = await generateText(content, "extractPlanFacts", 4000, schema);
    if (text == null) return CACHED_FACTS;
    const parsed = JSON.parse(text) as { facts: any[] };
    // Merge model output over cached facts (keeps bbox/raw for overlay).
    return CACHED_FACTS.map((cf) => {
      const m = parsed.facts.find((f) => f.key === cf.key);
      if (!m) return cf;
      const num = Number(m.value);
      return {
        ...cf,
        value: Number.isFinite(num) && cf.key !== "sheets" ? num : cf.value,
        confidence: typeof m.confidence === "number" ? m.confidence : cf.confidence,
      };
    });
  } catch (e) {
    console.error("[llm:extractPlanFacts] failed, using cached reference facts:", (e as Error)?.message ?? e);
    return CACHED_FACTS;
  }
}

// Interpret raw text/property strings extracted from a translated DWG into the
// typed plan facts the compliance engine expects. Falls back to cached facts
// when the plan reader is unavailable or the extraction is too sparse to be reliable.
export async function interpretDwgText(lines: string[]): Promise<PlanFact[]> {
  if (!PLAN_READER_LIVE || lines.length === 0) return CACHED_FACTS;

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      facts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            key: { type: "string", enum: EXTRACT_KEYS },
            value: { type: "number" },
            unit: { type: "string", enum: EXTRACT_UNITS },
            confidence: { type: "number" },
            raw: { type: "string" },
          },
          required: ["key", "value", "unit", "confidence", "raw"],
        },
      },
    },
    required: ["facts"],
  };

  try {
    const { text } = await generateText(
      "These are text labels and properties extracted from an AutoCAD residential drawing. " +
        RESIDENTIAL_METRICS_HINT +
        " Lines:\n" +
        lines.join("\n").slice(0, 8000),
      "interpretDwgText",
      2000,
      schema
    );
    if (text == null) return CACHED_FACTS;
    const parsed = JSON.parse(text) as { facts: any[] };
    if (!parsed.facts?.length) return CACHED_FACTS;
    // Overlay extracted numeric facts onto the cached facts (keeps bbox/sheet
    // for the overlay; cached fact stands in where extraction found nothing).
    return CACHED_FACTS.map((cf) => {
      const m = parsed.facts.find((f) => f.key === cf.key);
      if (!m || typeof m.value !== "number") return cf;
      return { ...cf, value: m.value, confidence: m.confidence ?? cf.confidence, raw: m.raw ?? cf.raw };
    });
  } catch (e) {
    console.error("[llm:interpretDwgText] failed, using cached reference facts:", (e as Error)?.message ?? e);
    return CACHED_FACTS;
  }
}

// Read a plan set DIRECTLY with vision — a PDF or an image. This is the
// accurate fact source for a real upload: it returns the numeric facts plus
// the sheet index, with HONEST confidence. Keys it cannot read get value=null
// / confidence=0, so the deterministic engine marks them NEEDS_REVIEW rather
// than inventing numbers.
const NUMERIC_KEYS = [
  { key: "unitSize", label: "Conditioned floor area", unit: "sqft" as const },
  { key: "height", label: "Building height", unit: "ft" as const },
  { key: "setbackFront", label: "Front setback", unit: "ft" as const },
  { key: "setbackRear", label: "Rear setback", unit: "ft" as const },
  { key: "setbackSide", label: "Side setback", unit: "ft" as const },
  { key: "lotCoverage", label: "Lot coverage", unit: "pct" as const },
  { key: "far", label: "Floor area ratio", unit: "far" as const },
  { key: "parking", label: "Parking spaces", unit: "spaces" as const },
  { key: "dwellingUnits", label: "Dwelling units", unit: "units" as const },
];

// Single source of truth for the extraction schemas below: every metric key
// the model may read off a plan set, and every unit those metrics use. Keys it
// cannot read come back null (the engine marks them NEEDS_REVIEW, never guesses).
const EXTRACT_KEYS = NUMERIC_KEYS.map((k) => k.key);
const EXTRACT_UNITS = ["ft", "sqft", "pct", "far", "spaces", "units"];

// Shared fact-item schema for every extractor. bbox is REQUIRED (structured
// outputs are strictest with fully-required objects) — the model sends
// [0,0,0,0] when it can't localize a value and the sanitizer treats that as
// "no bbox". `tile` names the exact labeled image a value was read from on
// tiled reads, so tile coordinates can be mapped back to the full sheet.
const factItemSchema = (withTile: boolean) => ({
  type: "object",
  additionalProperties: false,
  properties: {
    key: { type: "string", enum: EXTRACT_KEYS },
    value: { type: "number" },
    unit: { type: "string", enum: EXTRACT_UNITS },
    sheet: { type: "string" },
    confidence: { type: "number" },
    raw: { type: "string" },
    bbox: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
    ...(withTile ? { tile: { type: "string" } } : {}),
  },
  required: [
    "key",
    "value",
    "unit",
    "sheet",
    "confidence",
    "raw",
    "bbox",
    ...(withTile ? ["tile"] : []),
  ],
});

const factsSchema = (withTile: boolean, withSheets: boolean) => ({
  type: "object",
  additionalProperties: false,
  properties: {
    facts: { type: "array", items: factItemSchema(withTile) },
    ...(withSheets ? { sheets: { type: "array", items: { type: "string" } } } : {}),
  },
  required: ["facts", ...(withSheets ? ["sheets"] : [])],
});

const BBOX_HINT =
  " For every fact, set bbox to [x, y, w, h] — the small region you read the value from, " +
  "normalized 0..1 relative to the page or image it appears on ([0,0,0,0] if you cannot localize it).";

// The standard "not read" fact — value null, confidence 0, never guessed.
const notReadFact = (k: { key: string; label: string; unit: Unit }): PlanFact => ({
  key: k.key,
  label: k.label,
  value: null,
  unit: k.unit,
  sheet: "—",
  bbox: null,
  confidence: 0,
  raw: "Not read from the plan set.",
});

// Prompt fragment shared by every vision/text extractor — names the residential
// metrics and their keys so single- and multi-family plans get read too.
const RESIDENTIAL_METRICS_HINT =
  "Read every dimension actually shown. Use these exact keys/units: conditioned " +
  "or gross floor area (unitSize, sqft); building height to ridge (height, ft); " +
  "front/rear/side setbacks (setbackFront/setbackRear/setbackSide, ft); lot " +
  "coverage as a percent of the lot (lotCoverage, pct); floor area ratio " +
  "(far, ratio); number of parking spaces (parking, spaces); number of dwelling " +
  "units (dwellingUnits, units). Single-family and multi-family sheets show the " +
  "last five; residential sheets usually only show the first four. Omit any metric not " +
  "shown rather than guessing, and set confidence 0..1 honestly.";

export async function extractPlanFactsFromDoc(
  dataBase64: string,
  mediaType: string,
  projectType = "single_family"
): Promise<PlanFact[]> {
  const nullFacts = (readError?: string): PlanFact[] => [
    ...NUMERIC_KEYS.map((k) => ({
      key: k.key,
      label: k.label,
      value: null,
      unit: k.unit,
      sheet: "—",
      bbox: null,
      confidence: 0,
      raw: "Not read from the plan set.",
    })),
    { key: "sheets", label: "Sheets present", value: [], unit: "docs" as const, sheet: "—", bbox: null, confidence: 0, readError },
  ];

  if (!PLAN_READER_LIVE) return nullFacts(NOT_CONFIGURED);

  const schema = factsSchema(false, true);

  const isPdf = /pdf/i.test(mediaType);
  const doc: ContentBlock = isPdf
    ? { type: "document", source: { media_type: "application/pdf", data: dataBase64 } }
    : { type: "image", source: { media_type: mediaType || "image/png", data: dataBase64 } };

  try {
    const content: ContentBlock[] = [
      {
        type: "text",
        text:
          `You are a licensed residential plan checker reading a ${projectType.replace(/_/g, " ")} ` +
          "permit plan set. Read the drawings, dimension strings, and schedules. " +
          RESIDENTIAL_METRICS_HINT +
          " Cite the sheet each value comes from (e.g. 'A1.0') and quote the raw label you read it from." +
          BBOX_HINT +
          " Use a confidence below 0.4 if a dimension is unclear, ambiguous, or not shown. Also list every " +
          "sheet number in the set. Emit at most one fact per key.",
      },
      doc,
    ];
    const { text, error } = await extractJson(content, schema, "extractPlanFactsFromDoc");
    if (text == null) return nullFacts(error);
    const parsed = JSON.parse(text) as { facts: any[]; sheets: string[] };
    const byKey = new Map(parsed.facts.map((f) => [f.key, f]));
    const facts: PlanFact[] = NUMERIC_KEYS.map(
      (k) => sanitizeExtractedFact(k, byKey.get(k.key)) ?? notReadFact(k)
    );
    facts.push({
      key: "sheets",
      label: "Sheets present",
      value: Array.isArray(parsed.sheets) ? parsed.sheets : [],
      unit: "docs",
      sheet: "—",
      bbox: null,
      confidence: parsed.sheets?.length ? 0.9 : 0,
    });
    return facts;
  } catch (e) {
    console.error("[llm:extractPlanFactsFromDoc] could not parse model output:", (e as Error)?.message ?? e);
    return nullFacts("the plan reader's output could not be parsed");
  }
}

// Read a MULTI-SHEET plan set (one PDF per sheet, e.g. plotted from a DWG by
// Design Automation) with vision. Each sheet is labeled so the model can cite
// which sheet a value came from. Same honest-confidence contract as
// extractPlanFactsFromDoc: unread metrics come back value=null / confidence=0.
export async function extractPlanFactsFromDocs(
  sheets: { name: string; data: string }[],
  projectType = "single_family"
): Promise<PlanFact[]> {
  const nullFacts = (readError?: string): PlanFact[] => [
    ...NUMERIC_KEYS.map((k) => ({ key: k.key, label: k.label, value: null, unit: k.unit, sheet: "—", bbox: null, confidence: 0, raw: "Not read from the plan set." })),
    { key: "sheets", label: "Sheets present", value: sheets.map((s) => s.name), unit: "docs" as const, sheet: "—", bbox: null, confidence: sheets.length ? 0.95 : 0, readError },
  ];
  if (!PLAN_READER_LIVE || sheets.length === 0)
    return nullFacts(PLAN_READER_LIVE ? undefined : NOT_CONFIGURED);

  const schema = factsSchema(false, false);

  const content: ContentBlock[] = [
    {
      type: "text",
      text:
        `You are a licensed residential plan checker reading a ${projectType.replace(/_/g, " ")} permit plan ` +
        "set. The following pages are the plotted sheets of the set, each labeled with its sheet number. " +
        "Read the drawings, dimension strings, schedules, and title blocks. " +
        RESIDENTIAL_METRICS_HINT +
        " Cite the sheet each value came from and quote the raw label." +
        BBOX_HINT +
        " Use a confidence below 0.4 if a value " +
        "is unclear or not shown. For a garage/space conversion, unitSize is the converted footprint. Emit at " +
        "most one fact per key.",
    },
  ];
  for (const s of sheets) {
    content.push({ type: "text", text: `--- Sheet ${s.name} ---` });
    content.push({ type: "document", source: { media_type: "application/pdf", data: s.data } });
  }

  try {
    const { text, error } = await extractJson(content, schema, "extractPlanFactsFromDocs", 32000);
    if (text == null) return nullFacts(error);
    const parsed = JSON.parse(text) as { facts: any[] };
    const byKey = new Map(parsed.facts.map((f) => [f.key, f]));
    const facts: PlanFact[] = NUMERIC_KEYS.map(
      (k) => sanitizeExtractedFact(k, byKey.get(k.key)) ?? notReadFact(k)
    );
    facts.push({ key: "sheets", label: "Sheets present", value: sheets.map((s) => s.name), unit: "docs", sheet: "—", bbox: null, confidence: 0.95 });
    return facts;
  } catch (e) {
    console.error("[llm:extractPlanFactsFromDocs] could not parse model output:", (e as Error)?.message ?? e);
    return nullFacts("the plan reader's output could not be parsed");
  }
}

// Read a plan set delivered as high-DPI image TILES (e.g. plotted from a DWG and
// tiled so fine dimension text is legible). Same honest-confidence contract.
export async function extractPlanFactsFromImages(
  tiles: { label: string; data: string; grid?: TileGrid; region?: FactRegion }[],
  projectType = "single_family"
): Promise<PlanFact[]> {
  const sheetNames = [...new Set(tiles.map((t) => t.label.replace(/\s*\(.*$/, "")))];
  const nullFacts = (readError?: string): PlanFact[] => [
    ...NUMERIC_KEYS.map((k) => ({ key: k.key, label: k.label, value: null, unit: k.unit, sheet: "—", bbox: null, confidence: 0, raw: "Not read from the plan set." })),
    { key: "sheets", label: "Sheets present", value: sheetNames, unit: "docs" as const, sheet: "—", bbox: null, confidence: sheetNames.length ? 0.95 : 0, readError },
  ];
  if (!PLAN_READER_LIVE || tiles.length === 0)
    return nullFacts(PLAN_READER_LIVE ? undefined : NOT_CONFIGURED);

  const schema = factsSchema(true, false);
  const tileRegions = new Map<string, FactRegion>();
  for (const t of tiles) {
    const region = t.region ?? (t.grid ? gridToRegion(t.grid) : null);
    if (region) tileRegions.set(t.label, region);
  }

  const content: ContentBlock[] = [
    {
      type: "text",
      text:
        `You are a licensed residential plan checker reading a ${projectType.replace(/_/g, " ")} permit plan set. ` +
        "The following images are high-resolution tiles of the plotted sheets, each labeled with its sheet and " +
        "grid position. Read dimension strings, schedules, and title blocks. " +
        RESIDENTIAL_METRICS_HINT +
        " For a garage/space conversion, unitSize is the converted footprint, which you may compute from the " +
        "plan's overall dimensions. Cite the sheet each value came from and quote the raw label/dimension. Set " +
        "tile to the exact '--- … ---' label of the image you read the value from, and bbox to [x, y, w, h] " +
        "normalized 0..1 within THAT image ([0,0,0,0] if you cannot localize it). Use a " +
        "confidence below 0.4 if a value is unclear or not shown. Emit at most one fact per key.",
    },
  ];
  for (const t of tiles) {
    content.push({ type: "text", text: `--- ${t.label} ---` });
    content.push({ type: "image", source: { media_type: "image/png", data: t.data } });
  }

  try {
    const { text, error } = await extractJson(content, schema, "extractPlanFactsFromImages", 32000);
    if (text == null) return nullFacts(error);
    const parsed = JSON.parse(text) as { facts: any[] };
    const byKey = new Map(parsed.facts.map((f) => [f.key, f]));
    const facts: PlanFact[] = NUMERIC_KEYS.map(
      (k) => sanitizeExtractedFact(k, byKey.get(k.key), { tileRegions }) ?? notReadFact(k)
    );
    facts.push({ key: "sheets", label: "Sheets present", value: sheetNames, unit: "docs", sheet: "—", bbox: null, confidence: 0.95 });
    return facts;
  } catch (e) {
    console.error("[llm:extractPlanFactsFromImages] could not parse model output:", (e as Error)?.message ?? e);
    return nullFacts("the plan reader's output could not be parsed");
  }
}

// Dual-pass PDF read: the document pass reads the PDF natively; when it leaves
// core metrics unread or under-confident, a second pass re-reads high-resolution
// content-cropped page renders with vision, and the two passes are merged
// deterministically (agreement raises confidence, contradiction routes the
// value to NEEDS_REVIEW). Non-PDF inputs and fully confident first passes
// return the document pass unchanged.
export async function extractPlanFactsFromPdfDual(
  dataBase64: string,
  mediaType: string,
  projectType = "single_family",
  onNote?: (note: string) => void
): Promise<PlanFact[]> {
  const primary = await extractPlanFactsFromDoc(dataBase64, mediaType, projectType);
  if (!PLAN_READER_LIVE || !/pdf/i.test(mediaType) || !needsVisionPass(primary)) {
    return primary;
  }
  try {
    // mupdf is loaded lazily inside the renderer — no cost unless this runs.
    const { renderPdfPages } = await import("../pdf-render");
    const pages = await renderPdfPages(dataBase64);
    if (pages.length === 0) return primary;
    onNote?.(
      `Running a second high-resolution vision pass over ${pages.length} page(s) to verify and fill in measurements…`
    );
    const secondary = await extractPlanFactsFromImages(
      pages.map((p) => ({ label: p.label, data: p.data, region: p.crop })),
      projectType
    );
    return mergePlanFactSets(primary, secondary);
  } catch (e) {
    console.error(
      "[llm:extractPlanFactsFromPdfDual] vision pass failed, keeping document pass:",
      (e as Error)?.message ?? e
    );
    return primary;
  }
}

// Short natural-language explanation / suggested correction for a finding.
export async function explain(prompt: string, fallback: string): Promise<string> {
  if (!PLAN_READER_LIVE) return fallback;
  const { text } = await generateText(prompt, "explain", 400);
  return text != null ? text.trim() : fallback;
}
