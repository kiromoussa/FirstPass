"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type { ProjectState, Sponsor } from "@/lib/types";
import { ScoreGauge } from "@/components/ScoreGauge";
import { PhaseRail } from "@/components/PhaseRail";
import { SponsorRail } from "@/components/SponsorRail";
import { AgentFeed } from "@/components/AgentFeed";
import { BlueprintViewer } from "@/components/BlueprintViewer";
import { ApsViewer } from "@/components/ApsViewer";
import { FindingsList } from "@/components/FindingsList";
import { FactsList } from "@/components/FactsList";
import { FindingInspector } from "@/components/FindingInspector";

export default function ProjectDashboard() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [state, setState] = useState<ProjectState | null>(null);
  const [tab, setTab] = useState<"findings" | "facts">("findings");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !id) return;
    started.current = true;
    const es = new EventSource(`/api/run/${id}`);
    es.addEventListener("state", (e) => {
      setState(JSON.parse((e as MessageEvent).data));
    });
    es.addEventListener("complete", () => es.close());
    es.addEventListener("error", () => es.close());
    return () => es.close();
  }, [id]);

  const activeSponsor: Sponsor | undefined = useMemo(() => {
    const withSponsor = state?.messages.filter((m) => m.sponsor) ?? [];
    return withSponsor.length ? withSponsor[withSponsor.length - 1].sponsor : undefined;
  }, [state?.messages]);

  const selected = state?.findings.find((f) => f.id === selectedId) ?? null;
  const selectedSource = state?.sources.find((s) => s.id === selected?.sourceRef);

  const counts = useMemo(() => {
    const c = { FAIL: 0, WARNING: 0, NEEDS_REVIEW: 0, PASS: 0 };
    state?.findings.forEach((f) => (c[f.status] += 1));
    return c;
  }, [state?.findings]);

  const done = state?.project.status === "done";

  return (
    <main className="h-screen flex flex-col overflow-hidden">
      {/* Top bar */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-ink-700 flex-shrink-0">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-accent font-bold tracking-tight">◢ FirstPass</Link>
          <div className="h-5 w-px bg-ink-700" />
          <div>
            <div className="text-sm font-medium text-white">{state?.project.name ?? "Loading…"}</div>
            <div className="text-[11px] text-slate-500">{state?.project.address} · Detached ADU</div>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3 text-xs">
            <span className="text-flag-fail">{counts.FAIL} fail</span>
            <span className="text-flag-warn">{counts.WARNING} warn</span>
            <span className="text-flag-review">{counts.NEEDS_REVIEW} review</span>
          </div>
          <ScoreGauge score={state?.project.score} />
          {done && (
            <Link
              href={`/project/${id}/report`}
              className="bg-accent hover:bg-accent-600 text-ink-950 font-semibold rounded-lg px-4 py-2 text-sm"
            >
              View report →
            </Link>
          )}
        </div>
      </header>

      <div className="px-6 py-2 border-b border-ink-700 flex items-center justify-between flex-shrink-0">
        <SponsorRail active={activeSponsor} />
        <span className="text-[11px] text-slate-600">
          Deterministic checks · Claude reasoning · cited & audited
        </span>
      </div>

      {/* 3-column layout */}
      <div className="flex-1 grid grid-cols-[240px_1fr_360px] overflow-hidden">
        {/* Left: phases + facts */}
        <aside className="border-r border-ink-700 overflow-y-auto scrollbar-thin p-4 space-y-6">
          <div>
            <h3 className="text-[10px] uppercase tracking-widest text-slate-500 mb-3">Pipeline</h3>
            <PhaseRail status={state?.project.status ?? "created"} />
          </div>
          <div>
            <h3 className="text-[10px] uppercase tracking-widest text-slate-500 mb-3">Extracted facts</h3>
            <FactsList facts={state?.facts ?? []} />
          </div>
        </aside>

        {/* Center: blueprint + findings/facts tabs */}
        <section className="overflow-y-auto scrollbar-thin p-6 space-y-5">
          {state?.project.apsUrn ? (
            <ApsViewer urn={state.project.apsUrn} />
          ) : (
            <BlueprintViewer
              findings={state?.findings ?? []}
              selectedId={selectedId}
              onSelect={(fid) => {
                setSelectedId(fid);
                setTab("findings");
              }}
            />
          )}

          <div className="flex items-center gap-2">
            {(["findings", "facts"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`text-xs px-3 py-1.5 rounded-lg capitalize ${
                  tab === t ? "bg-ink-700 text-white" : "text-slate-500 hover:text-slate-300"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === "findings" ? (
            <FindingsList findings={state?.findings ?? []} selectedId={selectedId} onSelect={setSelectedId} />
          ) : (
            <FactsList facts={state?.facts ?? []} />
          )}
        </section>

        {/* Right: agent feed */}
        <aside className="border-l border-ink-700 overflow-hidden">
          <AgentFeed messages={state?.messages ?? []} />
        </aside>
      </div>

      <FindingInspector finding={selected} source={selectedSource} onClose={() => setSelectedId(null)} />
    </main>
  );
}
