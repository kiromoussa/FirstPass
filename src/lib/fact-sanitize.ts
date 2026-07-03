// Validation layer between Claude's extraction output and the compliance
// engine (the "don't trust the LLM" rule from CodeComply's sanitizeViolations).
// Structured outputs guarantee the JSON *shape*; this module guards the
// *content*: finite numbers, clamped confidence, validated bounding boxes, and
// a deterministic cross-check of every value against the raw label the model
// says it read it from. Confidence only moves DOWN past the engine's
// NEEDS_REVIEW threshold on contradiction — never up past honesty.
import type { PlanFact, Unit } from "./types";
import { crossCheckFactValue } from "./measure";

export type FactBbox = [number, number, number, number];

/** Grid position of a high-DPI tile within its full plotted sheet. */
export interface TileGrid {
  row: number; // 1-based
  col: number; // 1-based
  rows: number;
  cols: number;
}

// Validate a model-reported bbox: [x, y, w, h] normalized 0..1 on the image it
// was read from. The extractors ask for [0,0,0,0] when the model can't localize
// a value — a non-positive width/height therefore means "no bbox", not an error.
export function parseFactBbox(raw: unknown): FactBbox | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [x, y, w, h] = raw.map(Number);
  if ([x, y, w, h].some((n) => !Number.isFinite(n))) return null;
  if (w <= 0 || h <= 0) return null;
  if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  // Clamp slight overshoot rather than discarding an otherwise-good box.
  return [x, y, Math.min(w, 1 - x), Math.min(h, 1 - y)];
}

/** A sub-image's normalized rect on its parent page/sheet (a tile's grid cell,
 *  or the content-crop rect of a rendered PDF page). */
export interface FactRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function gridToRegion(grid: TileGrid): FactRegion | null {
  const { row, col, rows, cols } = grid;
  if (rows < 1 || cols < 1 || row < 1 || col < 1 || row > rows || col > cols) return null;
  return { x: (col - 1) / cols, y: (row - 1) / rows, w: 1 / cols, h: 1 / rows };
}

/** Re-normalize a bbox read on a sub-image into parent (page/sheet) coordinates. */
export function mapRegionBboxToParent(bbox: FactBbox, r: FactRegion): FactBbox {
  return [r.x + bbox[0] * r.w, r.y + bbox[1] * r.h, bbox[2] * r.w, bbox[3] * r.h];
}

/** Re-normalize a bbox read on one tile of a sheet into full-sheet coordinates. */
export function mapTileBboxToSheet(bbox: FactBbox, grid: TileGrid): FactBbox {
  const region = gridToRegion(grid);
  return region ? mapRegionBboxToParent(bbox, region) : bbox;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// Confidence adjustments from the deterministic raw-label cross-check.
const AGREE_BOOST = 0.1;
const AGREE_CAP = 0.98;
// A contradicted value must land below the engine's 0.75 NEEDS_REVIEW
// threshold so it is routed to a human, not compared as-is.
const DISAGREE_CAP = 0.5;

export interface RawExtractedFact {
  value?: unknown;
  sheet?: unknown;
  confidence?: unknown;
  raw?: unknown;
  bbox?: unknown;
  tile?: unknown;
}

export interface SanitizeOptions {
  /** Sub-image region by exact image label — set for tiled (DWG plot) reads
   *  and content-cropped PDF page renders, so bboxes map back to the parent. */
  tileRegions?: Map<string, FactRegion>;
}

/**
 * Turn one model-emitted fact for a known metric into a trustworthy PlanFact.
 * Returns null when the model produced no usable numeric value for the key
 * (caller emits the standard "not read" null fact).
 */
export function sanitizeExtractedFact(
  k: { key: string; label: string; unit: Unit },
  m: RawExtractedFact | undefined,
  opts: SanitizeOptions = {}
): PlanFact | null {
  if (!m) return null;
  const value = typeof m.value === "number" ? m.value : NaN;
  if (!Number.isFinite(value)) return null;

  let confidence = typeof m.confidence === "number" ? clamp01(m.confidence) : 0.5;
  let raw = typeof m.raw === "string" ? m.raw : "";

  // Deterministic cross-check: re-read the quoted label and reconcile.
  const check = crossCheckFactValue(value, k.unit, raw);
  if (check.verdict === "agree") {
    confidence = Math.min(AGREE_CAP, confidence + AGREE_BOOST);
  } else if (check.verdict === "disagree") {
    confidence = Math.min(confidence, DISAGREE_CAP);
    raw = `${raw} [cross-check: the quoted label reads ${check.expected}${k.unit}, which contradicts the extracted ${value}${k.unit} — verify manually]`;
  }

  // Bbox: validate, then re-normalize sub-image coordinates to the full sheet
  // or page when the value was read off a labeled tile/cropped render.
  let bbox = parseFactBbox(m.bbox);
  const tile = typeof m.tile === "string" ? m.tile : "";
  if (bbox && opts.tileRegions && opts.tileRegions.size > 0) {
    const region = tile ? opts.tileRegions.get(tile) : undefined;
    if (region) bbox = mapRegionBboxToParent(bbox, region);
    else bbox = null; // unknown/missing tile → coords unmappable to the sheet
  }

  // Tile labels look like "A2.0 (row 1, col 2)" — keep the sheet name clean.
  const sheetRaw = typeof m.sheet === "string" ? m.sheet : "";
  const sheet = sheetRaw.replace(/\s*\(row\b.*$/i, "").trim() || "—";

  return {
    key: k.key,
    label: k.label,
    value,
    unit: k.unit,
    sheet,
    bbox,
    confidence,
    raw,
  };
}
