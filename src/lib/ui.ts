import type { FindingStatus, Sponsor, MessageType, AgentName } from "./types";

export const STATUS_META: Record<
  FindingStatus,
  { label: string; color: string; bg: string; border: string }
> = {
  PASS: { label: "Pass", color: "#1f8a4c", bg: "#eef7f0", border: "#d8ecdd" },
  FAIL: { label: "Likely violation", color: "#c2410c", bg: "#fdf0e9", border: "#f3dccf" },
  WARNING: { label: "Warning", color: "#b07a09", bg: "#fbf4e3", border: "#efe2bd" },
  NEEDS_REVIEW: { label: "Needs review", color: "#6E56CF", bg: "#eeebfb", border: "#d9d2f5" },
};

export const SPONSOR_META: Record<Sponsor, { label: string; color: string }> = {
  claude: { label: "Claude", color: "#c15f3c" },
  browserbase: { label: "Browserbase", color: "#b45309" },
  redis: { label: "Redis", color: "#c2410c" },
  arize: { label: "Arize", color: "#2563eb" },
  band: { label: "Band", color: "#6E56CF" },
};

export const AGENT_META: Record<AgentName, { label: string; emoji: string }> = {
  orchestrator: { label: "Orchestrator", emoji: "◆" },
  jurisdiction: { label: "Jurisdiction", emoji: "📍" },
  research: { label: "Code Research", emoji: "🔎" },
  "plan-reader": { label: "Plan Reader", emoji: "📐" },
  compliance: { label: "Compliance", emoji: "⚖️" },
  reviewer: { label: "Reviewer", emoji: "🧪" },
  checklist: { label: "Checklist", emoji: "✅" },
  report: { label: "Report", emoji: "📄" },
};

export const MSG_META: Record<MessageType, { color: string; label: string }> = {
  info: { color: "#6b7280", label: "info" },
  finding: { color: "#1f8a4c", label: "finding" },
  disagreement: { color: "#c2410c", label: "disagreement" },
  retry: { color: "#b07a09", label: "retry" },
  done: { color: "#2563eb", label: "done" },
};

export function scoreColor(score: number): string {
  if (score >= 80) return "#1f8a4c";
  if (score >= 55) return "#b07a09";
  return "#c2410c";
}
