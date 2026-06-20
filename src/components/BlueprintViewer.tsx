"use client";

import type { Finding } from "@/lib/types";
import { STATUS_META } from "@/lib/ui";

export function BlueprintViewer({
  findings,
  selectedId,
  onSelect,
}: {
  findings: Finding[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const overlays = findings.filter((f) => f.bbox);
  return (
    <div className="relative w-full aspect-[4/3] rounded-xl overflow-hidden border border-ink-700 blueprint-grid">
      {/* faux sheet title block */}
      <div className="absolute top-3 left-3 text-[10px] text-blue-200/70 font-mono">
        ADU PLAN SET · ALAMEDA, CA · SHEETS A-1…A-3
      </div>
      <div className="absolute bottom-3 right-3 text-[10px] text-blue-200/50 font-mono">
        FirstPass overlay · click a region
      </div>

      {/* schematic strokes so it reads as a drawing */}
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 75" preserveAspectRatio="none">
        <rect x="8" y="10" width="60" height="45" fill="none" stroke="rgba(150,200,255,0.35)" strokeWidth="0.5" />
        <rect x="14" y="16" width="22" height="18" fill="none" stroke="rgba(150,200,255,0.25)" strokeWidth="0.4" />
        <rect x="40" y="16" width="22" height="18" fill="none" stroke="rgba(150,200,255,0.25)" strokeWidth="0.4" />
        <line x1="8" y1="40" x2="68" y2="40" stroke="rgba(150,200,255,0.2)" strokeWidth="0.4" />
      </svg>

      {overlays.map((f) => {
        const [x, y, w, h] = f.bbox!;
        const meta = STATUS_META[f.status];
        const active = selectedId === f.id;
        return (
          <button
            key={f.id}
            onClick={() => onSelect(f.id)}
            className="absolute group"
            style={{
              left: `${x * 100}%`,
              top: `${y * 100}%`,
              width: `${w * 100}%`,
              height: `${h * 100}%`,
            }}
          >
            <span
              className={`absolute inset-0 rounded-md border-2 transition-all ${active ? "pulse" : ""}`}
              style={{
                borderColor: meta.color,
                background: active ? meta.bg : "transparent",
                boxShadow: active ? `0 0 0 2px ${meta.color}` : undefined,
              }}
            />
            <span
              className="absolute -top-5 left-0 text-[9px] px-1.5 py-0.5 rounded whitespace-nowrap font-medium"
              style={{ color: "#0a0e14", background: meta.color }}
            >
              {f.title} · {f.sheet}
            </span>
          </button>
        );
      })}
    </div>
  );
}
