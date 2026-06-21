"use client";

import { useEffect, useState } from "react";

const STAGES = [
  { num: "01", name: "Jurisdiction", detail: "Resolves city & responsible agencies" },
  { num: "02", name: "Code research", detail: "Browses municipal & state ADU codes" },
  { num: "03", name: "Plan reading", detail: "Extracts setbacks, heights, coverage" },
  { num: "04", name: "Compliance", detail: "Compares facts to jurisdiction rules" },
  { num: "05", name: "Audit", detail: "Reviewer challenges & corrects findings" },
  { num: "06", name: "Report", detail: "Composes the cited readiness report" },
];

const FEED = [
  "Resolved jurisdiction: City of Oakland · CA HCD",
  "Fetched OakMC §17.103 ADU standards · retrieved today",
  "Read 14 sheets · extracted 9 structured facts",
  "Max unit size: 1,200 sf allowed vs 850 sf · PASS",
  "Auditor re-checked height on sheet A-301 · WARNING",
  "Report composed · 4 findings · 1 missing document",
];

export function HowItWorks() {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 1500);
    return () => clearInterval(iv);
  }, []);

  const active = tick % 6;
  const green = "#1f8a4c";

  const feedRows = [3, 2, 1, 0].map((k) => {
    const idx = ((active - k) % 6 + 6) % 6;
    return {
      text: FEED[idx],
      tag: k === 0 ? "›" : "✓",
      op: k === 0 ? 1 : k === 1 ? 0.7 : k === 2 ? 0.45 : 0.25,
    };
  });

  return (
    <div id="how" className="bg-white border-b border-hairline">
      <div className="max-w-[1180px] mx-auto px-6 lg:px-10 py-20">
        <div className="text-center max-w-[680px] mx-auto mb-13" style={{ marginBottom: 52 }}>
          <div className="font-mono text-[12px] tracking-[0.14em] uppercase text-teal mb-3.5">How it works</div>
          <h2 className="font-display font-bold text-[42px] leading-[1.06] tracking-[-0.03em] text-ink mb-4">
            Six agents, one readiness verdict.
          </h2>
          <p className="text-[17.5px] leading-[1.55] text-body">
            Every run flows through a multi-agent pipeline that resolves your
            jurisdiction, researches live code, reads the drawings, and audits
            each other before a report is composed.
          </p>
        </div>

        {/* pipeline track */}
        <div className="relative mb-11">
          <div className="absolute top-[26px] left-[7%] right-[7%] h-0.5 bg-[#e1e4db] z-0" />
          <div
            className="absolute top-[26px] left-[7%] h-0.5 bg-teal z-[1] transition-[width] duration-500"
            style={{ width: `${(active / 5) * 100}%`, maxWidth: "86%" }}
          />
          <div className="relative flex justify-between gap-2.5 z-[2]">
            {STAGES.map((s, i) => {
              const status = i < active ? "done" : i === active ? "active" : "pending";
              return (
                <div key={s.num} className="flex-1 flex flex-col items-center gap-3">
                  <div
                    className="w-[54px] h-[54px] rounded-full flex items-center justify-center font-mono font-semibold text-[16px] transition-all duration-300"
                    style={{
                      background: status === "done" ? green : status === "active" ? "#eef7f0" : "#ffffff",
                      border: `2px solid ${status === "pending" ? "#e1e4db" : green}`,
                      color: status === "done" ? "#fff" : status === "active" ? green : "#9aa093",
                      boxShadow: status === "active" ? "0 0 0 6px rgba(31,138,76,0.12)" : "none",
                    }}
                  >
                    {status === "done" ? "✓" : s.num}
                  </div>
                  <div className="text-center max-w-[158px]">
                    <div className="text-[14px] font-semibold leading-tight text-ink">{s.name}</div>
                    <div className="text-[11.5px] text-muted leading-[1.32] mt-1">{s.detail}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* live panes */}
        <div className="grid lg:grid-cols-[1.25fr_1fr] gap-5">
          {/* activity feed */}
          <div className="relative overflow-hidden bg-[#0e1410] rounded-[16px] px-6 py-[22px]">
            <div className="absolute inset-0 dot-grid-dark pointer-events-none" />
            <div className="relative flex items-center gap-2 mb-4">
              <span className="w-[9px] h-[9px] rounded-full bg-[#54e08a] pulse inline-block" />
              <span className="font-mono text-[11px] tracking-[0.12em] uppercase text-[#54e08a]">
                Agent activity · live
              </span>
            </div>
            <div className="relative flex flex-col gap-2.5">
              {feedRows.map((f, i) => (
                <div key={i} className="flex items-start gap-2.5" style={{ opacity: f.op, transition: "opacity .4s" }}>
                  <span className="font-mono text-[11px] text-[#54e08a] flex-none mt-px">{f.tag}</span>
                  <span className="font-mono text-[12.5px] text-[#c8cfc0] leading-[1.4]">{f.text}</span>
                </div>
              ))}
            </div>
          </div>

          {/* audit loop */}
          <div className="bg-[#fbfcfa] border border-[#e7e9e2] rounded-[16px] px-6 py-[22px]">
            <div className="font-mono text-[11px] tracking-[0.12em] uppercase text-muted mb-4">
              Audit loop · disagreement resolved
            </div>
            <div className="flex flex-col gap-3">
              <div className="flex gap-2.5 items-start">
                <span className="text-[11px] font-semibold text-white bg-[#6E56CF] rounded-md px-2 py-1 flex-none">
                  Reviewer
                </span>
                <p className="m-0 text-[13.5px] leading-[1.45] text-[#3f433a]">
                  Height read as 16&prime;2&Prime; on A-301. Re-measure against the A-302 datum before flagging.
                </p>
              </div>
              <div className="flex gap-2.5 items-start">
                <span className="text-[11px] font-semibold text-white bg-teal rounded-md px-2 py-1 flex-none">
                  Compliance
                </span>
                <p className="m-0 text-[13.5px] leading-[1.45] text-[#3f433a]">
                  Confirmed 16&prime;2&Prime;, exceeds 16&prime;0&Prime; max. Holding as{" "}
                  <span className="text-[#b07a09] font-semibold">WARNING</span>, not blocker.
                </p>
              </div>
              <div className="flex items-center gap-2 mt-0.5 px-3 py-2.5 bg-[#eef7f0] border border-[#d8ecdd] rounded-[10px]">
                <span className="text-teal font-bold">✓</span>
                <span className="text-[13px] text-[#236b41] font-medium">
                  Resolved with citation · finding kept, severity confirmed.
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
