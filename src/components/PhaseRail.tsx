"use client";

import { PHASES, type Phase } from "@/lib/types";

const ORDER: Phase[] = ["jurisdiction", "research", "read", "comply", "review", "report", "done"];

export function PhaseRail({ status }: { status: Phase }) {
  const current = ORDER.indexOf(status);
  return (
    <div className="space-y-1">
      {PHASES.map((p) => {
        const idx = ORDER.indexOf(p.key);
        const state = current > idx || status === "done" ? "done" : current === idx ? "active" : "todo";
        return (
          <div key={p.key} className="flex items-center gap-3 py-1.5">
            <span
              className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                state === "done"
                  ? "bg-accent"
                  : state === "active"
                  ? "bg-accent pulse"
                  : "bg-ink-600"
              }`}
            />
            <span
              className={`text-sm ${
                state === "todo" ? "text-faint" : state === "active" ? "text-ink font-medium" : "text-body"
              }`}
            >
              {p.label}
            </span>
            {state === "active" && (
              <span className="text-[10px] text-accent ml-auto animate-pulse">working…</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
