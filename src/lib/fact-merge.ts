// Two-pass extraction merge (the CodeComply dual-pass pattern, adapted to
// FirstPass's honest-confidence PlanFact contract). The document pass reads the
// PDF natively; the vision pass re-reads high-resolution content-cropped page
// renders. Per key:
//   - only one pass read a value        → take it
//   - both read values that AGREE      → keep the better read, confidence up
//     (two independent reads landed on the same number)
//   - both read values that DISAGREE   → keep the higher-confidence read but
//     cap its confidence below the engine's 0.75 NEEDS_REVIEW threshold — two
//     honest reads that contradict each other are a human-review signal, never
//     a coin flip.
// Claude never decides numbers; this arbitration is deterministic.
import type { PlanFact } from "./types";

const AGREE_REL = 0.02;
const AGREE_ABS = 0.1;
const AGREE_BOOST = 0.05;
const AGREE_CAP = 0.98;
// Below the engine's CONFIDENCE_THRESHOLD (0.75) → routed to NEEDS_REVIEW.
const DISAGREE_CAP = 0.6;

const CONFIDENT = 0.75;
// The four metrics every residential plan set is expected to show — if the
// document pass didn't confidently read all of them, the vision pass runs.
const CORE_KEYS = ["unitSize", "height", "setbackRear", "setbackSide"];

/** Should the high-resolution vision pass run after the document pass? */
export function needsVisionPass(facts: PlanFact[]): boolean {
  const numeric = facts.filter((f) => f.key !== "sheets");
  if (numeric.length === 0) return true;
  // Reader failure (truncation/refusal/API error) → a second pass may recover.
  if (facts.some((f) => f.readError)) return true;
  const confident = (f: PlanFact | undefined) =>
    !!f && typeof f.value === "number" && f.confidence >= CONFIDENT;
  return CORE_KEYS.some((k) => !confident(numeric.find((f) => f.key === k)));
}

function valuesAgree(a: number, b: number): boolean {
  return (
    Math.abs(a - b) <=
    Math.max(AGREE_ABS, Math.max(Math.abs(a), Math.abs(b)) * AGREE_REL)
  );
}

function mergeSheets(primary: PlanFact, secondary: PlanFact | undefined): PlanFact {
  const a = Array.isArray(primary.value) ? (primary.value as string[]) : [];
  const b = Array.isArray(secondary?.value) ? (secondary!.value as string[]) : [];
  // Prefer the document pass's REAL sheet numbers (A1.0, S0.0 …) — the vision
  // pass reads rendered pages and can only cite synthetic "page N" labels.
  const value = a.length ? a : b;
  // A reader failure stands when BOTH passes failed — the vision pass still
  // lists its page labels on failure, which must not mask the error reason.
  const bothFailed = !!primary.readError && !!secondary?.readError;
  return {
    ...primary,
    value,
    confidence: Math.max(primary.confidence, secondary?.confidence ?? 0),
    readError: bothFailed
      ? primary.readError
      : value.length
        ? undefined
        : primary.readError ?? secondary?.readError,
  };
}

/**
 * Merge the document-pass facts (primary) with the vision-pass facts
 * (secondary). Both sets follow the standard shape: one fact per metric key
 * (value null when unread) plus the "sheets" fact.
 */
export function mergePlanFactSets(
  primary: PlanFact[],
  secondary: PlanFact[]
): PlanFact[] {
  const byKey = new Map(secondary.map((f) => [f.key, f]));
  return primary.map((p) => {
    const s = byKey.get(p.key);
    if (p.key === "sheets") return mergeSheets(p, s);

    const pRead = typeof p.value === "number";
    const sRead = s != null && typeof s.value === "number";
    if (!sRead) return p;
    if (!pRead) return s!;

    const pv = p.value as number;
    const sv = s!.value as number;
    const better = s!.confidence > p.confidence ? s! : p;
    if (valuesAgree(pv, sv)) {
      return {
        ...better,
        confidence: Math.min(
          AGREE_CAP,
          Math.max(p.confidence, s!.confidence) + AGREE_BOOST
        ),
      };
    }
    return {
      ...better,
      confidence: Math.min(better.confidence, DISAGREE_CAP),
      raw: `${better.raw ?? ""} [two-pass cross-check: document pass read ${pv}${p.unit ?? ""}, vision pass read ${sv}${s!.unit ?? ""} — the reads disagree, verify manually]`.trim(),
    };
  });
}
