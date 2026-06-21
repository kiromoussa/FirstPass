"use client";

import { useEffect, useRef, useState } from "react";

// Live view of the Redis multi-agent blackboard (project:{id}:blackboard). The
// Python Band agents publish each research artifact here as they finish, and
// every downstream agent reads from it instead of re-opening output/*.txt. This
// panel makes that shared memory visible in the dashboard — the heart of the
// "Redis as the firm's brain, not a cache" story (docs/REDIS_PLAN.md §7).

interface Artifact {
  field: string;
  text: string;
  at: string | null;
  chars: number;
}

// Friendly labels for the known artifact fields (write order ≈ workflow order).
const LABELS: Record<string, string> = {
  planner_brief: "Planner brief",
  municipal_codes: "Municipal code research",
  state_codes: "State code research",
  visual_analysis: "Visual plan analysis",
  plan_vs_code: "Plan vs. code comparison",
  final_summary: "Synthesized summary",
  permit_report: "Permit checklist",
};

export function BlackboardPanel({ projectId }: { projectId: string }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const r = await fetch(`/api/projects/${projectId}/blackboard`);
        const j = await r.json();
        if (!cancelled) setArtifacts(j.artifacts ?? []);
      } catch {
        /* keep last good state */
      }
      if (!cancelled) timer.current = setTimeout(poll, 4000);
    }
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
    };
  }, [projectId]);

  if (artifacts.length === 0) {
    return (
      <div className="text-[11px] text-slate-600 leading-relaxed">
        Waiting for agents to publish to Redis…
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {artifacts.map((a) => {
        const isOpen = open === a.field;
        return (
          <div key={a.field} className="rounded-md border border-ink-700 bg-ink-800/60">
            <button
              onClick={() => setOpen(isOpen ? null : a.field)}
              className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left"
            >
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                <span className="text-[11px] text-slate-200 truncate">
                  {LABELS[a.field] ?? a.field}
                </span>
              </span>
              <span className="text-[9px] font-mono text-slate-500 flex-shrink-0">
                {(a.chars / 1000).toFixed(1)}k
              </span>
            </button>
            {isOpen && (
              <pre className="max-h-48 overflow-y-auto scrollbar-thin whitespace-pre-wrap break-words text-[10px] leading-relaxed text-slate-400 px-2.5 pb-2 font-mono">
                {a.text.slice(0, 4000)}
                {a.text.length > 4000 ? "\n…" : ""}
              </pre>
            )}
          </div>
        );
      })}
      <div className="text-[9px] text-slate-600 pt-0.5">
        ↑ read from Redis · shared across all agents
      </div>
    </div>
  );
}
