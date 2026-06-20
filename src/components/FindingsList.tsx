"use client";

import type { Finding } from "@/lib/types";
import { STATUS_META } from "@/lib/ui";

export function StatusPill({ status }: { status: Finding["status"] }) {
  const m = STATUS_META[status];
  return (
    <span
      className="text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap"
      style={{ color: m.color, background: m.bg, border: `1px solid ${m.border}` }}
    >
      {m.label}
    </span>
  );
}

export function FindingsList({
  findings,
  selectedId,
  onSelect,
}: {
  findings: Finding[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (findings.length === 0) {
    return <div className="text-sm text-slate-600 px-1 py-4">No findings yet.</div>;
  }
  return (
    <div className="space-y-2">
      {findings.map((f) => (
        <button
          key={f.id}
          onClick={() => onSelect(f.id)}
          className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
            selectedId === f.id ? "border-accent bg-ink-800" : "border-ink-700 bg-ink-800/40 hover:border-ink-600"
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-slate-200">{f.title}</span>
            <div className="flex items-center gap-1.5">
              {f.corrected && (
                <span className="text-[9px] text-accent" title="Corrected by Reviewer">✓ corrected</span>
              )}
              <StatusPill status={f.status} />
            </div>
          </div>
          <p className="text-xs text-slate-500 mt-1">{f.message}</p>
        </button>
      ))}
    </div>
  );
}
