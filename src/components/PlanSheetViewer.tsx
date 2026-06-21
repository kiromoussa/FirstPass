"use client";

import { useEffect, useRef, useState } from "react";

interface Meta {
  status: "ready" | "failed" | "pending";
  sheets: { name: string }[];
  reason?: string;
}

// Shows plan sheets from the durable project store (bundled demo cache or prior APS plot).
export function PlanSheetViewer({ projectId }: { projectId: string }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [active, setActive] = useState(0);
  const [statusLine, setStatusLine] = useState("Loading plan sheets…");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let plotKickoff = false;

    async function kickoffPlot() {
      if (plotKickoff) return;
      plotKickoff = true;
      try {
        await fetch(`/api/plans/plot?projectId=${encodeURIComponent(projectId)}`, {
          method: "POST",
        });
      } catch {
        /* polling will retry */
      }
    }

    async function load() {
      try {
        const m: Meta = await fetch(
          `/api/plans/render?projectId=${encodeURIComponent(projectId)}`
        ).then((r) => r.json());
        if (cancelled) return;
        setMeta(m);

        if (m.status === "ready" && m.sheets.length > 0) {
          setStatusLine("");
          return;
        }
        if (m.status === "failed") {
          setStatusLine(m.reason ?? "Sheet preview unavailable");
          return;
        }
        setStatusLine("Plotting plan sheets with Autodesk…");
        void kickoffPlot();
        timer.current = setTimeout(load, 1500);
      } catch {
        if (!cancelled) timer.current = setTimeout(load, 2000);
      }
    }

    // No persistent "started" ref: under React Strict Mode the effect runs
    // mount→cleanup→mount, and a ref guard would skip the second load() call,
    // leaving the viewer stuck on "Loading plan sheets…".
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
    };
  }, [projectId]);

  const ready = meta?.status === "ready" && meta.sheets.length > 0;
  const failed = meta?.status === "failed" || (meta?.status === "ready" && meta.sheets.length === 0);
  const sheet = ready ? meta!.sheets[Math.min(active, meta!.sheets.length - 1)] : null;

  return (
    <div className="relative w-full aspect-[4/3] rounded-xl overflow-hidden border border-ink-700 blueprint-grid">
      {ready ? (
        <div className="absolute inset-0 flex flex-col">
          <div className="relative flex-1 min-h-0 blueprint-grid">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/plans/render?projectId=${encodeURIComponent(projectId)}&i=${Math.min(
                active,
                meta!.sheets.length - 1
              )}&v=2`}
              alt={sheet?.name ?? "Plan sheet"}
              className="w-full h-full object-contain"
              draggable={false}
            />
            {meta!.sheets.length > 1 && (
              <>
                <button
                  type="button"
                  aria-label="Previous sheet"
                  onClick={() => setActive((i) => Math.max(0, i - 1))}
                  disabled={active <= 0}
                  className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/60 hover:bg-black/80 text-white text-lg flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed transition"
                >
                  ‹
                </button>
                <button
                  type="button"
                  aria-label="Next sheet"
                  onClick={() => setActive((i) => Math.min(meta!.sheets.length - 1, i + 1))}
                  disabled={active >= meta!.sheets.length - 1}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/60 hover:bg-black/80 text-white text-lg flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed transition"
                >
                  ›
                </button>
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[10px] font-mono text-white/90 bg-black/60 rounded-full px-2 py-0.5 pointer-events-none">
                  {Math.min(active, meta!.sheets.length - 1) + 1} / {meta!.sheets.length}
                </div>
              </>
            )}
          </div>
          {meta!.sheets.length > 1 && (
            <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-thin px-3 py-2 bg-deep-800 border-t border-ink-700">
              {meta!.sheets.map((s, i) => (
                <button
                  key={i}
                  onClick={() => setActive(i)}
                  className={`text-[10px] font-mono whitespace-nowrap px-2 py-1 rounded ${
                    i === active ? "bg-accent text-white" : "text-muted hover:text-ink bg-ink-700"
                  }`}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center blueprint-grid text-sm text-blue-200/80 px-6 text-center gap-2">
          {failed ? (
            <span className="text-flag-warn max-w-md">{statusLine}</span>
          ) : (
            <>
              <span className="pulse w-3 h-3 rounded-full bg-accent mb-1" />
              <span>{statusLine}</span>
            </>
          )}
        </div>
      )}
      <div className="absolute top-3 left-3 text-[10px] text-blue-200/70 font-mono pointer-events-none bg-[#0d2235]/80 rounded px-1.5 py-0.5">
        {ready && sheet ? sheet.name : "PLAN SHEETS"}
      </div>
    </div>
  );
}
