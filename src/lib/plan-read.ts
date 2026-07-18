// Read EVERY plotted sheet of a DWG plan set, one vision call per sheet.
//
// The old reader tiled sheets into one global list, truncated it at a flat cap
// (24 tiles ≈ the first 4 sheets of an 11-sheet set), and sent everything in a
// single giant model call. Values drawn on later sheets — roof height on A5.0,
// setbacks on the site plan — were never even seen, so the run reported them
// missing. This reader mirrors the approach that works in CodeComply: enumerate
// every sheet, process each independently (a failed sheet degrades to "no facts
// from this sheet" instead of sinking the whole set), and merge deterministically.
import { tilesFromPdf, type PlottedSheet } from "./integrations/autocad-da";
import {
  extractPlanFactsFromSheetImages,
  extractMissingPlanFacts,
  extractPlanSetMeta,
  type PlanSetMeta,
  type SheetDocType,
} from "./integrations/llm";
import { mergePlanFactSets } from "./fact-merge";
import type { PlanFact } from "./types";

// Parallel per-sheet vision calls. Each call carries one sheet's tiles (~6 at
// 150dpi ARCH D), so the pool bounds wall-clock time: 10 sheets read in 2-3
// call rounds instead of one 80-image request that times out.
const READ_CONCURRENCY = Math.max(1, Number(process.env.PLAN_READ_CONCURRENCY) || 5);

// The model-space capture ("Model.pdf") holds an ENTIRE plan set's sheets drawn
// side by side on one 24x36 page — at the standard 150dpi its text is a few
// pixels tall. The plotted PDF is vector, so render it denser and split the
// larger tile grid across several calls.
const SHEET_DPI = 150;
const MODEL_DPI = 450;
// Focused re-read runs at double density: dimension strings on a site plan
// (±5'-0" between property line and building) are a few pixels tall at 150dpi
// and routinely skimmed past on the first pass.
const FOCUS_DPI = 300;
const TILES_PER_CALL = 12;

// Which sheets can answer which missing metrics on the focused second pass.
const SITE_KEYS = ["setbackFront", "setbackRear", "setbackSide", "lotCoverage", "far", "parking", "dwellingUnits", "unitSize"];
const ELEVATION_KEYS = ["height"];
const CONFIDENT = 0.75;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export interface SheetReadOutcome {
  facts: PlanFact[];
  /** Union of document types detected across all sheets (site plan, floor plan …). */
  docTypes: SheetDocType[];
  /** Sheets whose vision read produced facts or an explicit empty read. */
  sheetsRead: number;
  /** Sheets that could not be tiled or whose read errored. */
  sheetsFailed: string[];
  /**
   * Sheets that plotted but carry almost no ink — typically an unresolved
   * external reference (the sheet's content lives in a PDF/xref that AutoCAD
   * could not find), so what looks like a captured sheet is actually empty.
   */
  sheetsNearBlank: string[];
  /** Title-sheet identity (plan address/city, zoning, scope, sheet index). */
  meta: PlanSetMeta | null;
}

/**
 * Tile and read every plotted sheet with vision, in parallel, and merge the
 * per-sheet fact sets. No global tile cap: every sheet in the set is read.
 */
export async function readFactsFromAllSheets(
  plotted: PlottedSheet[],
  projectType: string,
  onNote?: (note: string) => void
): Promise<SheetReadOutcome> {
  const perSheet: ({ facts: PlanFact[]; docTypes: SheetDocType[] } | null)[] = new Array(
    plotted.length
  ).fill(null);
  const nearBlank: boolean[] = new Array(plotted.length).fill(false);

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= plotted.length) return;
      const sheet = plotted[i];
      try {
        const isModel = sheet.name.toLowerCase() === "model";
        const tiles = await tilesFromPdf(sheet.data, sheet.name, isModel ? MODEL_DPI : SHEET_DPI);
        if (tiles.length === 0) continue; // unreadable PDF — counted as failed below
        // A full ARCH-D sheet tiles to ~6 images at 150dpi and plots to tens of
        // KB; a page that yields ≤2 tiles AND a tiny PDF is near-empty —
        // usually an unresolved xref note where the sheet's real content
        // should be (seen live: 6KB CALGreen sheets whose body is an external
        // PDF the plot couldn't find, carrying only "invalid reference").
        const pdfBytes = Math.floor(sheet.data.length * 0.75);
        if (!isModel && tiles.length <= 2 && pdfBytes < 20_000) nearBlank[i] = true;
        // One call per chunk (the model capture can tile past what a single
        // request should carry); chunks of the same sheet merge like sheets do.
        let result: { facts: PlanFact[]; docTypes: SheetDocType[] } | null = null;
        for (const group of chunk(tiles, TILES_PER_CALL)) {
          const r = await extractPlanFactsFromSheetImages(group, projectType);
          result = result
            ? { facts: mergePlanFactSets(result.facts, r.facts), docTypes: [...new Set([...result.docTypes, ...r.docTypes])] }
            : r;
        }
        if (!result) continue;
        perSheet[i] = result;
        const read = result.facts.filter((f) => f.key !== "sheets" && f.value != null);
        onNote?.(
          `Sheet ${sheet.name}: ` +
            (read.length
              ? read.map((f) => `${f.label} ${f.value}${f.unit !== "docs" ? f.unit : ""}`).join(", ")
              : "no governing dimensions on this sheet") +
            (result.docTypes.length ? ` — contains: ${result.docTypes.join(", ").replace(/_/g, " ")}` : "")
        );
      } catch (e) {
        console.error(`[plan-read] sheet ${sheet.name} read failed:`, (e as Error)?.message ?? e);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, plotted.length) }, worker)
  );

  const readSets = perSheet.filter((r) => r !== null);
  const sheetsFailed = plotted.filter((_, i) => perSheet[i] === null).map((s) => s.name);
  const sheetsNearBlank = plotted.filter((_, i) => nearBlank[i]).map((s) => s.name);
  const docTypes = [...new Set(readSets.flatMap((r) => r.docTypes))];

  // Fold the per-sheet sets pairwise: a value read on one sheet stands, two
  // sheets that agree raise confidence, two sheets that contradict cap below
  // the review threshold (deterministic — the model never arbitrates).
  let facts: PlanFact[] | null = null;
  for (const r of readSets) {
    facts = facts ? mergePlanFactSets(facts, r.facts) : r.facts;
  }

  // Sheets by the doc types their own read detected — drives the focused
  // second pass (site metrics live on site plans / cover sheets, height on
  // elevations and sections) and the title-sheet meta read.
  const sheetsWithType = (types: SheetDocType[]) =>
    plotted.filter((_, i) => perSheet[i]?.docTypes.some((t) => types.includes(t)));

  // Title-sheet identity read: plan address/city, zoning, scope of work, and
  // the sheet index. Cover sheet first; a site plan often doubles as one.
  let meta: PlanSetMeta | null = null;
  try {
    const coverCandidates = [
      ...sheetsWithType(["cover_or_index"]),
      ...sheetsWithType(["site_plan"]),
      ...plotted.filter((s) => s.name.toLowerCase() !== "model"),
    ];
    const cover = coverCandidates[0];
    if (cover) {
      const tiles = await tilesFromPdf(cover.data, cover.name, FOCUS_DPI);
      meta = await extractPlanSetMeta(tiles.slice(0, TILES_PER_CALL));
      if (meta?.projectAddress || meta?.sheetIndex.length) {
        onNote?.(
          `Title sheet: ${meta.projectAddress ?? "address not shown"}` +
            (meta.zoning ? `, zone ${meta.zoning}` : "") +
            (meta.aduConversion ? " — scope: ADU conversion of existing space" : "") +
            (meta.sheetIndex.length ? ` — index lists ${meta.sheetIndex.length} sheets` : "")
        );
      }
    }
  } catch (e) {
    console.error("[plan-read] title-sheet meta read failed:", (e as Error)?.message ?? e);
  }

  // Focused second pass: metrics still null/under-confident after the full
  // read get one more look, at double DPI, on only the sheets that can answer
  // them, with a prompt that names exactly what is missing and where such
  // values are drawn. This is what recovers ±5'-0" setback strings that a
  // general 150dpi pass skims past.
  if (facts) {
    const confident = (f: PlanFact | undefined) =>
      !!f && typeof f.value === "number" && f.confidence >= CONFIDENT;
    const missing = (keys: string[]) =>
      keys.filter((k) => !confident(facts!.find((f) => f.key === k)));
    const passes: { keys: string[]; sheets: PlottedSheet[] }[] = [
      { keys: missing(SITE_KEYS), sheets: sheetsWithType(["site_plan", "cover_or_index"]) },
      { keys: missing(ELEVATION_KEYS), sheets: sheetsWithType(["elevation", "section"]) },
    ];
    for (const pass of passes) {
      if (!pass.keys.length || !pass.sheets.length) continue;
      for (const sheet of pass.sheets.slice(0, 2)) {
        try {
          const tiles = await tilesFromPdf(sheet.data, sheet.name, FOCUS_DPI);
          if (!tiles.length) continue;
          let recovered: PlanFact[] | null = null;
          for (const group of chunk(tiles, TILES_PER_CALL)) {
            const r = await extractMissingPlanFacts(group, pass.keys, projectType);
            if (r) recovered = recovered ? mergePlanFactSets(recovered, r.facts) : r.facts;
          }
          if (recovered) {
            const found = recovered.filter(
              (f) => pass.keys.includes(f.key) && f.value != null
            );
            if (found.length) {
              onNote?.(
                `Focused re-read of ${sheet.name} at ${FOCUS_DPI}dpi recovered: ` +
                  found.map((f) => `${f.label} ${f.value}${f.unit !== "docs" ? f.unit : ""}`).join(", ")
              );
            }
            facts = mergePlanFactSets(facts, recovered);
          }
        } catch (e) {
          console.error(`[plan-read] focused re-read of ${sheet.name} failed:`, (e as Error)?.message ?? e);
        }
      }
    }
  }

  const allNames = plotted.map((s) => s.name);
  if (!facts) {
    // Every sheet failed — honest nulls, with the reason if any call reported one.
    return {
      facts: [],
      docTypes,
      sheetsRead: 0,
      sheetsFailed,
      sheetsNearBlank,
      meta,
    };
  }

  // The merged sheets fact carries only the first sheet's name — replace it
  // with the full plotted set, which is ground truth from the plot itself.
  const readErrors = readSets
    .map((r) => r.facts.find((f) => f.key === "sheets")?.readError)
    .filter((e): e is string => !!e);
  const anyValue = facts.some((f) => f.key !== "sheets" && f.value != null);
  facts = facts.map((f) =>
    f.key === "sheets"
      ? {
          ...f,
          value: allNames,
          raw: `Sheets in set: ${allNames.join(", ")}`,
          confidence: 0.95,
          readError: !anyValue && readErrors.length ? readErrors[0] : undefined,
        }
      : f
  );

  return { facts, docTypes, sheetsRead: readSets.length, sheetsFailed, sheetsNearBlank, meta };
}
