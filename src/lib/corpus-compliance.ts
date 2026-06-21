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

async function retrieveTopicChunk(
  topic: CorpusTopic,
  project: Project,
  citySlug: string
): Promise<CodeChunk | null> {
  const appliesTo = project.projectType;
  const preferred = TOPIC_CATEGORY[topic];
  const tries = preferred
    ? [preferred, "city", "state", "building", "residential", "green", undefined]
    : [undefined, "city", "state", "building"];
  for (const cat of tries) {
    const chunk = await retrieveCodeHybrid(topic, appliesTo, citySlug, cat);
    if (chunk) return chunk;
  }
  return null;
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
