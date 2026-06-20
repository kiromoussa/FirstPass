"use client";

import Link from "next/link";
import { PHASES, type ProjectState, type Phase } from "@/lib/types";
import { AGENT_META, MSG_META, SPONSOR_META } from "@/lib/ui";

const ORDER: Phase[] = ["jurisdiction", "research", "read", "comply", "review", "report", "done"];

// One-line description of what each phase is actually doing — gives the step
// flow some substance while the agents work.
const PHASE_DETAIL: Record<string, string> = {
  jurisdiction: "Resolving the jurisdiction and responsible agencies.",
  research: "Navigating official city sources and indexing the code.",
  read: "Reading the plan set and extracting structured facts.",
  comply: "Running the deterministic compliance checks.",
  review: "Auditing every finding and correcting misapplied rules.",
  report: "Composing the cited permit-readiness report.",
};

export function RunProgress({
  state,
  error,
  projectId,
}: {
  state: ProjectState | null;
  error: string | null;
  projectId: string;
}) {
  const status = state?.project.status ?? "created";
  const current = ORDER.indexOf(status);
  // 6 working phases; clamp progress so "created" reads as just-starting.
  const completed = status === "done" ? PHASES.length : Math.max(0, current);
  const pct = Math.round((completed / PHASES.length) * 100);

  const messages = state?.messages ?? [];
  const recent = messages.slice(-6);
  const latest = messages[messages.length - 1];

  return (
    <main className="min-h-screen flex flex-col">
      <header className="px-8 py-5 flex items-center justify-between border-b border-ink-700 flex-shrink-0">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-accent text-xl font-bold tracking-tight">◢ FirstPass</Link>
          <span className="text-xs text-ink-600 bg-ink-800 px-2 py-0.5 rounded-full">running checks</span>
        </div>
        <div className="text-right">
          <div className="text-sm font-medium text-white">{state?.project.name ?? "Starting…"}</div>
          <div className="text-[11px] text-slate-500">{state?.project.address}</div>
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center px-6 py-10">
        <div className="w-full max-w-4xl">
          <div className="mb-8">
            <h1 className="text-2xl font-semibold tracking-tight">
              {error
                ? "The run hit a problem"
                : status === "done"
                ? "Checks complete"
                : "Running your pre-submission checks"}
            </h1>
            <p className="mt-2 text-slate-400 text-sm leading-relaxed max-w-xl">
              {error
                ? error
                : status === "done"
                ? "Every phase finished. Open the dashboard to review the findings and the full report."
                : "The agents are working through each phase below. The dashboard opens automatically once the report is ready."}
            </p>

            {/* Progress bar */}
            {!error && (
              <div className="mt-5">
                <div className="h-1.5 w-full bg-ink-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent transition-all duration-500 ease-out"
                    style={{ width: `${Math.max(pct, 4)}%` }}
                  />
                </div>
                <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-500">
                  <span>{status === "done" ? "Done" : latest ? latest.text : "Connecting to the run…"}</span>
                  <span>{pct}%</span>
                </div>
              </div>
            )}
          </div>

          <div className="grid lg:grid-cols-[1fr_minmax(300px,360px)] gap-6">
            {/* Step flow */}
            <ol className="space-y-2">
              {PHASES.map((p) => {
                const idx = ORDER.indexOf(p.key);
                const phaseState =
                  status === "done" || current > idx ? "done" : current === idx ? "active" : "todo";
                return (
                  <li
                    key={p.key}
                    className={`flex items-start gap-3 rounded-lg border px-4 py-3 transition-colors ${
                      phaseState === "active"
                        ? "border-accent/50 bg-ink-800/60"
                        : "border-ink-700 bg-ink-900/40"
                    }`}
                  >
                    <span className="mt-0.5 flex-shrink-0">
                      {phaseState === "done" ? (
                        <span className="w-5 h-5 rounded-full bg-accent text-ink-950 text-xs font-bold flex items-center justify-center">
                          ✓
                        </span>
                      ) : phaseState === "active" ? (
                        <span className="w-5 h-5 rounded-full border-2 border-accent border-t-transparent animate-spin block" />
                      ) : (
                        <span className="w-5 h-5 rounded-full border border-ink-600 block" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <div
                        className={`text-sm font-medium ${
                          phaseState === "todo" ? "text-slate-600" : "text-white"
                        }`}
                      >
                        {p.label}
                        {phaseState === "active" && (
                          <span className="ml-2 text-[10px] text-accent uppercase tracking-wide">working…</span>
                        )}
                      </div>
                      <div
                        className={`text-xs leading-relaxed ${
                          phaseState === "todo" ? "text-slate-700" : "text-slate-400"
                        }`}
                      >
                        {PHASE_DETAIL[p.key]}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>

            {/* Live agent activity */}
            <aside className="rounded-lg border border-ink-700 bg-ink-900/40 flex flex-col overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-ink-700">
                <h3 className="text-[10px] uppercase tracking-widest text-slate-500">Agent activity · Band</h3>
                <span className="text-[10px] text-slate-600">{messages.length} msgs</span>
              </div>
              <div className="p-3 space-y-2 max-h-[340px] overflow-y-auto scrollbar-thin">
                {recent.length === 0 && (
                  <div className="text-xs text-slate-600 px-1 py-3">Waiting for agents…</div>
                )}
                {recent.map((m) => {
                  const agent = AGENT_META[m.from];
                  const mt = MSG_META[m.type];
                  return (
                    <div key={m.id} className="rounded-lg border border-ink-700 bg-ink-800/60 px-3 py-2">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm">{agent.emoji}</span>
                        <span className="text-xs font-medium text-slate-200">{agent.label}</span>
                        <span
                          className="ml-auto text-[9px] px-1.5 py-0.5 rounded-full uppercase tracking-wide"
                          style={{ color: mt.color, background: `${mt.color}1a` }}
                        >
                          {mt.label}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 leading-relaxed">{m.text}</p>
                      {m.sponsor && (
                        <span
                          className="inline-block mt-1.5 text-[9px] px-1.5 py-0.5 rounded"
                          style={{
                            color: SPONSOR_META[m.sponsor].color,
                            background: `${SPONSOR_META[m.sponsor].color}1a`,
                          }}
                        >
                          {SPONSOR_META[m.sponsor].label}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </aside>
          </div>

          {error && (
            <div className="mt-8 flex items-center gap-3">
              <Link
                href="/"
                className="bg-accent hover:bg-accent-600 text-ink-950 font-semibold rounded-lg px-4 py-2.5 text-sm"
              >
                Start over
              </Link>
              <Link
                href={`/project/${projectId}`}
                className="text-sm text-slate-400 hover:text-white"
              >
                Open dashboard anyway →
              </Link>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
