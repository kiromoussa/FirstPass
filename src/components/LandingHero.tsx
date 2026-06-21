"use client";

import Link from "next/link";
import { CSSProperties, useEffect, useState } from "react";

const STAGES = [
  { num: "01", name: "Jurisdiction resolution", detail: "Resolving city & responsible agencies" },
  { num: "02", name: "Code research", detail: "Browsing municipal & state ADU codes, live" },
  { num: "03", name: "Plan reading", detail: "Extracting setbacks, heights, coverage" },
  { num: "04", name: "Compliance checks", detail: "Comparing plan facts to jurisdiction rules" },
  { num: "05", name: "Finding audit", detail: "Reviewer challenges & corrects findings" },
  { num: "06", name: "Report generation", detail: "Composing the cited readiness report" },
];

const FEED = [
  "Resolved jurisdiction · City of Oakland · CA HCD",
  "Fetched OakMC §17.103 ADU standards · retrieved today",
  "Read 14 sheets · extracted 9 structured facts",
  "Max unit size: 1,200 sf allowed vs 850 sf built · PASS",
  "Auditor re-checked height on sheet A-301 · WARNING",
  "Report composed · 4 findings · 1 missing document",
];

const RING_C = 2 * Math.PI * 52; // 326.73

const GREEN = "#1f8a4c";
const MUT = "#9aa093";
const DONE = "#3f7d57";
const LABELS: Record<string, string> = { done: "DONE", active: "RUNNING", pending: "QUEUED" };

function mkStages(tick: number) {
  const active = tick % 6;
  return STAGES.map((s, i) => {
    const status = i < active ? "done" : i === active ? "active" : "pending";
    const dotBase = status === "pending" ? "#cdd2c6" : GREEN;
    const dotStyle: CSSProperties = {
      width: 8,
      height: 8,
      borderRadius: "50%",
      flex: "none",
      display: "inline-block",
      background: dotBase,
      ...(status === "active"
        ? {
            boxShadow: "0 0 0 4px rgba(31,138,76,0.16)",
            animation: "fpPulse 1.1s ease-in-out infinite",
          }
        : {}),
    };
    return {
      ...s,
      status,
      statusLabel: LABELS[status],
      numColor: status === "pending" ? MUT : GREEN,
      pillColor: status === "active" ? GREEN : status === "done" ? DONE : MUT,
      cardBg: status === "active" ? "#f0f7f1" : "#ffffff",
      cardBorder: status === "active" ? GREEN : "#e7e9e2",
      dotStyle,
    };
  });
}

export function LandingHero() {
  const [tick, setTick] = useState(0);
  const [score, setScore] = useState(0);

  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 1500);
    let v = 0;
    const sv = setInterval(() => {
      v += 4;
      if (v >= 82) {
        v = 82;
        clearInterval(sv);
      }
      setScore(v);
    }, 28);
    return () => {
      clearInterval(iv);
      clearInterval(sv);
    };
  }, []);

  const ringOffset = RING_C * (1 - score / 100);
  const stages = mkStages(tick);
  const feedLine = FEED[tick % 6];

  return (
    <div className="relative bg-gradient-to-b from-[#f3f6f0] via-[#fbfcfa] to-[#fbfcfa]">
      <div className="absolute inset-0 hero-grid pointer-events-none" />
      <div className="relative max-w-[1180px] mx-auto px-6 lg:px-10 pt-[74px] pb-16 grid lg:grid-cols-[1fr_1.02fr] gap-14 items-center">
        {/* Copy */}
        <div>
          <h1 className="font-display font-bold text-[44px] sm:text-[58px] leading-[1.02] tracking-[-0.035em] text-ink mb-5">
            The first pass your plans take{" "}
            <span className="text-teal">before the city does.</span>
          </h1>
          <p className="text-[18.5px] leading-[1.55] text-body mb-8 max-w-[460px]">
            Upload an ADU plan set and get a cited, sheet-by-sheet readiness
            report with likely violations, official code citations, and a
            missing-documents checklist, all before you ever submit to the city.
          </p>
          <div className="flex flex-wrap gap-3 items-center">
            <Link href="/dashboard" className="btn-primary">
              Upload a plan set
            </Link>
            <Link href="/dashboard" className="btn-ghost px-6 py-3.5 text-[15.5px]">
              See a sample report
            </Link>
          </div>
          <div className="flex items-center gap-[18px] mt-7 text-[13.5px] text-muted">
            <span className="flex items-center gap-1.5">
              <span className="text-teal font-bold">✓</span>No login to preview
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-teal font-bold">✓</span>PDF, PNG, JPEG, DWG/DXF
            </span>
          </div>
        </div>

        {/* Pipeline card */}
        <div
          className="float bg-[#fbfcfa] border border-[#e7e9e2] rounded-[18px] p-[22px]"
          style={{ boxShadow: "0 20px 50px -28px rgba(20,40,25,0.4)" }}
        >
          <div className="flex items-start justify-between mb-[18px]">
            <div>
              <div className="flex items-center gap-[7px] mb-[5px]">
                <span
                  className="w-[7px] h-[7px] rounded-full bg-[#1f8a4c] inline-block"
                  style={{ animation: "fpPulse 1.1s ease-in-out infinite" }}
                />
                <span className="font-mono text-[11px] tracking-[0.1em] uppercase text-[#1f8a4c]">
                  Analyzing · live
                </span>
              </div>
              <div className="font-display font-bold text-[18px] text-[#15170f]">
                Permit-readiness pipeline
              </div>
              <div className="text-[13px] text-[#82867a]">
                123 Oak St · Detached ADU · Oakland, CA
              </div>
            </div>
            <div className="relative w-[78px] h-[78px] flex-none">
              <svg width="78" height="78" viewBox="0 0 120 120" style={{ transform: "rotate(-90deg)" }}>
                <circle cx="60" cy="60" r="52" fill="none" stroke="#e7e9e2" strokeWidth="12" />
                <circle
                  cx="60"
                  cy="60"
                  r="52"
                  fill="none"
                  stroke="#1f8a4c"
                  strokeWidth="12"
                  strokeLinecap="round"
                  strokeDasharray={RING_C}
                  strokeDashoffset={ringOffset}
                  style={{ transition: "stroke-dashoffset .1s linear" }}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="font-display font-bold text-[22px] text-[#15170f] leading-none">{score}</span>
                <span className="text-[9px] text-[#82867a] tracking-[0.06em]">/ 100</span>
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {stages.map((st) => (
              <div
                key={st.num}
                className="relative flex items-center gap-[13px] px-[14px] py-3 rounded-[11px]"
                style={{
                  background: st.cardBg,
                  border: `1px solid ${st.cardBorder}`,
                  transition: "background .3s, border-color .3s",
                }}
              >
                <span className="font-mono text-[12px] font-semibold w-[18px]" style={{ color: st.numColor }}>
                  {st.num}
                </span>
                <span style={st.dotStyle} />
                <div className="flex-1">
                  <div className="text-[14.5px] font-semibold text-[#15170f] leading-[1.2]">{st.name}</div>
                  <div className="text-[12.5px] text-[#82867a] leading-[1.3]">{st.detail}</div>
                </div>
                <span
                  className="font-mono text-[10px] tracking-[0.08em] font-semibold"
                  style={{ color: st.pillColor }}
                >
                  {st.statusLabel}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-[14px] flex items-center gap-[9px] bg-[#15170f] rounded-[10px] px-[14px] py-[11px]">
            <span className="font-mono text-[10px] text-[#54e08a]">›</span>
            <span className="font-mono text-[12px] text-[#d6dccf] leading-[1.3]">{feedLine}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
