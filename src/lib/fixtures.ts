// Canonical demo data for Alameda, CA detached ADU (PLAN.md §10).
// These are the cached/fallback values; live agents overwrite them when keys
// are present. Values are demo-calibrated, not legal advice.
import type { Source, Rule, PlanFact, ChecklistItem } from "./types";

export const JURISDICTION_ID = "alameda-ca";

export const CACHED_SOURCES: Source[] = [
  {
    id: "S1",
    url: "https://library.municode.com/ca/alameda/codes/code_of_ordinances",
    title: "Alameda Municipal Code §30-5.21 — Accessory Dwelling Units (size)",
    excerpt:
      "The maximum floor area of a detached accessory dwelling unit shall not exceed 1,200 square feet.",
    retrievedAt: Date.now(),
    authorityScore: 0.98,
    jurId: JURISDICTION_ID,
    live: false,
  },
  {
    id: "S2",
    url: "https://www.hcd.ca.gov/policy-and-research/accessory-dwelling-units",
    title: "California HCD — ADU Height Standards",
    excerpt:
      "A detached accessory dwelling unit may be up to 18 feet in height. An attached accessory dwelling unit is limited to 16 feet where it must match the primary dwelling.",
    retrievedAt: Date.now(),
    authorityScore: 0.97,
    jurId: JURISDICTION_ID,
    live: false,
  },
  {
    id: "S3",
    url: "https://library.municode.com/ca/alameda/codes/code_of_ordinances",
    title: "Alameda Municipal Code §30-5.21 — ADU Setbacks",
    excerpt:
      "A minimum setback of 4 feet from the side and rear lot lines shall be required for an accessory dwelling unit.",
    retrievedAt: Date.now(),
    authorityScore: 0.98,
    jurId: JURISDICTION_ID,
    live: false,
  },
  {
    id: "S4",
    url: "https://www.alamedaca.gov/Departments/Planning-Building-and-Transportation",
    title: "Alameda Planning & Building — ADU Permit Submittal Checklist",
    excerpt:
      "A complete ADU submittal must include a site plan, floor plan, building elevations, and a Title-24 energy compliance report.",
    retrievedAt: Date.now(),
    authorityScore: 0.95,
    jurId: JURISDICTION_ID,
    live: false,
  },
];

// Two "height" rules exist — the attached one is the trap the Reviewer/Arize
// applicability eval must catch (PLAN.md §10 set piece).
export const RULES: Rule[] = [
  {
    key: "maxSize",
    label: "Maximum unit size",
    appliesTo: "detached_adu",
    operator: "<=",
    threshold: 1200,
    unit: "sqft",
    sourceId: "S1",
    description: "Detached ADU conditioned floor area must not exceed 1,200 sq ft.",
  },
  {
    // TRAP: attached-ADU limit — must NOT apply to a detached ADU.
    key: "height",
    label: "Height limit (attached ADU)",
    appliesTo: "attached_adu",
    operator: "<=",
    threshold: 16,
    unit: "ft",
    sourceId: "S2",
    description: "Attached ADU height limited to 16 ft to match the primary dwelling.",
  },
  {
    key: "height",
    label: "Height limit (detached ADU)",
    appliesTo: "detached_adu",
    operator: "<=",
    threshold: 18,
    unit: "ft",
    sourceId: "S2",
    description: "Detached ADU may be up to 18 ft in height.",
  },
  {
    key: "setbackRear",
    label: "Rear setback",
    appliesTo: "any",
    operator: ">=",
    threshold: 4,
    unit: "ft",
    sourceId: "S3",
    description: "Minimum 4 ft rear setback for an ADU.",
  },
  {
    key: "setbackSide",
    label: "Side setback",
    appliesTo: "any",
    operator: ">=",
    threshold: 4,
    unit: "ft",
    sourceId: "S3",
    description: "Minimum 4 ft side setback for an ADU.",
  },
  {
    key: "requiredDocs",
    label: "Required documents",
    appliesTo: "any",
    operator: "present",
    threshold: null,
    unit: "docs",
    sourceId: "S4",
    description: "Site plan, floor plan, elevations, and Title-24 report required.",
  },
];

// Demo plan facts. Bboxes are normalized [x,y,w,h] over the blueprint image.
export const CACHED_FACTS: PlanFact[] = [
  {
    key: "unitSize",
    label: "Conditioned floor area",
    value: 1180,
    unit: "sqft",
    sheet: "A-2",
    bbox: [0.55, 0.62, 0.28, 0.12],
    confidence: 0.93,
    raw: "Total conditioned: 1,180 SF",
  },
  {
    key: "height",
    label: "Building height",
    value: 18,
    unit: "ft",
    sheet: "A-3",
    bbox: [0.18, 0.16, 0.34, 0.14],
    confidence: 0.9,
    raw: "Max height 18'-0\" to ridge",
  },
  {
    key: "setbackRear",
    label: "Rear setback",
    value: 4,
    unit: "ft",
    sheet: "A-1",
    bbox: [0.62, 0.18, 0.2, 0.1],
    confidence: 0.88,
    raw: "Rear yard 4'-0\"",
  },
  {
    key: "setbackSide",
    label: "Side setback",
    value: 3,
    unit: "ft",
    sheet: "A-1",
    bbox: [0.1, 0.4, 0.16, 0.18],
    confidence: 0.86,
    raw: "Side yard 3'-0\"",
  },
  {
    key: "sheets",
    label: "Sheets present",
    value: ["A-1 Site Plan", "A-2 Floor Plan", "A-3 Elevations"],
    unit: "docs",
    sheet: "—",
    bbox: null,
    confidence: 0.95,
    raw: "Sheet index: A-1, A-2, A-3",
  },
];

export const REQUIRED_DOCS = [
  "Site plan",
  "Floor plan",
  "Building elevations",
  "Title-24 energy compliance report",
];

export function deriveChecklist(facts: PlanFact[]): ChecklistItem[] {
  const sheetsFact = facts.find((f) => f.key === "sheets");
  const sheets = Array.isArray(sheetsFact?.value)
    ? (sheetsFact!.value as string[]).join(" ").toLowerCase()
    : "";
  const has = (kw: string[]) => kw.some((k) => sheets.includes(k));
  return [
    { item: "Site plan", required: true, present: has(["site"]) },
    { item: "Floor plan", required: true, present: has(["floor"]) },
    { item: "Building elevations", required: true, present: has(["elevation"]) },
    {
      item: "Title-24 energy compliance report",
      required: true,
      present: has(["title-24", "title 24", "energy"]),
      note: "Not found in the uploaded set.",
    },
  ];
}
