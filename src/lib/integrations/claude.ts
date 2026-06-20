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
  } catch {
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
  } catch {
    return CACHED_FACTS;
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
