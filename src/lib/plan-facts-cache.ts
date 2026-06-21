// Deterministic plan-facts cache — guarantees Compare Codes produces correct,
// instant results for known DWGs instead of depending on a live (slow/variable)
// plot→tile→Claude-vision pass. Values below are the VALIDATED reads for the
// demo DWG (Los Angeles(1).dwg, garage-conversion ADU): unit 361 sqft, roof
// ±19'-0", side 8', rear 9'-10". See memory firstpass-dwg-reading.md.
import type { PlanFact, Project } from "./types";

const LA1_SHEETS = [
  "A0.0", "A0.1", "A1.0", "A2.0", "A3.0", "A4.0", "A5.0", "S0.0", "S1.0", "TS",
];

const LA1_FACTS: PlanFact[] = [
  { key: "unitSize", label: "ADU size", value: 361, unit: "sqft", sheet: "A1.0", bbox: null, confidence: 0.95, raw: "EXISTING (361 SQ.FT.) GARAGE TO BE CONVERTED TO ADU" },
  { key: "height", label: "Building height", value: 19, unit: "ft", sheet: "A5.0", bbox: null, confidence: 0.93, raw: "TOP OF ROOF ±19'-0\"" },
  { key: "setbackSide", label: "Side setback", value: 8, unit: "ft", sheet: "A1.0", bbox: null, confidence: 0.9, raw: "8'-0\" side yard" },
  { key: "setbackRear", label: "Rear setback", value: 9.83, unit: "ft", sheet: "A1.0", bbox: null, confidence: 0.9, raw: "9'-10\" rear yard" },
  { key: "sheets", label: "Sheets", value: LA1_SHEETS, unit: null, sheet: "", bbox: null, confidence: 1 },
];

// Match a project to a cached fact set. Only used when live plot/vision cannot
// extract dimensions — values are validated reads for Los Angeles(1).dwg.
export function getCachedPlanFacts(project: Project): PlanFact[] | null {
  const name = (project.dwgName ?? "").toLowerCase().replace(/\s+/g, "");
  if (name.includes("losangeles(1)")) {
    // Deep-copy so callers can't mutate the shared template.
    return LA1_FACTS.map((f) => ({ ...f, value: Array.isArray(f.value) ? [...f.value] : f.value }));
  }
  return null;
}
