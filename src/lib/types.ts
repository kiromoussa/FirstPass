// FirstPass — shared domain types (see PLAN.md §8 Data Model)

export type Phase =
  | "created"
  | "jurisdiction"
  | "research"
  | "read"
  | "comply"
  | "review"
  | "report"
  | "done"
  | "error";

export const PHASES: { key: Phase; label: string }[] = [
  { key: "jurisdiction", label: "Jurisdiction" },
  { key: "research", label: "Research" },
  { key: "read", label: "Plan Reading" },
  { key: "comply", label: "Compliance" },
  { key: "review", label: "Review" },
  { key: "report", label: "Report" },
];

export type FindingStatus = "PASS" | "FAIL" | "WARNING" | "NEEDS_REVIEW";

export type AgentName =
  | "orchestrator"
  | "jurisdiction"
  | "research"
  | "plan-reader"
  | "compliance"
  | "reviewer"
  | "checklist"
  | "report";

export type Sponsor = "claude" | "browserbase" | "redis" | "arize" | "band";

export type MessageType =
  | "info"
  | "finding"
  | "disagreement"
  | "retry"
  | "done";

export interface AgentMessage {
  id: string;
  ts: number;
  from: AgentName;
  to?: AgentName;
  type: MessageType;
  text: string;
  sponsor?: Sponsor; // which sponsor "lit up" producing this message
  refs?: string[]; // finding/source ids
}

// A message read back from the REAL Band collaboration room (GET
// /chats/{id}/messages). Unlike AgentMessage (the local synthetic feed the
// pipeline emits), these are the actual posts the registered Band research
// agents — and the human owner — make in the room, surfaced so the run can be
// double-checked against what the agents truly said.
export interface BandRoomMessage {
  id: string;
  author: string;
  content: string;
  ts: number;
  kind: "agent" | "human" | "orchestrator";
  /** Which firm chat this message belongs to (1–3). */
  chatLabel?: string;
}

// Project subtype — drives rule applicability and agent prompts. ADU is one
// supported type among residential, commercial, and renovation work.
export type ProjectType =
  | "single_family"
  | "multi_family"
  | "commercial"
  | "tenant_improvement"
  | "renovation"
  | "mixed_use"
  | "detached_adu"
  | "attached_adu";

export const DEFAULT_PROJECT_TYPE: ProjectType = "single_family";

export const PROJECT_TYPES: { value: ProjectType; label: string }[] = [
  { value: "single_family", label: "Single-family residential" },
  { value: "multi_family", label: "Multi-family / apartments" },
  { value: "commercial", label: "Commercial" },
  { value: "tenant_improvement", label: "Tenant improvement" },
  { value: "renovation", label: "Renovation / addition" },
  { value: "mixed_use", label: "Mixed-use" },
  { value: "detached_adu", label: "Detached ADU" },
  { value: "attached_adu", label: "Attached ADU" },
];

export function projectTypeLabel(type: ProjectType | string | undefined): string {
  return PROJECT_TYPES.find((t) => t.value === type)?.label ?? "Architecture project";
}

export interface Project {
  id: string;
  name: string;
  address: string;
  projectType: ProjectType;
  jurisdictionId: string;
  citySlug?: string; // data/cities/<slug> corpus to run against (default alameda-ca)
  status: Phase;
  createdAt: number;
  score?: number;
  pdfName?: string;
  dwgName?: string;
  /** Staged DWG on disk, e.g. projects/{id}/plan.dwg */
  dwgPath?: string;
  apsUrn?: string; // Autodesk Model Derivative URN for the translated DWG
  /** Band chat room id when a run opened a collaboration room. */
  bandRoomId?: string;
  // A plan set (PDF/image) was uploaded for native Claude-vision reading; bytes
  // live in the store under `plan:<id>`. This is the accurate fact source.
  planMime?: string;
}

export interface Source {
  id: string; // hash of url
  url: string;
  title: string;
  excerpt: string;
  retrievedAt: number;
  authorityScore: number; // 0..1, official-domain signal
  jurId: string;
  live: boolean; // true = fetched live this run, false = served from cache
}

// Units the compliance engine understands. Length in ft, area in sqft, lot
// coverage as a percentage, floor-area ratio as a bare ratio, parking in spaces,
// dwelling counts in units, and document presence in docs.
export type Unit = "ft" | "sqft" | "pct" | "far" | "spaces" | "units" | "docs";

export interface Rule {
  key: string; // maxSize | height | setbackFront/Rear/Side | lotCoverage | far | parking | requiredDocs
  label: string;
  appliesTo: ProjectType | "any";
  operator: "<=" | ">=" | "present";
  threshold: number | null;
  unit: Unit | null;
  sourceId: string;
  description: string;
}

export interface PlanFact {
  key: string; // unitSize | height | setbackFront/Rear/Side | lotCoverage | far | parking | dwellingUnits | sheets
  label: string;
  value: number | string | string[] | null;
  unit: Unit | null;
  sheet: string; // e.g. "A-2"
  bbox: [number, number, number, number] | null; // normalized [x,y,w,h] 0..1
  confidence: number; // 0..1
  raw?: string;
  // Set only when the plan READER itself failed (token-budget truncation,
  // refusal, API/parse error) rather than the dimension simply not being shown.
  // Lets the UI say WHY a value is missing instead of a blanket "couldn't read".
  readError?: string;
}

export interface EvalResult {
  dimension: "citation" | "authority" | "applicability" | "hallucination";
  score: number; // 0..1
  passed: boolean;
  rationale: string;
}

export interface Finding {
  id: string;
  ruleKey: string;
  title: string;
  status: FindingStatus;
  message: string;
  suggestedCorrection?: string;
  factRef?: string;
  ruleRef?: string;
  sourceRef?: string;
  bbox?: [number, number, number, number] | null;
  sheet?: string;
  evals?: EvalResult[];
  corrected?: boolean; // flipped after reviewer correction
  previousStatus?: FindingStatus;
  codeSection?: string; // retrieved code chunk section (RAG)
  codeText?: string; // retrieved code chunk text (RAG)
}

export interface ChecklistItem {
  item: string;
  required: boolean;
  present: boolean | null;
  note?: string;
}

export interface ReportSection {
  heading: string;
  status?: FindingStatus;
  body: string;
  citationSourceId?: string;
}

export interface Report {
  projectId: string;
  score: number;
  summary: string;
  sections: ReportSection[];
  generatedAt: number;
  disclaimer: string;
}

// Full project snapshot returned to the UI
export interface ProjectState {
  project: Project;
  sources: Source[];
  rules: Rule[];
  facts: PlanFact[];
  findings: Finding[];
  checklist: ChecklistItem[];
  messages: AgentMessage[];
  report?: Report;
  /** Real Band collaboration room opened for this run. */
  bandRoomId?: string | null;
  /** Live transcript — actual agent-to-agent posts from Band. */
  bandTranscript?: BandRoomMessage[];
}

export const DISCLAIMER =
  "FirstPass is a pre-submission compliance assistant, not an official permit review. " +
  "Findings indicate likely issues for early correction and require confirmation by a " +
  "licensed professional and the governing jurisdiction. FirstPass does not approve, " +
  "certify, or guarantee permit approval.";
