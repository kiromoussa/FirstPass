"use client";

import type { PlanFact } from "@/lib/types";
import { factsForDisplay } from "@/lib/plan-facts-display";

export function FactsList({
  facts,
  projectType = "detached_adu",
}: {
  facts: PlanFact[];
  projectType?: string;
}) {
  const shown = factsForDisplay(facts, projectType);
  if (shown.length === 0) {
    return <div className="text-sm text-faint px-1 py-4">No facts extracted yet.</div>;
  }
  return (
    <div className="space-y-2">
      {shown.map((f) => (
        <div key={f.key} className="rounded-lg border border-ink-700 bg-ink-800/40 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-sm text-body">{f.label}</span>
            <span className="text-sm font-mono text-ink">
              {f.value}
              {f.unit && f.unit !== "docs" ? ` ${f.unit}` : ""}
            </span>
          </div>
          <div className="flex items-center justify-between mt-1">
            <span className="text-[11px] text-faint">{f.sheet ? `sheet ${f.sheet}` : "plan set"}</span>
            <span className="text-[11px] text-faint">{Math.round(f.confidence * 100)}% confidence</span>
          </div>
        </div>
      ))}
    </div>
  );
}
