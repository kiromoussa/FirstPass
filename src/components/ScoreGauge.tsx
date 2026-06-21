"use client";

import { scoreColor } from "@/lib/ui";

export function ScoreGauge({ score }: { score: number | undefined }) {
  const v = score ?? 0;
  const color = scoreColor(v);
  const r = 34;
  const c = 2 * Math.PI * r;
  const dash = (v / 100) * c;
  return (
    <div className="flex items-center gap-4">
      <div className="relative w-[86px] h-[86px]">
        <svg viewBox="0 0 80 80" className="w-full h-full -rotate-90">
          <circle cx="40" cy="40" r={r} fill="none" stroke="#1f2937" strokeWidth="8" />
          <circle
            cx="40"
            cy="40"
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${c}`}
            style={{ transition: "stroke-dasharray 0.8s ease, stroke 0.4s ease" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold" style={{ color }}>
            {score == null ? "—" : v}
          </span>
          <span className="text-[9px] text-slate-500 -mt-1">/ 100</span>
        </div>
      </div>
      <div>
        <div className="text-xs uppercase tracking-widest text-slate-500">Permit readiness</div>
        <div className="text-sm text-slate-300 mt-1">
          {score == null
            ? "Running checks…"
            : v >= 80
            ? "Strong — minor items only"
            : v >= 55
            ? "Needs attention before submission"
            : "Significant issues to resolve"}
        </div>
      </div>
    </div>
  );
}
