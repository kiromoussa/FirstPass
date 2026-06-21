"use client";

import { useEffect, useRef, useState } from "react";

interface Meta {
  status: "ready" | "failed" | "pending";
  sheets: { name: string }[];
  reason?: string;
}

// Shows the DWG plan set the way the app actually reads it: the per-sheet PDFs
// plotted by Autodesk Design Automation (real AutoCAD), rendered to PNG by the
// pipeline and served from `/api/plans/render`. This replaces the Model
// Derivative SVF2 viewer, which throws "we can't display this item" on most DWG
// plan sets. While the pipeline is still plotting, polls until the sheets land.
export function PlanSheetViewer({ projectId }: { projectId: string }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [active, setActive] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const m: Meta = await fetch(
          `/api/plans/render?projectId=${encodeURIComponent(projectId)}`
        ).then((r) => r.json());
        if (cancelled) return;
        setMeta(m);
        if (m.status === "pending") timer.current = setTimeout(poll, 3000);
      } catch {
        if (!cancelled) timer.current = setTimeout(poll, 4000);
      }
    }
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
    };
  }, [projectId]);

  const ready = meta?.status === "ready" && meta.sheets.length > 0;
  const failed = meta?.status === "failed" || (meta?.status === "ready" && meta.sheets.length === 0);
  const sheet = ready ? meta!.sheets[Math.min(active, meta!.sheets.length - 1)] : null;

  return (
    <div className="relative w-full aspect-[4/3] rounded-xl overflow-hidden border border-ink-700 bg-ink-900">
      {ready ? (
        <div className="absolute inset-0 flex flex-col">
          <div className="flex-1 min-h-0 bg-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/plans/render?projectId=${encodeURIComponent(projectId)}&i=${Math.min(
                active,
                meta!.sheets.length - 1
              )}`}
              alt={sheet?.name ?? "Plan sheet"}
              className="w-full h-full object-contain"
            />
          </div>
          {meta!.sheets.length > 1 && (
            <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-thin px-3 py-2 bg-ink-900 border-t border-ink-700">
              {meta!.sheets.map((s, i) => (
                <button
                  key={i}
                  onClick={() => setActive(i)}
                  className={`text-[10px] font-mono whitespace-nowrap px-2 py-1 rounded ${
                    i === active ? "bg-accent text-ink-900" : "text-blue-200/70 hover:text-blue-100 bg-ink-700/60"
                  }`}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center blueprint-grid text-sm text-blue-200/80 px-6 text-center">
          {failed ? (
            <span className="text-flag-warn">
              Sheet preview unavailable — the findings below are still accurate.
            </span>
          ) : (
            <>
              <span className="pulse w-3 h-3 rounded-full bg-accent mb-3" />
              <span>Plotting DWG sheets with Autodesk (AutoCAD cloud)…</span>
            </>
          )}
        </div>
      )}
      <div className="absolute top-3 left-3 text-[10px] text-blue-200/70 font-mono pointer-events-none">
        {ready && sheet ? `AUTODESK · ${sheet.name}` : "AUTODESK APS · DESIGN AUTOMATION"}
      </div>
    </div>
  );
}
