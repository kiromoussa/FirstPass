// Extended compliance checks against the Python-chunked code corpus
// (data/cities/<slug>/chunks.json — produced by scripts/chunk_codes.py).
// Numeric ADU rules (size/height/setbacks) live in rules.json; this module
// retrieves governing provisions for the broader topics the chunker tags
// (egress, fire, ventilation, CALGreen, etc.) and flags items for review.
import type { Finding, PlanFact, Project } from "./types";
import {
  loadCityChunks,
  retrieveCodeHybrid,
  type CodeChunk,
} from "./code-db";

/** Topics tagged by scripts/chunk_codes.py beyond the core ADU numeric rules. */
export const PYTHON_CORPUS_TOPICS = [
  "egress",
  "fireProtection",
  "ventilation",
  "waterEfficiency",
  "smokeAlarm",
  "evCharging",
  "solar",
  "occupancy",
  "foundation",
] as const;

export type CorpusTopic = (typeof PYTHON_CORPUS_TOPICS)[number];

const TOPIC_LABELS: Record<CorpusTopic, string> = {
  egress: "Means of egress & emergency escape",
  fireProtection: "Fire separation & fire-resistance",
  ventilation: "Mechanical ventilation",
  waterEfficiency: "Water-conserving fixtures (CALGreen)",
  smokeAlarm: "Smoke & carbon monoxide alarms",
  evCharging: "EV charging readiness",
  solar: "Photovoltaic / solar readiness",
  occupancy: "Occupancy classification",
  foundation: "Foundation & existing garage slab",
};

// Prefer city/state layers for zoning; building/residential for life-safety.
const TOPIC_CATEGORY: Partial<Record<CorpusTopic, string>> = {
  egress: "building",
  fireProtection: "building",
  ventilation: "building",
  waterEfficiency: "green",
  smokeAlarm: "residential",
  evCharging: "state",
  solar: "green",
  occupancy: "building",
  foundation: "building",
};

const TOPIC_TERMS: Record<CorpusTopic, string[]> = {
  egress: ["egress", "emergency escape", "exit", "bedroom", "sleeping"],
  fireProtection: ["fire", "separation", "garage", "1-hour", "rated"],
  ventilation: ["vent", "exhaust", "bath", "kitchen", "mechanical"],
  waterEfficiency: ["lavatory", "water closet", "fixture", "gpm", "gpf"],
  smokeAlarm: ["smoke", "co alarm", "detector"],
  evCharging: ["ev", "electric vehicle", "charging"],
  solar: ["solar", "photovoltaic", "pv"],
  occupancy: ["occupancy", "r-3", "dwelling", "adu", "garage"],
  foundation: ["foundation", "slab", "footing", "garage", "existing"],
};

/** Garage / ADU conversion plans trigger life-safety + foundation topics. */
const ADU_CONVERSION_TOPICS: CorpusTopic[] = [
  "egress",
  "fireProtection",
  "smokeAlarm",
  "ventilation",
  "foundation",
  "occupancy",
];

function planHaystack(facts: PlanFact[]): string {
  return facts
    .map((f) => `${f.label} ${f.raw ?? ""} ${f.sheet} ${String(f.value ?? "")}`)
    .join(" ")
    .toLowerCase();
}

function isAduConversion(hay: string): boolean {
  return /adu|accessory dwelling|garage.*convert|convert.*garage|dwelling unit/.test(hay);
}

function planTouchesTopic(facts: PlanFact[], topic: CorpusTopic): boolean {
  const hay = planHaystack(facts);
  if (TOPIC_TERMS[topic].some((t) => hay.includes(t))) return true;
  if (isAduConversion(hay) && ADU_CONVERSION_TOPICS.includes(topic)) return true;
  return false;
}

// Every code-layer category scripts/chunk_codes.py and scripts/import_cadai_corpus.py
// assign (see CATEGORY_RULES / STATE_CODE_FILES). A topic's real governing
// provision doesn't always live in its "preferred" layer — e.g. ventilation
// is centrally a Mechanical Code topic, not Building — so the fallback chain
// must cover every real category, not a fixed short list that quietly never
// reaches mechanical/electrical/fire/plumbing/energy at all.
const ALL_CATEGORIES = [
  "building", "residential", "mechanical", "electrical", "plumbing",
  "fire", "green", "energy", "city", "state", "county", "general",
];

async function retrieveTopicChunk(
  topic: CorpusTopic,
  project: Project,
  citySlug: string
): Promise<CodeChunk | null> {
  const appliesTo = project.projectType;
  const preferred = TOPIC_CATEGORY[topic];
  const ordered = preferred
    ? [preferred, ...ALL_CATEGORIES.filter((c) => c !== preferred)]
    : ALL_CATEGORIES;
  // requireTag=true while trying each category: retrieveCode's own widen-
  // within-category fallback would otherwise let the FIRST category tried
  // always return *some* plausible-looking chunk, so this loop would never
  // actually reach the category the topic really lives in. Only the final,
  // whole-corpus try (category=undefined) is allowed to widen — a true
  // last resort, not a trap sprung on the very first attempt.
  for (const cat of ordered) {
    const chunk = await retrieveCodeHybrid(topic, appliesTo, citySlug, cat, true);
    if (chunk) return chunk;
  }
  return retrieveCodeHybrid(topic, appliesTo, citySlug, undefined, false);
}

function excerpt(text: string, max = 320): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** Scan the chunked corpus for life-safety / CALGreen / Title-24 topics. */
export async function runCorpusTopicChecks(
  project: Project,
  facts: PlanFact[],
  citySlug: string
): Promise<Finding[]> {
  const corpus = loadCityChunks(citySlug);
  if (!corpus?.length) return [];

  const findings: Finding[] = [];
  for (const topic of PYTHON_CORPUS_TOPICS) {
    if (!planTouchesTopic(facts, topic)) continue;

    const chunk = await retrieveTopicChunk(topic, project, citySlug);
    if (!chunk) continue;

    const section = chunk.citation ?? chunk.section;
    const finding: Finding = {
      id: `f_corpus_${topic}`,
      ruleKey: topic,
      title: TOPIC_LABELS[topic],
      status: "NEEDS_REVIEW",
      message: `Plan set may implicate ${TOPIC_LABELS[topic].toLowerCase()} — verify design against ${section}. ${excerpt(chunk.text)}`,
      sourceRef: chunk.sourceId,
      codeSection: section,
      codeText: chunk.text,
      sheet: facts.find((f) => f.key !== "sheets")?.sheet,
    };
    findings.push(finding);
  }
  return findings;
}

export function corpusChunkCount(citySlug: string): number {
  return loadCityChunks(citySlug)?.length ?? 0;
}

// Phrases that signal the plan set already carries energy documentation - the
// CF1R Certificate of Compliance, Title 24 forms, or mandatory-measures notes.
const ENERGY_DOC_TERMS = [
  "title 24",
  "title-24",
  "t-24",
  "t24",
  "cf1r",
  "cf-1r",
  "cf2r",
  "energy compliance",
  "energy calc",
  "mandatory measures",
  "energy notes",
];

/** Read the per-sheet vision doc-type classification, wherever it was stashed. */
export function docTypesFromFacts(facts: PlanFact[]): string[] {
  const f = facts.find((x) => x.key === "docTypes");
  return Array.isArray(f?.value) ? (f!.value as string[]) : [];
}

// Anchors that identify a LOW-RISE RESIDENTIAL energy provision, and ones that
// mark a nonresidential/school section that must never be cited for an ADU or
// house. The generic hybrid retriever (RedisVL semantic + term scoring) kept
// returning the "School Buildings" envelope table for an energy query because
// it is dense with "u-factor"/"insulation"; scanning the ingested energy corpus
// with these residential anchors is deterministic and picks the right section.
const RESIDENTIAL_ENERGY_ANCHORS: [string, number][] = [
  ["low-rise residential", 4],
  ["dwelling unit", 3],
  ["fenestration", 3],
  ["u-factor", 2],
  ["insulation", 2],
  ["mandatory", 1],
];
const NONRES_ENERGY_ANCHORS = ["school", "nonresidential", "metal building", "covered process", "high-rise"];

// A residential low-rise energy section number: 150.x (prescriptive/mandatory
// envelope + systems) or 110.x (mandatory measures) - the sections an ADU or
// house is actually held to.
const RES_SECTION_RE = /\b1(?:50|10)\.\d/;

function scoreResidentialEnergy(c: CodeChunk): number {
  const label = `${c.section} ${c.citation ?? ""}`.toLowerCase();
  const body = c.text.toLowerCase();
  const t = `${label} ${body}`;
  let s = 0;
  // The citation field carrying a real residential section number dominates -
  // it is what the report shows and what the reviewer looks up.
  if (RES_SECTION_RE.test(label)) s += 10;
  else if (!/\d/.test(c.section)) s -= 4; // vague ALL-CAPS table header, no number
  for (const [k, w] of RESIDENTIAL_ENERGY_ANCHORS) if (t.includes(k)) s += w;
  for (const k of NONRES_ENERGY_ANCHORS) if (t.includes(k)) s -= 6;
  // Prefer a chunk with enough text to be a real provision, not a stray caption.
  if (c.text.length < 120) s -= 3;
  return s;
}

/** Best low-rise-residential energy provision in the city's Title 24 Part 6 corpus. */
function pickResidentialEnergyChunk(citySlug: string): CodeChunk | null {
  const corpus = loadCityChunks(citySlug);
  if (!corpus?.length) return null;
  let best: CodeChunk | null = null;
  let bestScore = 0; // strictly positive, so an off-topic chunk is never cited
  for (const c of corpus) {
    if (c.category !== "energy") continue;
    const s = scoreResidentialEnergy(c);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

/**
 * Title 24 Part 6 (California Energy Code) compliance finding.
 *
 * Energy compliance applies to essentially every conditioned residential
 * project, but it is demonstrated by a signed CF1R Certificate of Compliance
 * plus mandatory-measures notes on the plans - not by a single dimension on the
 * drawing. So this is an honest NEEDS_REVIEW that cites the governing Energy
 * Code provision (retrieved from the ingested Title 24 Part 6 corpus) and
 * reports whether the energy documentation was actually found in the set.
 * `docTypes` is the per-sheet vision classification ("energy_title24").
 */
export async function buildEnergyComplianceFinding(
  project: Project,
  facts: PlanFact[],
  citySlug: string,
  docTypes: string[] = []
): Promise<Finding> {
  const hay = `${planHaystack(facts)} ${docTypes.join(" ")}`;
  const energyDocPresent =
    docTypes.includes("energy_title24") || ENERGY_DOC_TERMS.some((t) => hay.includes(t));

  // Governing residential energy provision from the Title 24 Part 6 corpus.
  // Deterministic residential pick first (the fuzzy retriever mis-cites the
  // school-buildings table); fall back to hybrid retrieval, then to a generic
  // but always-correct part-level citation.
  const chunk =
    pickResidentialEnergyChunk(citySlug) ??
    (await retrieveCodeHybrid("energyTitle24", project.projectType, citySlug, "energy", false));
  const section = chunk?.citation ?? chunk?.section ?? "California Energy Code (Title 24, Part 6), Sec. 150.0-150.2";

  const required =
    "Title 24 Part 6 (California Energy Code) governs the conditioned space in this project. " +
    "Compliance is shown with a signed CF1R Certificate of Compliance and mandatory-measures notes on the plans, " +
    "covering envelope insulation, fenestration (U-factor / SHGC), HVAC, water heating, and lighting.";
  const message = energyDocPresent
    ? `${required} Energy documentation was detected in the set - confirm the CF1R matches the as-designed envelope and that the mandatory measures appear on the drawings. Verify against ${section}.`
    : `${required} No CF1R energy report or mandatory-measures notes were detected in the plan set; these are typically required at submittal. Verify against ${section}.`;

  return {
    id: "f_energyTitle24",
    ruleKey: "energyTitle24",
    title: "Title 24 energy compliance (Part 6)",
    status: "NEEDS_REVIEW",
    message,
    sourceRef: chunk?.sourceId,
    codeSection: section,
    codeText: chunk?.text,
    sheet: facts.find((f) => f.key !== "sheets" && f.key !== "docTypes")?.sheet,
  };
}
