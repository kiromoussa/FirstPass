"use client";

import type { PlanFact } from "@/lib/types";

export function FactsList({ facts }: { facts: PlanFact[] }) {
  const shown = facts.filter((f) => f.key !== "sheets");
  if (shown.length === 0) {
    return <div className="text-sm text-slate-600 px-1 py-4">No facts extracted yet.</div>;
  }
  return (
    <div className="space-y-2">
      {shown.map((f) => (
        <div key={f.key} className="rounded-lg border border-ink-700 bg-ink-800/40 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-300">{f.label}</span>
            <span className="text-sm font-mono text-white">
              {String(f.value)}
              {f.unit && f.unit !== "docs" ? ` ${f.unit}` : ""}
            </span>
          </div>
          <div className="flex items-center justify-between mt-1">
            <span className="text-[11px] text-slate-600">sheet {f.sheet}</span>
            <span className="text-[11px] text-slate-600">{Math.round(f.confidence * 100)}% confidence</span>
          </div>
        </div>
      ))}
    </div>
  );
}
