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
const TILES_PER_CALL = 12;

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
  const docTypes = [...new Set(readSets.flatMap((r) => r.docTypes))];

  // Fold the per-sheet sets pairwise: a value read on one sheet stands, two
  // sheets that agree raise confidence, two sheets that contradict cap below
  // the review threshold (deterministic — the model never arbitrates).
  let facts: PlanFact[] | null = null;
  for (const r of readSets) {
    facts = facts ? mergePlanFactSets(facts, r.facts) : r.facts;
  }

  const allNames = plotted.map((s) => s.name);
  if (!facts) {
    // Every sheet failed — honest nulls, with the reason if any call reported one.
    return {
      facts: [],
      docTypes,
      sheetsRead: 0,
      sheetsFailed,
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

  return { facts, docTypes, sheetsRead: readSets.length, sheetsFailed };
}
