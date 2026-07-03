// Deterministic dimension parsing + unit conversion (ported and extended from
// CodeComply's suggestion-geometry parser). Two jobs:
//
//  1. Parse the dimension strings that appear on real plan sheets — architectural
//     feet-inches ("19'-0\"", "9'-10 1/2\""), area callouts ("361 SQ.FT.",
//     "800 SF"), percentages, counts — into typed {value, unit} measures.
//  2. Cross-check a vision-extracted fact against the raw label the model says
//     it read the value from. Claude quotes the label verbatim (fact.raw); this
//     module re-reads that label deterministically and reports whether the
//     model's number matches it. Agreement earns confidence; a contradiction
//     means the number can't be trusted and must drop below the engine's
//     NEEDS_REVIEW threshold. Claude never decides numbers alone.
import type { Unit } from "./types";

export type MeasureUnit =
  | "ft"
  | "in"
  | "sqft"
  | "sqin"
  | "pct"
  | "far"
  | "spaces"
  | "units"
  | "unknown";

export interface ParsedMeasure {
  value: number;
  unit: MeasureUnit;
  /** The exact substring the value was parsed from. */
  match: string;
}

const num = (s: string): number => parseFloat(s.replace(/,/g, ""));

// Ordered patterns — first family that matches wins for parseMeasure(); ALL
// matches of every family are returned by parseAllMeasures() so a label that
// names several dimensions ("LOT 5,000 SF, ADU 800 SF") yields every candidate.
const FEET_INCHES =
  /([\d,]+(?:\.\d+)?)\s*(?:'|′|ft\.?|feet|foot)\s*[-–—]?\s*(\d+(?:\.\d+)?)(?:\s+(\d+)\s*\/\s*(\d+))?\s*(?:"|″|in\b|inch(?:es)?\b)/gi;
const SQFT =
  /([\d,]+(?:\.\d+)?)\s*(?:sq\.?\s*ft\.?|sqft|square\s*f(?:ee|oo)?t|s\.?f\.?(?![a-z]))/gi;
const SQIN = /([\d,]+(?:\.\d+)?)\s*(?:sq\.?\s*in\.?|sqin|square\s*inch(?:es)?)/gi;
const FEET = /([\d,]+(?:\.\d+)?)\s*(?:'|′|ft\b\.?|feet\b|foot\b)/gi;
const INCHES = /([\d,]+(?:\.\d+)?)\s*(?:"|″|in\b\.?|inch(?:es)?\b)/gi;
const PERCENT = /([\d,]+(?:\.\d+)?)\s*(?:%|percent\b)/gi;
const SPACES = /(\d+)\s*(?:parking\s*)?(?:space|stall)s?\b/gi;
const UNITS = /(\d+)\s*(?:dwelling\s*)?units?\b/gi;
const BARE = /^\s*±?\s*([\d,]+(?:\.\d+)?)\s*$/;

/**
 * Every dimension found in a label, in unit-specificity order (feet-inches and
 * areas before bare feet/inches, so `19'-0"` never double-parses as 19 ft + 0 in).
 * Later families skip spans already claimed by an earlier match.
 */
export function parseAllMeasures(raw: string | null | undefined): ParsedMeasure[] {
  if (!raw?.trim()) return [];
  const text = raw.trim();

  const found: ParsedMeasure[] = [];
  const claimed: [number, number][] = [];
  const overlaps = (start: number, end: number) =>
    claimed.some(([s, e]) => start < e && end > s);
  const take = (re: RegExp, unit: MeasureUnit, toValue: (m: RegExpExecArray) => number) => {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (overlaps(start, end)) continue;
      const value = toValue(m);
      if (!Number.isFinite(value)) continue;
      claimed.push([start, end]);
      found.push({ value, unit, match: m[0] });
    }
  };

  take(FEET_INCHES, "ft", (m) => {
    const feet = num(m[1]);
    let inches = num(m[2]);
    if (m[3] && m[4] && num(m[4]) !== 0) inches += num(m[3]) / num(m[4]);
    return feet + inches / 12;
  });
  take(SQFT, "sqft", (m) => num(m[1]));
  take(SQIN, "sqin", (m) => num(m[1]));
  take(PERCENT, "pct", (m) => num(m[1]));
  take(FEET, "ft", (m) => num(m[1]));
  take(INCHES, "in", (m) => num(m[1]));
  take(SPACES, "spaces", (m) => num(m[1]));
  take(UNITS, "units", (m) => num(m[1]));

  if (found.length === 0) {
    const bare = text.match(BARE);
    if (bare) {
      const value = num(bare[1]);
      if (Number.isFinite(value)) found.push({ value, unit: "unknown", match: bare[0] });
    }
  }
  return found;
}

/** The first (most unit-specific) dimension in a label, or null. */
export function parseMeasure(raw: string | null | undefined): ParsedMeasure | null {
  return parseAllMeasures(raw)[0] ?? null;
}

/**
 * Convert a measure to a target engine unit. Returns null when the units are
 * incompatible (ft asked for as sqft, etc.) — the caller must treat that as
 * "cannot compare", never compare raw numbers across units.
 */
export function convertValue(
  value: number,
  from: MeasureUnit | Unit | null,
  to: MeasureUnit | Unit | null
): number | null {
  if (from == null || to == null) return null;
  if (from === to) return value;
  if (to === "ft" && from === "in") return value / 12;
  if (to === "in" && from === "ft") return value * 12;
  if (to === "sqft" && from === "sqin") return value / 144;
  if (to === "sqin" && from === "sqft") return value * 144;
  return null;
}

export type CrossCheckVerdict = "agree" | "disagree" | "unverified";

export interface CrossCheckResult {
  verdict: CrossCheckVerdict;
  /** The label's own value (in the fact's unit) when the verdict is "disagree". */
  expected?: number;
}

// Agreement tolerance: plan labels round ("9'-10\"" = 9.833 may be reported as
// 9.8). Within 2% relative or 0.1 absolute = same number. Only a >10% gap is a
// contradiction; the band between is left unverified rather than punished.
const AGREE_REL = 0.02;
const AGREE_ABS = 0.1;
const DISAGREE_REL = 0.1;

/**
 * Deterministically verify an extracted value against the raw label it was read
 * from. Conservative by construction:
 *  - "agree"     — some dimension in the label matches the value (unit-converted).
 *  - "disagree"  — the label contains exactly ONE unit-compatible dimension and
 *                  it contradicts the value by >10%. (With several candidates,
 *                  or an ambiguous bare number, we never claim contradiction.)
 *  - "unverified"— the label has no parseable dimension, incompatible units, or
 *                  is too ambiguous to judge.
 */
export function crossCheckFactValue(
  value: number,
  unit: Unit | null,
  raw: string | null | undefined
): CrossCheckResult {
  if (!Number.isFinite(value) || unit == null || unit === "docs") {
    return { verdict: "unverified" };
  }
  const candidates = parseAllMeasures(raw);
  if (candidates.length === 0) return { verdict: "unverified" };

  const comparable: { converted: number; ambiguous: boolean }[] = [];
  for (const c of candidates) {
    const converted =
      c.unit === "unknown" ? c.value : convertValue(c.value, c.unit, unit);
    if (converted == null) continue;
    comparable.push({ converted, ambiguous: c.unit === "unknown" });
  }
  if (comparable.length === 0) return { verdict: "unverified" };

  const agrees = (a: number, b: number) =>
    Math.abs(a - b) <= Math.max(AGREE_ABS, Math.max(Math.abs(a), Math.abs(b)) * AGREE_REL);

  if (comparable.some((c) => agrees(c.converted, value))) return { verdict: "agree" };

  // A bare number is unit-ambiguous ("SETBACK 9" could be ft or in) — never
  // claim contradiction from it.
  if (comparable.length === 1 && !comparable[0].ambiguous) {
    const expected = comparable[0].converted;
    const rel = Math.abs(expected - value) / Math.max(Math.abs(expected), Math.abs(value));
    if (rel > DISAGREE_REL) return { verdict: "disagree", expected };
  }
  return { verdict: "unverified" };
}
