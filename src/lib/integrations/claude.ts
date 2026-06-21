// Claude adapter (PLAN.md §5 Anthropic). Live with ANTHROPIC_API_KEY, else
// returns deterministic cached results so the pipeline always completes.
import Anthropic from "@anthropic-ai/sdk";
import { CACHED_FACTS } from "../fixtures";
import type { PlanFact } from "../types";

export const CLAUDE_LIVE = !!process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-opus-4-8";

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!CLAUDE_LIVE) return null;
  if (!client) client = new Anthropic();
  return client;
}

// Run a structured-output extraction and return the model's JSON text, or null
// if it couldn't produce one. Streams (so a large vision/PDF request with
// adaptive thinking doesn't hit the HTTP timeout) and gives the model real token
// headroom — at max_tokens:4000 with adaptive thinking on, thinking alone can
// exhaust the budget on a dense plan set, truncating the JSON to nothing. Every
// failure mode is LOGGED rather than silently swallowed, so "couldn't read" can
// be told apart from "API rejected the request" / "ran out of tokens" / "refused".
async function extractJson(
  c: Anthropic,
  content: Anthropic.ContentBlockParam[],
  schema: object,
  label: string,
  maxTokens = 16000
): Promise<string | null> {
  try {
    const stream = c.messages.stream({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content }],
      // Adaptive thinking + structured outputs; spread-cast because the pinned
      // SDK's published types predate these fields.
      ...({
        thinking: { type: "adaptive" },
        output_config: { format: { type: "json_schema", schema } },
      } as any),
    });
    const resp = await stream.finalMessage();
    if (resp.stop_reason === "refusal") {
      console.error(`[claude:${label}] request refused — ${JSON.stringify((resp as any).stop_details ?? {})}`);
      return null;
    }
    if (resp.stop_reason === "max_tokens") {
      console.error(`[claude:${label}] hit max_tokens (${maxTokens}) before finishing — JSON truncated. Raise the budget or reduce the input.`);
    }
    const text = resp.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") {
      console.error(`[claude:${label}] no text block in response (stop_reason=${resp.stop_reason}).`);
      return null;
    }
    return text.text;
  } catch (e) {
    console.error(`[claude:${label}] API call failed:`, (e as Error)?.message ?? e);
    return null;
  }
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
          "You are a residential plan reader. Extract these facts from the ADU " +
          "plan set as numbers where possible: conditioned floor area (sqft), " +
          "building height (ft), rear setback (ft), side setback (ft), and the " +
          "list of sheets present. Use keys: unitSize, height, setbackRear, " +
          "setbackSide, sheets. Report confidence 0..1.",
      },
      ...pageImages.map(
        (data): Anthropic.ContentBlockParam => ({
          type: "image",
          source: { type: "base64", media_type: "image/png", data },
        })
      ),
    ];
    const resp = await c.messages.create({
      model: MODEL,
      max_tokens: 4000,
      messages: [{ role: "user", content }],
      // Adaptive thinking + structured outputs required at runtime by
      // claude-opus-4-8; spread-cast because the pinned SDK's published types
      // predate these fields. Known fields above stay typed.
      ...({
        thinking: { type: "adaptive" },
        output_config: { format: { type: "json_schema", schema } },
      } as any),
    });
    const text = resp.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return CACHED_FACTS;
    const parsed = JSON.parse(text.text) as { facts: any[] };
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
            key: { type: "string", enum: ["unitSize", "height", "setbackRear", "setbackSide"] },
            value: { type: "number" },
            unit: { type: "string", enum: ["ft", "sqft"] },
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
    const resp = await c.messages.create({
      model: MODEL,
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content:
            "These are text labels and properties extracted from an AutoCAD ADU drawing. " +
            "Identify, where present, the conditioned floor area (unitSize, sqft), building " +
            "height (ft), rear setback (ft) and side setback (ft). Only emit a fact if a value " +
            "is genuinely present; set confidence honestly. Lines:\n" +
            lines.join("\n").slice(0, 8000),
        },
      ],
      ...({ thinking: { type: "adaptive" }, output_config: { format: { type: "json_schema", schema } } } as any),
    });
    const text = resp.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return CACHED_FACTS;
    const parsed = JSON.parse(text.text) as { facts: any[] };
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
  { key: "setbackRear", label: "Rear setback", unit: "ft" as const },
  { key: "setbackSide", label: "Side setback", unit: "ft" as const },
];

export async function extractPlanFactsFromDoc(
  dataBase64: string,
  mediaType: string,
  projectType = "detached_adu"
): Promise<PlanFact[]> {
  const nullFacts = (): PlanFact[] => [
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
    { key: "sheets", label: "Sheets present", value: [], unit: "docs" as const, sheet: "—", bbox: null, confidence: 0 },
  ];

  const c = getClient();
  if (!c) return nullFacts();

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
            key: { type: "string", enum: ["unitSize", "height", "setbackRear", "setbackSide"] },
            value: { type: "number" },
            unit: { type: "string", enum: ["ft", "sqft"] },
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
          "permit plan set. Read the drawings, dimension strings, and schedules and report ONLY what " +
          "is actually shown: conditioned floor area (unitSize, sqft), building height to ridge (ft), " +
          "rear setback (ft), and side setback (ft). Cite the sheet each value comes from (e.g. 'A1.0') " +
          "and quote the raw label you read it from. Set confidence honestly: use a value below 0.4 if " +
          "a dimension is unclear, ambiguous, or not shown — do NOT guess. Also list every sheet number " +
          "in the set. Emit at most one fact per key.",
      },
      doc,
    ];
    const raw = await extractJson(c, content, schema, "extractPlanFactsFromDoc");
    if (raw == null) return nullFacts();
    const parsed = JSON.parse(raw) as { facts: any[]; sheets: string[] };
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
    return nullFacts();
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
  const nullFacts = (): PlanFact[] => [
    ...NUMERIC_KEYS.map((k) => ({ key: k.key, label: k.label, value: null, unit: k.unit, sheet: "—", bbox: null, confidence: 0, raw: "Not read from the plan set." })),
    { key: "sheets", label: "Sheets present", value: sheets.map((s) => s.name), unit: "docs" as const, sheet: "—", bbox: null, confidence: sheets.length ? 0.95 : 0 },
  ];
  const c = getClient();
  if (!c || sheets.length === 0) return nullFacts();

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
            key: { type: "string", enum: ["unitSize", "height", "setbackRear", "setbackSide"] },
            value: { type: "number" },
            unit: { type: "string", enum: ["ft", "sqft"] },
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
        "Read the drawings, dimension strings, schedules, and title blocks and report ONLY what is actually " +
        "shown: conditioned/ADU floor area (unitSize, sqft), building height to ridge (ft), rear setback (ft), " +
        "side setback (ft). Cite the sheet each value came from and quote the raw label. Set confidence below " +
        "0.4 if a value is unclear or not shown — do NOT guess. For a garage/space conversion, unitSize is the " +
        "converted footprint. Emit at most one fact per key.",
    },
  ];
  for (const s of sheets) {
    content.push({ type: "text", text: `--- Sheet ${s.name} ---` });
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: s.data } } as Anthropic.ContentBlockParam);
  }

  try {
    const raw = await extractJson(c, content, schema, "extractPlanFactsFromDocs", 32000);
    if (raw == null) return nullFacts();
    const parsed = JSON.parse(raw) as { facts: any[] };
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
    return nullFacts();
  }
}

// Read a plan set delivered as high-DPI image TILES (e.g. plotted from a DWG and
// tiled so fine dimension text is legible). Same honest-confidence contract.
export async function extractPlanFactsFromImages(
  tiles: { label: string; data: string }[],
  projectType = "detached_adu"
): Promise<PlanFact[]> {
  const sheetNames = [...new Set(tiles.map((t) => t.label.replace(/\s*\(.*$/, "")))];
  const nullFacts = (): PlanFact[] => [
    ...NUMERIC_KEYS.map((k) => ({ key: k.key, label: k.label, value: null, unit: k.unit, sheet: "—", bbox: null, confidence: 0, raw: "Not read from the plan set." })),
    { key: "sheets", label: "Sheets present", value: sheetNames, unit: "docs" as const, sheet: "—", bbox: null, confidence: sheetNames.length ? 0.95 : 0 },
  ];
  const c = getClient();
  if (!c || tiles.length === 0) return nullFacts();

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
            key: { type: "string", enum: ["unitSize", "height", "setbackRear", "setbackSide"] },
            value: { type: "number" },
            unit: { type: "string", enum: ["ft", "sqft"] },
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
        "grid position. Read dimension strings, schedules, and title blocks and report ONLY what is actually " +
        "shown: ADU/conditioned floor area (unitSize, sqft — for a garage/space conversion this is the converted " +
        "footprint, which you may compute from the plan's overall dimensions), building height to ridge (ft), " +
        "rear setback (ft), side setback (ft). Cite the sheet each value came from and quote the raw label/dimension. " +
        "Set confidence below 0.4 if a value is unclear or not shown — do NOT guess. Emit at most one fact per key.",
    },
  ];
  for (const t of tiles) {
    content.push({ type: "text", text: `--- ${t.label} ---` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: t.data } });
  }

  try {
    const raw = await extractJson(c, content, schema, "extractPlanFactsFromImages", 32000);
    if (raw == null) return nullFacts();
    const parsed = JSON.parse(raw) as { facts: any[] };
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
    return nullFacts();
  }
}

// Short natural-language explanation / suggested correction for a finding.
export async function explain(prompt: string, fallback: string): Promise<string> {
  const c = getClient();
  if (!c) return fallback;
  try {
    const resp = await c.messages.create({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
      ...({
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
      } as any),
    });
    const text = resp.content.find((b) => b.type === "text");
    return text && text.type === "text" ? text.text.trim() : fallback;
  } catch {
    return fallback;
  }
}
