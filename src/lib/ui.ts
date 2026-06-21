import type { FindingStatus, Sponsor, MessageType, AgentName } from "./types";

export const STATUS_META: Record<
  FindingStatus,
  { label: string; color: string; bg: string; border: string }
> = {
  PASS: { label: "Pass", color: "#3ddc97", bg: "rgba(61,220,151,0.12)", border: "rgba(61,220,151,0.4)" },
  FAIL: { label: "Likely violation", color: "#ff5c5c", bg: "rgba(255,92,92,0.12)", border: "rgba(255,92,92,0.4)" },
  WARNING: { label: "Warning", color: "#ffb547", bg: "rgba(255,181,71,0.12)", border: "rgba(255,181,71,0.4)" },
  NEEDS_REVIEW: { label: "Needs review", color: "#5aa9ff", bg: "rgba(90,169,255,0.12)", border: "rgba(90,169,255,0.4)" },
};

export const SPONSOR_META: Record<Sponsor, { label: string; color: string }> = {
  claude: { label: "Claude", color: "#d97757" },
  browserbase: { label: "Browserbase", color: "#ffb547" },
  redis: { label: "Redis", color: "#ff5c5c" },
  arize: { label: "Arize", color: "#5aa9ff" },
  band: { label: "Band", color: "#a78bfa" },
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
  info: { color: "#8aa0b6", label: "info" },
  finding: { color: "#3ddc97", label: "finding" },
  disagreement: { color: "#ff5c5c", label: "disagreement" },
  retry: { color: "#ffb547", label: "retry" },
  done: { color: "#5aa9ff", label: "done" },
};

export function scoreColor(score: number): string {
  if (score >= 80) return "#3ddc97";
  if (score >= 55) return "#ffb547";
  return "#ff5c5c";
}
