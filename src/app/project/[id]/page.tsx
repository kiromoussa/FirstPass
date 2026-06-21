"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import type { ProjectState, Sponsor } from "@/lib/types";
import { ScoreGauge } from "@/components/ScoreGauge";
import { PhaseRail } from "@/components/PhaseRail";
import { SponsorRail } from "@/components/SponsorRail";
import { AgentFeed } from "@/components/AgentFeed";
import { BlueprintViewer } from "@/components/BlueprintViewer";
import { PlanSheetViewer } from "@/components/PlanSheetViewer";
import { FindingsList } from "@/components/FindingsList";
import { FactsList } from "@/components/FactsList";
import { FindingInspector } from "@/components/FindingInspector";
import { RunProgress } from "@/components/RunProgress";
import { BlackboardPanel } from "@/components/BlackboardPanel";

export default function ProjectDashboard() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [state, setState] = useState<ProjectState | null>(null);
  const [tab, setTab] = useState<"findings" | "facts">("findings");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewDashboard, setViewDashboard] = useState(false);
  const [bandRoomId, setBandRoomId] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    // Own the EventSource in the effect (no persistent "started" ref): under
    // React Strict Mode the effect runs mount→cleanup→mount, and a ref guard
    // would close the first stream then refuse to reopen, leaving the run
    // stuck on "Connecting…". Letting cleanup close and remount reopen is the
    // correct, Strict-Mode-safe pattern.
    const es = new EventSource(`/api/run/${id}`);
    es.addEventListener("state", (e) => {
      const next = JSON.parse((e as MessageEvent).data) as ProjectState;
      setState(next);
      if (next.bandRoomId) setBandRoomId(next.bandRoomId);
    });
    es.addEventListener("band", (e) => {
      try {
        setBandRoomId(JSON.parse((e as MessageEvent).data).roomId ?? null);
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("complete", () => es.close());
    es.addEventListener("run-error", (e) => {
      try {
        setError(JSON.parse((e as MessageEvent).data).message ?? "The run failed.");
      } catch {
        setError("The run failed.");
      }
      es.close();
    });
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
  // Show the step-by-step run flow until the pipeline finishes (or fails), then
  // a completion summary with the code violations, rather than dropping the
  // user into an empty dashboard. The dashboard opens on demand (no re-run).
  if (!done || !viewDashboard) {
    return (
      <RunProgress
        state={state}
        error={error}
        projectId={id}
        bandRoomId={bandRoomId}
        onOpenDashboard={() => setViewDashboard(true)}
      />
    );
  }

  return (
    <main className="h-screen flex flex-col overflow-hidden">
      {/* Top bar */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-ink-700 flex-shrink-0">
        <div className="flex items-center gap-4">
          <Link href="/" className="flex items-center gap-2 group">
            <Image src="/firstpass-mark.png" alt="FirstPass logo" width={24} height={24} priority className="h-6 w-6 object-contain" />
            <span className="text-ink font-bold tracking-tight">FirstPass</span>
          </Link>
          <div className="h-5 w-px bg-ink-700" />
          <div>
            <div className="text-sm font-medium text-ink">{state?.project.name ?? "Loading…"}</div>
            <div className="text-[11px] text-muted">{state?.project.address} · Detached ADU</div>
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
        <span className="text-[11px] text-faint">
          Deterministic checks · Claude reasoning · cited & audited
        </span>
      </div>

      {/* 3-column layout: context · plan viewer · findings + conversation */}
      <div className="flex-1 grid grid-cols-[240px_1fr_400px] overflow-hidden">
        {/* Left: phases + facts */}
        <aside className="border-r border-ink-700 overflow-y-auto scrollbar-thin p-4 space-y-6">
          <div>
            <h3 className="text-[10px] uppercase tracking-widest text-muted mb-3">Pipeline</h3>
            <PhaseRail status={state?.project.status ?? "created"} />
          </div>
          <div>
            <h3 className="text-[10px] uppercase tracking-widest text-muted mb-3">Extracted facts</h3>
            <FactsList facts={state?.facts ?? []} projectType={state?.project.projectType} />
          </div>
          <div>
            <h3 className="text-[10px] uppercase tracking-widest text-muted mb-3">
              Redis blackboard
            </h3>
            <BlackboardPanel projectId={id} />
          </div>
        </aside>

        {/* Center: the plan sheet viewer gets the full center */}
        <section className="overflow-y-auto scrollbar-thin p-6">
          {state?.project.apsUrn ? (
            <PlanSheetViewer projectId={id} />
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
        </section>

        {/* Right: findings/facts · pipeline feed */}
        <aside className="border-l border-ink-700 overflow-hidden flex flex-col">
          {/* Findings / facts — moved here from the center so the viewer owns it */}
          <div className="flex-1 min-h-0 flex flex-col border-b border-ink-700">
            <div className="flex items-center gap-2 p-3 pb-2 flex-shrink-0">
              {(["findings", "facts"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`text-xs px-3 py-1.5 rounded-lg capitalize ${
                    tab === t ? "bg-ink-700 text-ink" : "text-muted hover:text-body"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 pb-3">
              {tab === "findings" ? (
                <FindingsList findings={state?.findings ?? []} selectedId={selectedId} onSelect={setSelectedId} />
              ) : (
                <FactsList facts={state?.facts ?? []} projectType={state?.project.projectType} />
              )}
            </div>
          </div>

          <div className="flex-1 min-h-0">
            <AgentFeed messages={state?.messages ?? []} autoScroll />
          </div>
        </aside>
      </div>

      <FindingInspector finding={selected} source={selectedSource} onClose={() => setSelectedId(null)} />
    </main>
  );
}
