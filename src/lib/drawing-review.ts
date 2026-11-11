// Drawing review: building-code checks read off the DRAWING itself.
//
// The zoning reader (plan-read / extractFactsFromTiles) only pulls nine site
// metrics (setbacks, height, coverage, FAR ...), so floor plans, sections and
// elevations were only ever scanned for those numbers. This module asks vision
// for what a plan checker actually looks at on those sheets - escape windows,
// ceiling heights, room sizes, hallways, stairs, smoke/CO alarms - and grades
// every observation deterministically against the 2025 California Residential
// Code (the same corpus the rest of FirstPass cites). Claude reads; it never
// decides pass/fail.
import { compareNumeric, suggestFix } from "./compliance";
import { convertValue } from "./measure";
import { loadCityChunks } from "./code-db";
import { gridToRegion, sanitizeExtractedFact, type FactRegion, type TileGrid } from "./fact-sanitize";
import { PLAN_READER_LIVE, extractJson, type ContentBlock } from "./integrations/llm";
import type { Finding, FindingStatus, PlanFact, Rule, Unit } from "./types";

export const DRAWING_PREFIX = "drawing:";

interface DrawingCheck {
  key: string;
  label: string;
  operator: "<=" | ">=";
  threshold: number;
  unit: Unit;
  /** CRC subsection, used to cite and to pull the verbatim text from the corpus. */
  section: string;
  /** Where to look on the sheets (fed to the vision prompt). */
  hint: string;
  /** Count of a required device: absence routes to NEEDS_REVIEW, not FAIL. */
  presence?: boolean;
}

export const DRAWING_CHECKS: DrawingCheck[] = [
  { key: "egressOpeningArea", label: "Escape window net clear opening", operator: ">=", threshold: 5.7, unit: "sqft", section: "R319.2.1", hint: "each sleeping room's emergency escape window: net clear opening area from the window schedule or callout (EGRESS, NCO)" },
  { key: "egressOpeningHeight", label: "Escape window clear height", operator: ">=", threshold: 24, unit: "in", section: "R319.2.2", hint: "net clear opening height of each sleeping room's escape window" },
  { key: "egressOpeningWidth", label: "Escape window clear width", operator: ">=", threshold: 20, unit: "in", section: "R319.2.2", hint: "net clear opening width of each sleeping room's escape window" },
  { key: "egressSillHeight", label: "Escape window sill height", operator: "<=", threshold: 44, unit: "in", section: "R319.2.3", hint: "height from floor to bottom of clear opening (SILL HT, A.F.F.) of each sleeping room's escape window" },
  { key: "ceilingHeight", label: "Ceiling height", operator: ">=", threshold: 7, unit: "ft", section: "R313.1", hint: "ceiling height of each habitable room or hallway from sections, elevations or room tags (CLG HT, PLATE HT); skip bathrooms, laundry and garages" },
  { key: "roomArea", label: "Habitable room area", operator: ">=", threshold: 70, unit: "sqft", section: "R312.1", hint: "floor area of each habitable room (bedroom, living, dining) from room tags or overall dimensions; skip kitchens, baths, closets" },
  { key: "roomMinDimension", label: "Habitable room minimum dimension", operator: ">=", threshold: 7, unit: "ft", section: "R312.2", hint: "the smaller horizontal dimension of each habitable room; skip kitchens" },
  { key: "hallwayWidth", label: "Hallway width", operator: ">=", threshold: 3, unit: "ft", section: "R318.6", hint: "dimensioned width of each hallway" },
  { key: "stairWidth", label: "Stair clear width", operator: ">=", threshold: 36, unit: "in", section: "R318.7.1", hint: "clear width of each stairway" },
  { key: "stairHeadroom", label: "Stair headroom", operator: ">=", threshold: 80, unit: "in", section: "R318.7.2", hint: "headroom above stair nosings from sections" },
  { key: "stairRiser", label: "Stair riser height", operator: "<=", threshold: 7.75, unit: "in", section: "R318.7.5.1", hint: "riser height from stair sections or notes (e.g. 14R @ 7 1/2\")" },
  { key: "stairTread", label: "Stair tread depth", operator: ">=", threshold: 10, unit: "in", section: "R318.7.5.2", hint: "tread depth from stair sections or notes" },
  { key: "egressDoorWidth", label: "Egress door clear width", operator: ">=", threshold: 32, unit: "in", section: "R318.2", hint: "width of the dwelling's main egress (entry) door: clear width if dimensioned, else the door leaf size from the door schedule (3'-0\" x 6'-8\", 3068)" },
  { key: "guardHeight", label: "Guard height at open-sided surface", operator: ">=", threshold: 42, unit: "in", section: "R321.1.2", hint: "guard or railing height at decks, balconies, porches, landings and lofts more than 30\" above grade (not stairs)" },
  { key: "stairGuardHeight", label: "Guard height on open side of stair", operator: ">=", threshold: 34, unit: "in", section: "R321.1.2", hint: "guard height on the open side of a stair, measured from the nosing line" },
  { key: "smokeAlarm", label: "Smoke alarm in sleeping room", operator: ">=", threshold: 1, unit: "units", section: "R310.3", hint: "number of smoke alarm symbols (SD, SA) drawn inside each sleeping room; 0 if the room is drawn without one", presence: true },
  { key: "coAlarm", label: "CO alarm outside sleeping area", operator: ">=", threshold: 1, unit: "units", section: "R311.3", hint: "number of carbon monoxide alarm symbols (CO, SD/CO) drawn outside each separate sleeping area; 0 if none is drawn", presence: true },
];

const CRC_PROJECT_TYPES = ["single_family", "multi_family", "renovation", "detached_adu", "attached_adu"];
const CHECK_BY_KEY = new Map(DRAWING_CHECKS.map((c) => [c.key, c]));
const OBS_UNITS = ["in", "ft", "sqft", "count"] as const;
// Grade-floor escape openings may be 5.0 sqft (R319.2.1 exception); the plan
// rarely says which floor is grade, so that band is a human call.
const GRADE_FLOOR_MIN_SQFT = 5.0;
// A door leaf's clear width is the leaf minus the stop and the open door's
// thickness, conventionally about 2.5" (a 3'-0" leaf gives ~33.5" clear).
const DOOR_LEAF_TO_CLEAR_IN = 2.5;
const BASES = ["measured", "nominal", "note"] as const;
const OPERATIONS = ["sliding", "single_hung", "double_hung", "casement", "awning", "fixed", "other", "not_a_window"] as const;

type Tile = { label: string; data: string; grid?: TileGrid; region?: FactRegion };

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    observations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          check: { type: "string", enum: DRAWING_CHECKS.map((c) => c.key) },
          location: { type: "string" },
          value: { type: "number" },
          unit: { type: "string", enum: [...OBS_UNITS] },
          basis: { type: "string", enum: [...BASES] },
          operation: { type: "string", enum: [...OPERATIONS] },
          sheet: { type: "string" },
          raw: { type: "string" },
          confidence: { type: "number" },
          tile: { type: "string" },
          bbox: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
        },
        required: ["check", "location", "value", "unit", "basis", "operation", "sheet", "raw", "confidence", "tile", "bbox"],
      },
    },
  },
  required: ["observations"],
};

const PROMPT = (projectType: string) =>
  `You are a licensed residential plan checker reviewing the DRAWINGS of a ${projectType.replace(/_/g, " ")} ` +
  "permit plan set (floor plans, sections, elevations, schedules) - not the site plan. Report what is actually " +
  "drawn or dimensioned for these items, one observation per room/window/stair:\n" +
  DRAWING_CHECKS.map((c) => `- ${c.key}: ${c.hint}`).join("\n") +
  "\nSet location to the room or element as labeled (e.g. 'Bedroom 2', 'Hall', 'Stair A'). Report value in the " +
  "unit you read (in, ft, sqft, or count for alarms); convert feet-inches like 3'-6\" to 3.5 ft. Set basis: " +
  "'measured' when the value is this element's own dimension, area or count (NCO 5.8 SF, CLG HT 8'-0\", a " +
  "dimension string); 'nominal' when it is only a window or door UNIT size from a schedule or tag (4'-0\" x " +
  "2'-0\" SLIDING, 3068) - for a window report the unit width as egressOpeningWidth and unit height as " +
  "egressOpeningHeight, never as clear opening; 'note' when it is a general note or restated requirement " +
  "(44\" MAX SILL) rather than this element's value. Set operation to the window type (or not_a_window). Quote the raw " +
  "text you read in raw. Never guess: omit anything not shown, except alarm counts, which are 0 for a sleeping " +
  "room or sleeping area drawn without the symbol. Set tile to the exact '--- ... ---' label of the image, bbox to " +
  "[x, y, w, h] normalized 0..1 within that image ([0,0,0,0] if unknown), and confidence 0..1 honestly.";

/**
 * Read building-code observations off sheet images. Returns them as PlanFacts
 * keyed `drawing:<check>:<location>` so they persist and cache with the rest of
 * the plan facts. Never throws; a failed read is simply no observations.
 */
export async function reviewDrawingTiles(tiles: Tile[], projectType: string): Promise<PlanFact[]> {
  if (!PLAN_READER_LIVE || tiles.length === 0) return [];
  const tileRegions = new Map<string, FactRegion>();
  for (const t of tiles) {
    const region = t.region ?? (t.grid ? gridToRegion(t.grid) : null);
    if (region) tileRegions.set(t.label, region);
  }
  const content: ContentBlock[] = [{ type: "text", text: PROMPT(projectType) }];
  for (const t of tiles) {
    content.push({ type: "text", text: `--- ${t.label} ---` });
    content.push({ type: "image", source: { media_type: "image/png", data: t.data } });
  }
  try {
    const { text } = await extractJson(content, schema, "reviewDrawing", 16000);
    if (text == null) return [];
    return parseObservations(JSON.parse(text), tileRegions);
  } catch (e) {
    console.error("[drawing-review] read failed:", (e as Error)?.message ?? e);
    return [];
  }
}

/** Render an uploaded PDF plan set and review its pages. */
export async function reviewDrawingPdf(dataBase64: string, mediaType: string, projectType: string): Promise<PlanFact[]> {
  if (!PLAN_READER_LIVE || !/pdf/i.test(mediaType)) return [];
  try {
    const { renderPdfPages } = await import("./pdf-render");
    const pages = await renderPdfPages(dataBase64);
    return reviewDrawingTiles(
      pages.map((p) => ({ label: p.label, data: p.data, region: p.crop })),
      projectType
    );
  } catch (e) {
    console.error("[drawing-review] pdf render failed:", (e as Error)?.message ?? e);
    return [];
  }
}

export function parseObservations(
  parsed: { observations?: unknown[] },
  tileRegions?: Map<string, FactRegion>
): PlanFact[] {
  const out: PlanFact[] = [];
  for (const o of (parsed.observations ?? []) as Record<string, unknown>[]) {
    const check = CHECK_BY_KEY.get(String(o.check));
    if (!check) continue;
    const unit: Unit = o.unit === "count" ? "units" : (o.unit as Unit);
    if (!["in", "ft", "sqft", "units"].includes(unit)) continue;
    const location = String(o.location ?? "").trim() || "unlabeled";
    const fact = sanitizeExtractedFact(
      { key: `${DRAWING_PREFIX}${check.key}:${location}`, label: `${check.label} - ${location}`, unit },
      o,
      { tileRegions }
    );
    if (!fact) continue;
    fact.basis = (BASES as readonly string[]).includes(String(o.basis)) ? (o.basis as PlanFact["basis"]) : "measured";
    if (typeof o.operation === "string" && o.operation !== "not_a_window") fact.operation = o.operation;
    out.push(fact);
  }
  return dedupeObservations(out);
}

/** Same element read twice (two sheets, two chunks) → keep the surer read. */
export function dedupeObservations(facts: PlanFact[]): PlanFact[] {
  const best = new Map<string, PlanFact>();
  for (const f of facts) {
    const k = f.key.toLowerCase();
    const cur = best.get(k);
    if (!cur || f.confidence > cur.confidence) best.set(k, f);
  }
  return [...best.values()];
}

const RANK: Record<FindingStatus, number> = { PASS: 0, WARNING: 1, NEEDS_REVIEW: 2, FAIL: 3 };

/** Verbatim subsection text from the city's CRC corpus, for the finding's citation. */
function codeTextFor(citySlug: string | undefined, section: string): string | undefined {
  const chunks = citySlug ? loadCityChunks(citySlug) : null;
  for (const c of chunks ?? []) {
    if (c.category !== "residential") continue;
    const t = c.text.replace(/\s+/g, " ");
    const i = t.indexOf(`${section} `);
    if (i >= 0) return t.slice(i, i + 420);
  }
  return undefined;
}

const locationOf = (f: PlanFact) => f.label.split(" - ").slice(1).join(" - ");
const inches = (f: PlanFact) => convertValue(Number(f.value), f.unit, "in");

/**
 * Upper bound on a window's net clear opening from its UNIT size: a slider
 * opens at most half its width, a hung window at most half its height. The
 * real opening is smaller still (frame, sash), so a bound that fails is a sure
 * FAIL and a bound that passes only means "confirm the clear opening".
 */
function clearBoundIn(f: PlanFact, dim: "width" | "height"): number | null {
  const v = inches(f);
  if (v == null) return null;
  const halves =
    (dim === "width" && f.operation === "sliding") ||
    (dim === "height" && (f.operation === "single_hung" || f.operation === "double_hung"));
  return halves ? v / 2 : v;
}

/** Escape-opening area bound for windows where only the unit size is shown. */
export function derivedOpeningAreas(facts: PlanFact[]): PlanFact[] {
  const at = (check: string) =>
    new Map(
      facts
        .filter((f) => f.key.startsWith(`${DRAWING_PREFIX}${check}:`))
        .map((f) => [locationOf(f).toLowerCase(), f] as const)
    );
  const areas = at("egressOpeningArea");
  const heights = at("egressOpeningHeight");
  const out: PlanFact[] = [];
  for (const [loc, w] of at("egressOpeningWidth")) {
    const h = heights.get(loc);
    if (!h || areas.has(loc) || w.basis !== "nominal" || h.basis !== "nominal") continue;
    const wb = clearBoundIn(w, "width");
    const hb = clearBoundIn(h, "height");
    if (wb == null || hb == null) continue;
    out.push({
      key: `${DRAWING_PREFIX}egressOpeningArea:${locationOf(w)}`,
      label: `Escape window net clear opening - ${locationOf(w)}`,
      value: Math.round(((wb * hb) / 144) * 100) / 100,
      unit: "sqft",
      sheet: w.sheet,
      bbox: w.bbox,
      confidence: Math.min(w.confidence, h.confidence),
      raw: `at most ${Math.round(wb)}" x ${Math.round(hb)}" clear, from ${w.raw}`,
      basis: "nominal",
      operation: w.operation,
    });
  }
  return out;
}

function grade(check: DrawingCheck, rule: Rule, fact: PlanFact): { status: FindingStatus; line: string } {
  const at = `${locationOf(fact)}: `;
  const where = ` (sheet ${fact.sheet})`;
  if (fact.basis === "note") {
    return { status: "NEEDS_REVIEW", line: `${at}only a general note ("${fact.raw}"), not a dimension of the element - dimension it${where}` };
  }
  let judged = fact;
  let caveat = "";
  if (fact.basis === "nominal" && check.key === "egressDoorWidth") {
    const leaf = inches(fact);
    if (leaf != null) {
      judged = { ...fact, value: leaf - DOOR_LEAF_TO_CLEAR_IN, unit: "in" };
      caveat = ` (estimated clear width of a ${Math.round(leaf)}" door leaf)`;
    }
  } else if (fact.basis === "nominal" && (check.key === "egressOpeningWidth" || check.key === "egressOpeningHeight")) {
    const bound = clearBoundIn(fact, check.key === "egressOpeningWidth" ? "width" : "height");
    if (bound != null) {
      judged = { ...fact, value: bound, unit: "in" };
      caveat = ` (at most this: window unit is ${Math.round(inches(fact)!)}"${fact.operation ? `, ${fact.operation.replace(/_/g, " ")}` : ""})`;
    }
  }
  let { status, detail } = compareNumeric(judged, rule);
  if (status === "FAIL" && check.presence) {
    return { status: "NEEDS_REVIEW", line: `${at}none shown on the drawing - add the alarm or confirm it is shown elsewhere${where}` };
  }
  if (status === "FAIL" && check.key === "egressOpeningArea" && Number(judged.value) >= GRADE_FLOOR_MIN_SQFT) {
    status = "NEEDS_REVIEW";
    detail += "; meets the 5.0 sqft grade-floor exception only if this opening is at grade";
  }
  // A standard 3'-0" leaf (~33.5" clear) is the normal way to meet 32" clear;
  // the 5% "close to the limit" band would flag every ordinary entry door.
  if (status === "WARNING" && fact.basis === "nominal" && check.key === "egressDoorWidth") {
    status = "PASS";
    detail = detail.replace(/\s*\(within .*\)$/, "");
  }
  // A window unit size only bounds the clear opening from above: passing the
  // bound is not passing the code.
  const bounded = fact.basis === "nominal" && check.key.startsWith("egressOpening");
  if (bounded && status !== "FAIL") {
    status = "NEEDS_REVIEW";
    detail += "; net clear opening is not shown, confirm it on the window schedule";
  }
  return { status, line: `${at}${detail}${caveat}${where}` };
}

/**
 * Grade every drawing observation in `facts` against the CRC. One finding per
 * check, worst instance first; every instance is listed in the message.
 */
export function drawingFindings(facts: PlanFact[], citySlug?: string, projectType?: string): Finding[] {
  // The CRC governs dwellings only; commercial work falls under the CBC.
  if (projectType && !CRC_PROJECT_TYPES.includes(projectType)) return [];
  const groups = new Map<string, PlanFact[]>();
  for (const f of [...facts, ...derivedOpeningAreas(facts)]) {
    if (!f.key.startsWith(DRAWING_PREFIX)) continue;
    const key = f.key.slice(DRAWING_PREFIX.length).split(":")[0];
    if (!CHECK_BY_KEY.has(key)) continue;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }

  const findings: Finding[] = [];
  for (const check of DRAWING_CHECKS) {
    const obs = groups.get(check.key);
    if (!obs?.length) continue;
    const rule: Rule = {
      key: check.key,
      label: check.label,
      appliesTo: "any",
      operator: check.operator,
      threshold: check.threshold,
      unit: check.unit,
      sourceId: `CRC ${check.section}`,
      description: `2025 California Residential Code §${check.section}`,
    };
    const graded = obs.map((fact) => ({ fact, ...grade(check, rule, fact) }));
    graded.sort((a, b) => RANK[b.status] - RANK[a.status]);
    const worst = graded[0];
    findings.push({
      id: `f_drawing_${check.key}`,
      ruleKey: `${DRAWING_PREFIX}${check.key}`,
      title: check.label,
      status: worst.status,
      message: graded.map((g) => g.line).join("; ") + ".",
      suggestedCorrection:
        worst.status === "PASS" ? undefined : suggestFix(worst.fact, rule, worst.status, `${check.label} at ${worst.fact.label.split(" - ").slice(1).join(" - ") || "this location"}`),
      factRef: worst.fact.key,
      sourceRef: rule.sourceId,
      bbox: worst.fact.bbox,
      sheet: worst.fact.sheet,
      codeSection: `2025 California Residential Code §${check.section}`,
      codeText: codeTextFor(citySlug, check.section),
    });
  }
  return findings;
}

/** Corpus topics the drawing review already measured (their generic flag is noise). */
export function coveredByDrawing(facts: PlanFact[], topic: string): boolean {
  const measured = facts.filter((f) => f.key.startsWith(DRAWING_PREFIX)).map((f) => f.key.split(":")[1]);
  if (topic === "egress") return measured.some((k) => k.startsWith("egress"));
  if (topic === "smokeAlarm") return measured.some((k) => k === "smokeAlarm" || k === "coAlarm");
  return false;
}
