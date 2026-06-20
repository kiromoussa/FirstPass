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

export interface Project {
  id: string;
  name: string;
  address: string;
  projectType: "detached_adu";
  jurisdictionId: string;
  status: Phase;
  createdAt: number;
  score?: number;
  pdfName?: string;
  dwgName?: string;
  apsUrn?: string; // Autodesk Model Derivative URN for the translated DWG
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

export interface Rule {
  key: string; // maxSize | height | setbackRear | setbackSide | requiredDocs
  label: string;
  appliesTo: "detached_adu" | "attached_adu" | "any";
  operator: "<=" | ">=" | "present";
  threshold: number | null;
  unit: "ft" | "sqft" | "docs" | null;
  sourceId: string;
  description: string;
}

export interface PlanFact {
  key: string; // unitSize | height | setbackRear | setbackSide | sheets
  label: string;
  value: number | string | string[] | null;
  unit: "ft" | "sqft" | "docs" | null;
  sheet: string; // e.g. "A-2"
  bbox: [number, number, number, number] | null; // normalized [x,y,w,h] 0..1
  confidence: number; // 0..1
  raw?: string;
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
}

export const DISCLAIMER =
  "FirstPass is a pre-submission compliance assistant, not an official permit review. " +
  "Findings indicate likely issues for early correction and require confirmation by a " +
  "licensed professional and the governing jurisdiction. FirstPass does not approve, " +
  "certify, or guarantee permit approval.";
