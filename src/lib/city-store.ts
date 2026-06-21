// Runtime city ingestion + durable storage.
//
// The Python chunker (scripts/chunk_codes.py) is the build-time tool: it runs
// locally and its output is committed. But it can't run inside a serverless
// function (no Python, read-only filesystem). So for ingestion AT RUNTIME we
// chunk here in TypeScript and persist the result to Redis via code-db's durable
// store — which is the same place retrieveCode() reads from. That makes a city
// ingested through POST /api/cities/ingest survive on Vercel, where the
// filesystem is ephemeral.
//
// This intentionally mirrors the core of chunk_codes.py (section split, category,
// topic inference, contextual header). The Python version stays the richer,
// canonical chunker for committed corpora; this is the portable runtime path.
import type { CodeChunk, CityMeta } from "./code-db";

const MAX_CHARS = 1100;

// Topic keys (mirror chunk_codes.py RULE_KEYWORDS).
const RULE_KEYWORDS: [string, string[]][] = [
  ["maxSize", ["unit size", "floor area", "square feet", "square foot", "conditioned space"]],
  ["unitSize", ["unit size", "floor area", "conditioned space"]],
  ["height", ["height", "feet in height", "roof pitch"]],
  ["setbackSide", ["side setback", "side yard"]],
  ["setbackRear", ["rear setback", "rear yard"]],
  ["requiredDocs", ["site plan", "plot plan", "floor plan", "elevation", "title-24", "submittal", "checklist", "application"]],
  ["waterEfficiency", ["water closet", "gallons per", "gpf", "gpm", "water conserving", "flow rate", "lavatory"]],
  ["smokeAlarm", ["smoke alarm", "carbon monoxide"]],
  ["egress", ["egress", "emergency escape", "exit discharge", "means of egress"]],
  ["fireProtection", ["sprinkler", "fire-resistance", "fire resistance", "fire separation"]],
  ["ventilation", ["ventilation", "mechanical ventilation", "exhaust"]],
  ["evCharging", ["electric vehicle", "ev charging", "ev capable", "ev ready"]],
  ["solar", ["photovoltaic", "solar"]],
  ["occupancy", ["occupancy", "occupant load"]],
];

const CATEGORY_RULES: [string, string[]][] = [
  ["green", ["green", "calgreen"]],
  ["energy", ["energy", "title24", "title-24"]],
  ["plumbing", ["plumb", "cpc"]],
  ["mechanical", ["mechanical", "cmc"]],
  ["electrical", ["electrical", "cec"]],
  ["fire", ["fire", "cfc"]],
  ["residential", ["residential", "crc"]],
  ["building", ["building", "cbc"]],
  ["county", ["county"]],
  ["state", ["state", "hcd"]],
  ["city", ["city", "municipal", "zoning", "lamc", "local"]],
];

const CATEGORY_LABELS: Record<string, string> = {
  green: "Green building standards (CALGreen)",
  energy: "Energy code (Title 24)",
  plumbing: "Plumbing code (CPC)",
  mechanical: "Mechanical code (CMC)",
  electrical: "Electrical code (CEC)",
  fire: "Fire code (CFC)",
  residential: "Residential code (CRC)",
  building: "Building code (CBC)",
  county: "County code",
  state: "State code",
  city: "City / municipal code",
  general: "Code",
};

const MD_HEAD = /^#{2,4}\s+(.*?)\s*$/;
const SOURCE_RE = /\[([A-Za-z0-9_-]+)\]\s*$/;
const KEYWORD_HEAD = /^\s*(SEC\.|SECTION|ARTICLE|CHAPTER|DIVISION|TITLE|APPENDIX|PART)\b/i;
const NUM_HEAD = /^\s*§?\s*[A-Z]?\d+[\w()-]*[.\-(][\w.\-()]*(\s+[A-Z]\.\d[\w.\-()]*)?\s+\S/;
const ALLCAPS_HEAD = /^[A-Z0-9][A-Z0-9 ,.&/()\-§'']{6,}$/;

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function detectCategory(name: string): string {
  const s = name.toLowerCase();
  for (const [cat, kws] of CATEGORY_RULES) if (kws.some((k) => s.includes(k))) return cat;
  return "general";
}

function isLegalHeading(line: string): boolean {
  const s = line.trim();
  if (!s || s.length > 100) return false;
  if (KEYWORD_HEAD.test(s) || NUM_HEAD.test(s)) return true;
  return ALLCAPS_HEAD.test(s) && /[A-Za-z]/.test(s);
}

function inferTopics(section: string, body: string): string[] {
  const match = (t: string) =>
    RULE_KEYWORDS.filter(([, kws]) => kws.some((k) => t.toLowerCase().includes(k))).map(([key]) => key);
  let topics = match(section);
  if (topics.length === 0) topics = match(`${section}\n${body}`);
  if (topics.includes("height") && `${section}\n${body}`.toLowerCase().includes("attached")) topics.push("attached");
  return topics;
}

function splitBody(body: string): string[] {
  body = body.trim();
  if (body.length <= MAX_CHARS) return body ? [body] : [];
  const units = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const u of units) {
    if (!cur) cur = u;
    else if (cur.length + 1 + u.length <= MAX_CHARS) cur = `${cur} ${u}`;
    else { out.push(cur); cur = u; }
  }
  if (cur) out.push(cur);
  return out;
}

interface Section { header: string; source: string; body: string }

// A short citation label from a heading line (up to the first sentence/colon, or
// ~80 chars) — used when the provision text shares the heading line.
function shortCitation(line: string): string {
  const m = line.match(/^(.{0,80}?[.:])(\s|$)/);
  return (m ? m[1] : line.slice(0, 80)).trim();
}

function parseSections(text: string, defaultSource: string): Section[] {
  const lines = text.split("\n");
  const curated = lines.some((l) => MD_HEAD.test(l));
  const sections: Section[] = [];
  let header: string | null = null;
  let source = "";
  let buf: string[] = [];
  const flush = () => { if (header !== null) sections.push({ header, source, body: buf.join("\n").trim() }); };
  for (const line of lines) {
    const md = line.match(MD_HEAD);
    const isHead = curated ? !!md : isLegalHeading(line);
    if (isHead) {
      flush();
      const raw = (md ? md[1] : line).trim();
      const sm = raw.match(SOURCE_RE);
      source = sm ? sm[1] : defaultSource;
      const clean = raw.replace(SOURCE_RE, "").trim();
      if (curated) {
        // ### header is a clean label; the provision is the lines beneath it.
        header = clean;
        buf = [];
      } else {
        // Scrape mode: the heading line itself carries the provision text
        // ("R305.1 Minimum ceiling height. Habitable space shall…"), so keep it
        // as content and derive a short citation for the label.
        header = shortCitation(clean);
        buf = [clean];
      }
    } else if (header !== null) {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

export interface IngestDoc { name: string; content: string }

// Chunk raw research documents into CodeChunk[] — the TS counterpart of
// scripts/chunk_codes.py, for runtime ingestion.
export function chunkDocuments(slug: string, docs: IngestDoc[], meta: CityMeta): CodeChunk[] {
  const place = [meta.city, meta.state].filter(Boolean).join(", ") || slug;
  const rawSources = meta.rawSources ?? {};
  const firstSource = meta.sources?.[0]?.id ?? "";
  const chunks: CodeChunk[] = [];
  for (const doc of docs) {
    const category = detectCategory(doc.name.replace(/\.[^.]*$/, ""));
    const label = CATEGORY_LABELS[category] ?? "Code";
    const defaultSource = rawSources[doc.name] ?? firstSource;
    for (const sec of parseSections(doc.content, defaultSource)) {
      // Drop bare titles / OCR fragments — a real provision has substance.
      const parts = splitBody(sec.body).filter((p) => p.length >= 35);
      const base = slugify(sec.header) || slugify(doc.name);
      const topics = inferTopics(sec.header, sec.body);
      const context = `${place} · ${label} · ${sec.header}`;
      parts.forEach((part, i) => {
        const id = parts.length > 1 ? `${slug}-${category}-${base}-${i}` : `${slug}-${category}-${base}`;
        chunks.push({
          id,
          category,
          section: sec.header,
          topics,
          text: part,
          sourceId: sec.source,
          citation: sec.header,
          context,
          tokensEst: Math.max(1, Math.floor(part.length / 4)),
        });
      });
    }
  }
  return chunks;
}
