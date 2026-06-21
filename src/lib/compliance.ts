// Deterministic compliance engine (PLAN.md §9). Claude never decides numbers —
// this module does all comparisons, unit normalization, and PASS/FAIL/WARNING/
// NEEDS_REVIEW classification.
import type { Rule, PlanFact, FindingStatus } from "./types";

const CONFIDENCE_THRESHOLD = 0.75;
const WARN_MARGIN = 0.05; // within 5% of threshold → WARNING

export function normalize(value: number, unit: string | null): number {
  // All length already in ft, area in sqft in this MVP. Hook for future units.
  return value;
}

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
  const v = normalize(Number(fact.value), fact.unit);
  const t = rule.threshold ?? 0;
  // "near" = passes, but within the margin of the threshold and not exactly at
  // it → flag as WARNING (close to the limit). Exactly meeting the limit PASSes.
  const near = v !== t && Math.abs(v - t) <= t * WARN_MARGIN;

  if (rule.operator === "<=") {
    if (v <= t) return { status: near ? "WARNING" : "PASS", detail: `${v}${fact.unit} ≤ ${t}${rule.unit}` };
    return { status: "FAIL", detail: `${v}${fact.unit} exceeds limit ${t}${rule.unit}` };
  }
  if (rule.operator === ">=") {
    if (v >= t) return { status: near ? "WARNING" : "PASS", detail: `${v}${fact.unit} ≥ ${t}${rule.unit}` };
    return { status: "FAIL", detail: `${v}${fact.unit} below minimum ${t}${rule.unit}` };
  }
  return { status: "NEEDS_REVIEW", detail: "Unsupported comparison." };
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
