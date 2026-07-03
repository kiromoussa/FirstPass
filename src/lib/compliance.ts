// Deterministic compliance engine (PLAN.md §9). Claude never decides numbers —
// this module does all comparisons, unit normalization, and PASS/FAIL/WARNING/
// NEEDS_REVIEW classification.
import type { Rule, PlanFact, FindingStatus } from "./types";
import { convertValue, type MeasureUnit } from "./measure";

const CONFIDENCE_THRESHOLD = 0.75;
const WARN_MARGIN = 0.05; // within 5% of threshold → WARNING

// Convert an extracted value into the rule's unit before comparing. Returns
// null when the units are incompatible (e.g. a ft reading against a sqft
// limit) — the engine must flag that for review, never compare raw numbers
// across units. Same-unit and null-unit values pass through unchanged.
export function normalize(
  value: number,
  unit: string | null,
  targetUnit: string | null = unit
): number | null {
  if (unit == null || targetUnit == null || unit === targetUnit) return value;
  return convertValue(value, unit as MeasureUnit, targetUnit as MeasureUnit);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface CompareResult {
  status: FindingStatus;
  detail: string;
}

export function compareNumeric(
  fact: PlanFact,
  rule: Rule
): CompareResult {
  if (fact.value == null) {
    return { status: "NEEDS_REVIEW", detail: "No value extracted." };
  }
  if (fact.confidence < CONFIDENCE_THRESHOLD) {
    return {
      status: "NEEDS_REVIEW",
      detail: `Low extraction confidence (${Math.round(fact.confidence * 100)}%).`,
    };
  }
  const v = normalize(Number(fact.value), fact.unit, rule.unit);
  if (v == null) {
    return {
      status: "NEEDS_REVIEW",
      detail: `Extracted value is in ${fact.unit ?? "an unknown unit"} but the rule limit is in ${rule.unit ?? "an unknown unit"} — cannot compare; verify manually.`,
    };
  }
  const t = rule.threshold ?? 0;
  const u = rule.unit ?? "";
  const delta = round2(Math.abs(v - t));
  // "near" = passes, but within the margin of the threshold and not exactly at
  // it → flag as WARNING (close to the limit). Exactly meeting the limit PASSes.
  const near = v !== t && Math.abs(v - t) <= t * WARN_MARGIN;

  if (rule.operator === "<=") {
    if (v <= t) return { status: near ? "WARNING" : "PASS", detail: `${round2(v)}${u} ≤ ${t}${u}${near ? ` (within ${delta}${u} of the limit)` : ""}` };
    return { status: "FAIL", detail: `${round2(v)}${u} exceeds limit ${t}${u} by ${delta}${u}` };
  }
  if (rule.operator === ">=") {
    if (v >= t) return { status: near ? "WARNING" : "PASS", detail: `${round2(v)}${u} ≥ ${t}${u}${near ? ` (within ${delta}${u} of the minimum)` : ""}` };
    return { status: "FAIL", detail: `${round2(v)}${u} below minimum ${t}${u} by ${delta}${u}` };
  }
  return { status: "NEEDS_REVIEW", detail: "Unsupported comparison." };
}

// Deterministic suggested correction — a finding is never a bare flag (a rule
// borrowed from CodeComply): a FAIL always names the exact delta the design
// must move to comply. Used directly by the Compare Codes path and as the safe
// fallback when the report writer's one-liner is unavailable.
export function suggestFix(
  fact: PlanFact | undefined,
  rule: Rule,
  status: FindingStatus,
  title: string
): string {
  const heading = title.toLowerCase();
  if (status === "WARNING") {
    return `${title} is close to the ${rule.threshold}${rule.unit ?? ""} limit — verify the dimension on the drawings and consider added margin before submitting.`;
  }
  if (status !== "FAIL") {
    return `Provide or verify the ${heading} on the plan set and re-run the check against ${rule.description || "the cited requirement"}.`;
  }
  const v =
    fact && typeof fact.value === "number"
      ? normalize(fact.value, fact.unit, rule.unit)
      : null;
  const t = rule.threshold ?? 0;
  const u = rule.unit ?? "";
  if (v == null) {
    return `Adjust the design so ${heading} meets the cited ${rule.operator} ${t}${u} requirement before submission.`;
  }
  const delta = round2(Math.abs(v - t));
  return rule.operator === "<="
    ? `Reduce ${heading} by at least ${delta}${u} (measured ${round2(v)}${u}, limit ${t}${u}) to likely comply.`
    : `Increase ${heading} by at least ${delta}${u} (measured ${round2(v)}${u}, minimum ${t}${u}) to likely comply.`;
}

// Applicability gate (PLAN.md §9): a rule applies only when its appliesTo
// matches the project subtype (or "any"). When `enforceApplicability` is false
// we simulate the realistic first-pass bug where the wrong rule is selected.
export function selectRule(
  rules: Rule[],
  key: string,
  projectSubtype: string,
  enforceApplicability: boolean
): Rule | undefined {
  const byKey = rules.filter((r) => r.key === key);
  if (byKey.length === 0) return undefined;
  if (enforceApplicability) {
    return (
      byKey.find((r) => r.appliesTo === projectSubtype) ??
      byKey.find((r) => r.appliesTo === "any") ??
      byKey[0]
    );
  }
  // Buggy first pass: take the first matching rule by key, ignoring applicability.
  return byKey[0];
}

export function scoreFrom(statuses: FindingStatus[]): number {
  let score = 100;
  for (const s of statuses) {
    if (s === "FAIL") score -= 25;
    else if (s === "WARNING") score -= 10;
    else if (s === "NEEDS_REVIEW") score -= 5;
  }
  return Math.max(0, score);
}

const BANNED = [
  "officially approved",
  "guaranteed code compliant",
  "certified by the city",
  "guaranteed permit approval",
];

// Scrub unsafe claims from any generated text (PLAN.md §Safety).
export function languageLint(text: string): string {
  let out = text;
  for (const phrase of BANNED) {
    out = out.replace(new RegExp(phrase, "gi"), "likely a potential issue to confirm");
  }
  return out;
}
