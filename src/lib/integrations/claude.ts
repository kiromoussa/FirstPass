// Claude adapter (PLAN.md §5 Anthropic). Live with ANTHROPIC_API_KEY, else
// returns deterministic cached results so the pipeline always completes.
import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_AGENT_MODEL } from "../anthropic-model";
import { CACHED_FACTS } from "../fixtures";
import type { PlanFact } from "../types";

export const CLAUDE_LIVE = !!process.env.ANTHROPIC_API_KEY;
// Haiku only — no Sonnet/Opus escalation (cost control for agent workloads).
const MODEL = ANTHROPIC_AGENT_MODEL;

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!CLAUDE_LIVE) return null;
  if (!client) client = new Anthropic();
  return client;
}

// Run a non-streaming request on Haiku. Returns the first text block, or null on failure.
async function createTextWithFallback(
  c: Anthropic,
  params: Record<string, unknown>,
  label: string
): Promise<string | null> {
  try {
    const resp = await c.messages.create({ ...params, model: MODEL } as any);
    if (resp.stop_reason === "refusal") {
      console.error(`[claude:${label}:${MODEL}] refused — ${JSON.stringify((resp as any).stop_details ?? {})}`);
      return null;
    }
    const text = resp.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") {
      console.error(`[claude:${label}:${MODEL}] no text block (stop_reason=${resp.stop_reason}).`);
      return null;
    }
    return text.text;
  } catch (e) {
    console.error(`[claude:${label}:${MODEL}] API call failed:`, (e as Error)?.message ?? e);
    return null;
  }
}

// Run a structured-output extraction and return the model's JSON text, or null
// if it couldn't produce one. Streams (so a large vision/PDF request with
// adaptive thinking doesn't hit the HTTP timeout) and gives the model real token
// headroom — at max_tokens:4000 with adaptive thinking on, thinking alone can
// exhaust the budget on a dense plan set, truncating the JSON to nothing. Every
// failure mode is LOGGED rather than silently swallowed, so "couldn't read" can
// be told apart from "API rejected the request" / "ran out of tokens" / "refused".
// Returns `{ text }` on success, or `{ error }` with a short, user-facing reason
// the caller can surface in the UI (token-budget truncation vs. refusal vs. API
// error are very different things — the old code collapsed them all into "couldn't read").
type ExtractResult = { text: string; error: null } | { text: null; error: string };
async function extractJson(
  c: Anthropic,
  content: Anthropic.ContentBlockParam[],
  schema: object,
  label: string,
  maxTokens = 16000
): Promise<ExtractResult> {
  // One attempt on Haiku (cheapest). max_tokens truncation is not retried with a larger model.
  const attempt = async (
    model: string
  ): Promise<ExtractResult & { retryable: boolean }> => {
    try {
      const stream = c.messages.stream({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content }],
        // Structured outputs; spread-cast because the pinned SDK's published types
        // predate this field. Neither Haiku nor Sonnet needs adaptive thinking here.
        ...({
          output_config: { format: { type: "json_schema", schema } },
        } as any),
      });
      const resp = await stream.finalMessage();
      if (resp.stop_reason === "refusal") {
        console.error(`[claude:${label}:${model}] request refused — ${JSON.stringify((resp as any).stop_details ?? {})}`);
        return { text: null, error: "the plan reader declined to process this document", retryable: true };
      }
      if (resp.stop_reason === "max_tokens") {
        // Truncated mid-JSON — structured output won't parse, so treat as a hard
        // failure and surface the (most actionable) reason rather than the parse error.
        console.error(`[claude:${label}:${model}] hit max_tokens (${maxTokens}) before finishing — JSON truncated. Raise the budget or reduce the input.`);
        return { text: null, error: "the plan reader ran out of token budget before finishing (the plan set may be too large or too dense)", retryable: false };
      }
      const text = resp.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") {
        console.error(`[claude:${label}:${model}] no text block in response (stop_reason=${resp.stop_reason}).`);
        return { text: null, error: "the plan reader returned no readable result", retryable: true };
      }
      return { text: text.text, error: null, retryable: false };
    } catch (e) {
      console.error(`[claude:${label}:${model}] API call failed:`, (e as Error)?.message ?? e);
      return { text: null, error: "the plan reader service call failed", retryable: true };
    }
  };

  const primary = await attempt(MODEL);
  return { text: primary.text, error: primary.error } as ExtractResult;
}

// Structured extraction of plan facts from blueprint page images.
// `pageImages` are base64 PNGs (without data: prefix). Empty → cached facts.
export async function extractPlanFacts(
  pageImages: string[]
): Promise<PlanFact[]> {
  const c = getClient();
  if (!c || pageImages.length === 0) return CACHED_FACTS;

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
    const content: Anthropic.ContentBlockParam[] = [
      {
        type: "text",
        text:
          "You are a residential plan reader. " +
          RESIDENTIAL_METRICS_HINT +
          " Also return the list of sheets present under key 'sheets'.",
      },
      ...pageImages.map(
        (data): Anthropic.ContentBlockParam => ({
          type: "image",
          source: { type: "base64", media_type: "image/png", data },
        })
      ),
    ];
    const text = await createTextWithFallback(
      c,
      {
        max_tokens: 4000,
        messages: [{ role: "user", content }],
        // Structured outputs; spread-cast because the pinned SDK's published types predate this field.
        ...({ output_config: { format: { type: "json_schema", schema } } } as any),
      },
      "extractPlanFacts"
    );
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
    console.error("[claude:extractPlanFacts] failed, using cached reference facts:", (e as Error)?.message ?? e);
    return CACHED_FACTS;
  }
}

// Interpret raw text/property strings extracted from a translated DWG into the
// typed plan facts the compliance engine expects. Falls back to cached facts
// when Claude is unavailable or the extraction is too sparse to be reliable.
export async function interpretDwgText(lines: string[]): Promise<PlanFact[]> {
  const c = getClient();
  if (!c || lines.length === 0) return CACHED_FACTS;

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
    const text = await createTextWithFallback(
      c,
      {
        max_tokens: 2000,
        messages: [
          {
            role: "user",
            content:
              "These are text labels and properties extracted from an AutoCAD residential drawing. " +
              RESIDENTIAL_METRICS_HINT +
              " Lines:\n" +
              lines.join("\n").slice(0, 8000),
          },
        ],
        ...({ output_config: { format: { type: "json_schema", schema } } } as any),
      },
      "interpretDwgText"
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
    console.error("[claude:interpretDwgText] failed, using cached reference facts:", (e as Error)?.message ?? e);
    return CACHED_FACTS;
  }
}

// Read a plan set DIRECTLY with Claude vision — a PDF (Claude renders/reads the
// pages natively at full fidelity) or an image. This is the accurate fact source
// for a real upload: it returns the four numeric facts plus the sheet index,
// with HONEST confidence. Keys it cannot read get value=null / confidence=0, so
// the deterministic engine marks them NEEDS_REVIEW rather than inventing numbers.
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
// Claude may read off a plan set, and every unit those metrics use. Keys Claude
// cannot read come back null (the engine marks them NEEDS_REVIEW, never guesses).
const EXTRACT_KEYS = NUMERIC_KEYS.map((k) => k.key);
const EXTRACT_UNITS = ["ft", "sqft", "pct", "far", "spaces", "units"];

// Prompt fragment shared by every vision/text extractor — names the residential
// metrics and their keys so single- and multi-family plans get read too.
const RESIDENTIAL_METRICS_HINT =
  "Read every dimension actually shown. Use these exact keys/units: conditioned " +
  "or gross floor area (unitSize, sqft); building height to ridge (height, ft); " +
  "front/rear/side setbacks (setbackFront/setbackRear/setbackSide, ft); lot " +
  "coverage as a percent of the lot (lotCoverage, pct); floor area ratio " +
  "(far, ratio); number of parking spaces (parking, spaces); number of dwelling " +
  "units (dwellingUnits, units). Single-family and multi-family sheets show the " +
  "last five; ADU sheets usually only show the first four. Omit any metric not " +
  "shown rather than guessing, and set confidence 0..1 honestly.";

export async function extractPlanFactsFromDoc(
  dataBase64: string,
  mediaType: string,
  projectType = "detached_adu"
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

  const c = getClient();
  if (!c) return nullFacts("the plan reader is not configured (no ANTHROPIC_API_KEY)");

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
            sheet: { type: "string" },
            confidence: { type: "number" },
            raw: { type: "string" },
          },
          required: ["key", "value", "unit", "sheet", "confidence", "raw"],
        },
      },
      sheets: { type: "array", items: { type: "string" } },
    },
    required: ["facts", "sheets"],
  };

  const isPdf = /pdf/i.test(mediaType);
  const doc: Anthropic.ContentBlockParam = isPdf
    ? ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: dataBase64 } } as Anthropic.ContentBlockParam)
    : ({ type: "image", source: { type: "base64", media_type: (mediaType || "image/png") as "image/png", data: dataBase64 } } as Anthropic.ContentBlockParam);

  try {
    const content: Anthropic.ContentBlockParam[] = [
      {
        type: "text",
        text:
          `You are a licensed residential plan checker reading a ${projectType.replace(/_/g, " ")} ` +
          "permit plan set. Read the drawings, dimension strings, and schedules. " +
          RESIDENTIAL_METRICS_HINT +
          " Cite the sheet each value comes from (e.g. 'A1.0') and quote the raw label you read it from. " +
          "Use a confidence below 0.4 if a dimension is unclear, ambiguous, or not shown. Also list every " +
          "sheet number in the set. Emit at most one fact per key.",
      },
      doc,
    ];
    const { text, error } = await extractJson(c, content, schema, "extractPlanFactsFromDoc");
    if (text == null) return nullFacts(error);
    const parsed = JSON.parse(text) as { facts: any[]; sheets: string[] };
    const byKey = new Map(parsed.facts.map((f) => [f.key, f]));
    const facts: PlanFact[] = NUMERIC_KEYS.map((k) => {
      const m = byKey.get(k.key);
      if (!m || typeof m.value !== "number") {
        return { key: k.key, label: k.label, value: null, unit: k.unit, sheet: "—", bbox: null, confidence: 0, raw: "Not read from the plan set." };
      }
      return {
        key: k.key,
        label: k.label,
        value: m.value,
        unit: k.unit,
        sheet: m.sheet || "—",
        bbox: null,
        confidence: typeof m.confidence === "number" ? m.confidence : 0.5,
        raw: m.raw || "",
      };
    });
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
    console.error("[claude:extractPlanFactsFromDoc] could not parse model output:", (e as Error)?.message ?? e);
    return nullFacts("the plan reader's output could not be parsed");
  }
}

// Read a MULTI-SHEET plan set (one PDF per sheet, e.g. plotted from a DWG by
// Design Automation) with Claude vision. Each sheet is labeled so Claude can
// cite which sheet a value came from. Same honest-confidence contract as
// extractPlanFactsFromDoc: unread metrics come back value=null / confidence=0.
export async function extractPlanFactsFromDocs(
  sheets: { name: string; data: string }[],
  projectType = "detached_adu"
): Promise<PlanFact[]> {
  const nullFacts = (readError?: string): PlanFact[] => [
    ...NUMERIC_KEYS.map((k) => ({ key: k.key, label: k.label, value: null, unit: k.unit, sheet: "—", bbox: null, confidence: 0, raw: "Not read from the plan set." })),
    { key: "sheets", label: "Sheets present", value: sheets.map((s) => s.name), unit: "docs" as const, sheet: "—", bbox: null, confidence: sheets.length ? 0.95 : 0, readError },
  ];
  const c = getClient();
  if (!c || sheets.length === 0) return nullFacts(c ? undefined : "the plan reader is not configured (no ANTHROPIC_API_KEY)");

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
            sheet: { type: "string" },
            confidence: { type: "number" },
            raw: { type: "string" },
          },
          required: ["key", "value", "unit", "sheet", "confidence", "raw"],
        },
      },
    },
    required: ["facts"],
  };

  const content: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text:
        `You are a licensed residential plan checker reading a ${projectType.replace(/_/g, " ")} permit plan ` +
        "set. The following pages are the plotted sheets of the set, each labeled with its sheet number. " +
        "Read the drawings, dimension strings, schedules, and title blocks. " +
        RESIDENTIAL_METRICS_HINT +
        " Cite the sheet each value came from and quote the raw label. Use a confidence below 0.4 if a value " +
        "is unclear or not shown. For a garage/space conversion, unitSize is the converted footprint. Emit at " +
        "most one fact per key.",
    },
  ];
  for (const s of sheets) {
    content.push({ type: "text", text: `--- Sheet ${s.name} ---` });
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: s.data } } as Anthropic.ContentBlockParam);
  }

  try {
    const { text, error } = await extractJson(c, content, schema, "extractPlanFactsFromDocs", 32000);
    if (text == null) return nullFacts(error);
    const parsed = JSON.parse(text) as { facts: any[] };
    const byKey = new Map(parsed.facts.map((f) => [f.key, f]));
    const facts: PlanFact[] = NUMERIC_KEYS.map((k) => {
      const m = byKey.get(k.key);
      if (!m || typeof m.value !== "number") {
        return { key: k.key, label: k.label, value: null, unit: k.unit, sheet: "—", bbox: null, confidence: 0, raw: "Not read from the plan set." };
      }
      return { key: k.key, label: k.label, value: m.value, unit: k.unit, sheet: m.sheet || "—", bbox: null, confidence: typeof m.confidence === "number" ? m.confidence : 0.5, raw: m.raw || "" };
    });
    facts.push({ key: "sheets", label: "Sheets present", value: sheets.map((s) => s.name), unit: "docs", sheet: "—", bbox: null, confidence: 0.95 });
    return facts;
  } catch (e) {
    console.error("[claude:extractPlanFactsFromDocs] could not parse model output:", (e as Error)?.message ?? e);
    return nullFacts("the plan reader's output could not be parsed");
  }
}

// Read a plan set delivered as high-DPI image TILES (e.g. plotted from a DWG and
// tiled so fine dimension text is legible). Same honest-confidence contract.
export async function extractPlanFactsFromImages(
  tiles: { label: string; data: string }[],
  projectType = "detached_adu"
): Promise<PlanFact[]> {
  const sheetNames = [...new Set(tiles.map((t) => t.label.replace(/\s*\(.*$/, "")))];
  const nullFacts = (readError?: string): PlanFact[] => [
    ...NUMERIC_KEYS.map((k) => ({ key: k.key, label: k.label, value: null, unit: k.unit, sheet: "—", bbox: null, confidence: 0, raw: "Not read from the plan set." })),
    { key: "sheets", label: "Sheets present", value: sheetNames, unit: "docs" as const, sheet: "—", bbox: null, confidence: sheetNames.length ? 0.95 : 0, readError },
  ];
  const c = getClient();
  if (!c || tiles.length === 0) return nullFacts(c ? undefined : "the plan reader is not configured (no ANTHROPIC_API_KEY)");

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
            sheet: { type: "string" },
            confidence: { type: "number" },
            raw: { type: "string" },
          },
          required: ["key", "value", "unit", "sheet", "confidence", "raw"],
        },
      },
    },
    required: ["facts"],
  };

  const content: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text:
        `You are a licensed residential plan checker reading a ${projectType.replace(/_/g, " ")} permit plan set. ` +
        "The following images are high-resolution tiles of the plotted sheets, each labeled with its sheet and " +
        "grid position. Read dimension strings, schedules, and title blocks. " +
        RESIDENTIAL_METRICS_HINT +
        " For a garage/space conversion, unitSize is the converted footprint, which you may compute from the " +
        "plan's overall dimensions. Cite the sheet each value came from and quote the raw label/dimension. Use a " +
        "confidence below 0.4 if a value is unclear or not shown. Emit at most one fact per key.",
    },
  ];
  for (const t of tiles) {
    content.push({ type: "text", text: `--- ${t.label} ---` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: t.data } });
  }

  try {
    const { text, error } = await extractJson(c, content, schema, "extractPlanFactsFromImages", 32000);
    if (text == null) return nullFacts(error);
    const parsed = JSON.parse(text) as { facts: any[] };
    const byKey = new Map(parsed.facts.map((f) => [f.key, f]));
    const facts: PlanFact[] = NUMERIC_KEYS.map((k) => {
      const m = byKey.get(k.key);
      if (!m || typeof m.value !== "number") {
        return { key: k.key, label: k.label, value: null, unit: k.unit, sheet: "—", bbox: null, confidence: 0, raw: "Not read from the plan set." };
      }
      return { key: k.key, label: k.label, value: m.value, unit: k.unit, sheet: m.sheet || "—", bbox: null, confidence: typeof m.confidence === "number" ? m.confidence : 0.5, raw: m.raw || "" };
    });
    facts.push({ key: "sheets", label: "Sheets present", value: sheetNames, unit: "docs", sheet: "—", bbox: null, confidence: 0.95 });
    return facts;
  } catch (e) {
    console.error("[claude:extractPlanFactsFromImages] could not parse model output:", (e as Error)?.message ?? e);
    return nullFacts("the plan reader's output could not be parsed");
  }
}

// Short natural-language explanation / suggested correction for a finding.
export async function explain(prompt: string, fallback: string): Promise<string> {
  const c = getClient();
  if (!c) return fallback;
  const text = await createTextWithFallback(
    c,
    { max_tokens: 400, messages: [{ role: "user", content: prompt }] },
    "explain"
  );
  return text != null ? text.trim() : fallback;
}
