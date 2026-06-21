"use client";

import Link from "next/link";
import { PHASES, type ProjectState, type Phase, type Sponsor, type Finding, type BandRoomMessage } from "@/lib/types";
import { AGENT_META, MSG_META, SPONSOR_META, STATUS_META } from "@/lib/ui";

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

// The real tools/services behind the run, in the order they engage. The active
// one is derived from the live message stream (the `sponsor` of each message),
// so this reflects what is actually working — not a script.
const TOOLS: { key: Sponsor; what: string }[] = [
  { key: "browserbase", what: "Fetches official city code in a headless browser" },
  { key: "redis", what: "Chunked-code store for token-efficient retrieval (RAG)" },
  { key: "claude", what: "Reads the plan set and reasons over the code" },
  { key: "arize", what: "Evaluates and corrects each finding" },
  { key: "band", what: "Multi-agent message bus" },
];

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function timeOf(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function RunProgress({
  state,
  error,
  projectId,
  bandRoomId,
  bandRoom = [],
  onOpenDashboard,
}: {
  state: ProjectState | null;
  error: string | null;
  projectId: string;
  bandRoomId?: string | null;
  bandRoom?: BandRoomMessage[];
  onOpenDashboard: () => void;
}) {
  const status = state?.project.status ?? "created";
  const current = ORDER.indexOf(status);
  const done = status === "done";
  // 6 working phases; clamp progress so "created" reads as just-starting.
  const completed = done ? PHASES.length : Math.max(0, current);
  const pct = Math.round((completed / PHASES.length) * 100);

  const messages = state?.messages ?? [];
  const recent = messages.slice(-6);
  const latest = messages[messages.length - 1];

  // Which tool is active right now = the sponsor on the most recent message
  // that carries one. Which tools have engaged = every sponsor seen so far.
  const activeTool = [...messages].reverse().find((m) => m.sponsor)?.sponsor;
  const usedTools = new Set(messages.map((m) => m.sponsor).filter(Boolean) as Sponsor[]);
  // Band is the message bus every agent message flows through, so it counts as
  // in-use the moment any message exists; a live room makes that explicit.
  if (messages.length > 0 || bandRoomId) usedTools.add("band");

  // Real code retrieved this run: the official sources (Browserbase) plus the
  // distinct code sections pulled per check (RAG). Deduped by section.
  const sources = state?.sources ?? [];
  const findings = state?.findings ?? [];
  const codeSections = (() => {
    const seen = new Set<string>();
    const out: { section: string; text?: string }[] = [];
    for (const f of findings) {
      if (f.codeSection && !seen.has(f.codeSection)) {
        seen.add(f.codeSection);
        out.push({ section: f.codeSection, text: f.codeText });
      }
    }
    return out;
  })();

  // Violations = anything that isn't a clean PASS.
  const violations = findings.filter((f) => f.status !== "PASS");

  return (
    <main className="min-h-screen flex flex-col">
      <header className="px-8 py-5 flex items-center justify-between border-b border-ink-700 flex-shrink-0">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-accent text-xl font-bold tracking-tight">◢ FirstPass</Link>
          <span className="text-xs text-ink-600 bg-ink-800 px-2 py-0.5 rounded-full">
            {done ? "checks complete" : "running checks"}
          </span>
        </div>
        <div className="text-right">
          <div className="text-sm font-medium text-white">{state?.project.name ?? "Starting…"}</div>
          <div className="text-[11px] text-slate-500">{state?.project.address}</div>
        </div>
      </header>

      <div className="flex-1 flex items-start justify-center px-6 py-10">
        <div className="w-full max-w-5xl">
          <div className="mb-8">
            <h1 className="text-2xl font-semibold tracking-tight">
              {error
                ? "The run hit a problem"
                : done
                ? "Checks complete"
                : "Running your pre-submission checks"}
            </h1>
            <p className="mt-2 text-slate-400 text-sm leading-relaxed max-w-xl">
              {error
                ? error
                : done
                ? `Found ${violations.length} item${violations.length === 1 ? "" : "s"} to address. Review the violations on the right, then open the dashboard or the full report.`
                : "Live tool activity and the code being retrieved are on the right. Violations appear as the checks run."}
            </p>

            {!error && (
              <div className="mt-5">
                <div className="h-1.5 w-full bg-ink-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent transition-all duration-500 ease-out"
                    style={{ width: `${Math.max(pct, 4)}%` }}
                  />
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-slate-500">
                  <span className="truncate">{done ? "Done" : latest ? latest.text : "Connecting to the run…"}</span>
                  <span className="flex-shrink-0">{pct}%</span>
                </div>
              </div>
            )}

            {(done || error) && (
              <div className="mt-5 flex items-center gap-3">
                {done && (
                  <>
                    <button
                      onClick={onOpenDashboard}
                      className="bg-accent hover:bg-accent-600 text-ink-950 font-semibold rounded-lg px-4 py-2.5 text-sm"
                    >
                      Open dashboard →
                    </button>
                    <Link
                      href={`/project/${projectId}/report`}
                      className="text-sm text-slate-300 hover:text-white border border-ink-700 rounded-lg px-4 py-2.5"
                    >
                      View full report
                    </Link>
                  </>
                )}
                {error && (
                  <>
                    <Link
                      href="/"
                      className="bg-accent hover:bg-accent-600 text-ink-950 font-semibold rounded-lg px-4 py-2.5 text-sm"
                    >
                      Start over
                    </Link>
                    <button onClick={onOpenDashboard} className="text-sm text-slate-400 hover:text-white">
                      Open dashboard anyway →
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="grid lg:grid-cols-[1fr_minmax(320px,400px)] gap-6">
            {/* Step flow */}
            <ol className="space-y-2">
              {PHASES.map((p) => {
                const idx = ORDER.indexOf(p.key);
                const phaseState = done || current > idx ? "done" : current === idx ? "active" : "todo";
                return (
                  <li
                    key={p.key}
                    className={`flex items-start gap-3 rounded-lg border px-4 py-3 transition-colors ${
                      phaseState === "active" ? "border-accent/50 bg-ink-800/60" : "border-ink-700 bg-ink-900/40"
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
                      <div className={`text-sm font-medium ${phaseState === "todo" ? "text-slate-600" : "text-white"}`}>
                        {p.label}
                        {phaseState === "active" && (
                          <span className="ml-2 text-[10px] text-accent uppercase tracking-wide">working…</span>
                        )}
                      </div>
                      <div className={`text-xs leading-relaxed ${phaseState === "todo" ? "text-slate-700" : "text-slate-400"}`}>
                        {PHASE_DETAIL[p.key]}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>

            {/* Right rail: tools · violations · retrieved code · activity */}
            <div className="space-y-4">
              {/* Tools in use — the active one lights up in its own color */}
              <Panel title="Tools in use">
                <div className="space-y-1.5">
                  {TOOLS.map((t) => {
                    const meta = SPONSOR_META[t.key];
                    const isActive = !done && activeTool === t.key;
                    const isUsed = usedTools.has(t.key);
                    return (
                      <div
                        key={t.key}
                        className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-all duration-300 ${
                          isActive ? "tool-active" : ""
                        }`}
                        style={
                          isActive
                            ? {
                                ["--glow" as string]: meta.color,
                                borderColor: meta.color,
                                background: `${meta.color}1f`,
                              }
                            : isUsed
                            ? { borderColor: `${meta.color}55`, background: `${meta.color}0d` }
                            : { borderColor: "transparent", background: "rgba(255,255,255,0.02)" }
                        }
                      >
                        <span
                          className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${isActive ? "blink" : ""}`}
                          style={{
                            background: isActive || isUsed ? meta.color : "#3a4150",
                            boxShadow: isActive ? `0 0 8px 1px ${meta.color}` : "none",
                          }}
                        />
                        <span
                          className="text-xs font-semibold"
                          style={{ color: isActive ? meta.color : isUsed ? `${meta.color}cc` : "#6b7689" }}
                        >
                          {meta.label}
                        </span>
                        {isActive && (
                          <span
                            className="text-[9px] uppercase tracking-wide font-semibold blink"
                            style={{ color: meta.color }}
                          >
                            active
                          </span>
                        )}
                        {!isActive && isUsed && t.key === "band" && bandRoomId && (
                          <span className="text-[9px]" style={{ color: meta.color }}>● live room</span>
                        )}
                        {!isActive && isUsed && !(t.key === "band" && bandRoomId) && (
                          <span className="text-[9px]" style={{ color: meta.color }}>✓ done</span>
                        )}
                        <span className="ml-auto text-[10px] text-slate-600 truncate max-w-[170px] text-right">{t.what}</span>
                      </div>
                    );
                  })}
                </div>
              </Panel>

              {/* Code violations — visible as they stream and after completion */}
              <Panel title={`Code violations${violations.length ? ` · ${violations.length}` : ""}`}>
                {violations.length === 0 ? (
                  <p className="text-xs text-slate-600">
                    {done ? "No violations — all checks passed." : "None flagged yet…"}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {violations.map((f) => (
                      <ViolationRow key={f.id} f={f} />
                    ))}
                  </div>
                )}
              </Panel>

              {/* Code being retrieved (RAG) + official sources (Browserbase) */}
              {(codeSections.length > 0 || sources.length > 0) && (
                <Panel title="Code retrieved">
                  {sources.length > 0 && (
                    <div className="space-y-1.5 mb-3">
                      {sources.map((s) => (
                        <a
                          key={s.id}
                          href={s.url}
                          target="_blank"
                          rel="noreferrer"
                          className="block rounded-md border border-ink-700 bg-ink-800/50 px-2.5 py-1.5 hover:border-ink-600"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] text-slate-300 truncate">{s.title}</span>
                            <span
                              className="ml-auto text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0"
                              style={
                                s.live
                                  ? { color: "#3ddc97", background: "rgba(61,220,151,0.12)" }
                                  : { color: "#8aa0b6", background: "rgba(138,160,182,0.12)" }
                              }
                            >
                              {s.live ? "live" : "cached"}
                            </span>
                          </div>
                          <div className="text-[10px] text-slate-600 mt-0.5">
                            {hostOf(s.url)} · retrieved {timeOf(s.retrievedAt)}
                          </div>
                        </a>
                      ))}
                    </div>
                  )}
                  {codeSections.map((c) => (
                    <div key={c.section} className="rounded-md border border-ink-700 bg-ink-800/50 px-2.5 py-1.5 mb-1.5">
                      <div className="text-[11px] font-medium text-accent">{c.section}</div>
                      {c.text && <p className="text-[10px] text-slate-500 leading-relaxed mt-0.5 line-clamp-3">{c.text}</p>}
                    </div>
                  ))}
                </Panel>
              )}

              {/* The REAL Band room transcript — the actual conversation
                  between the registered research agents, polled live from
                  Band. Shown whenever a room is open so the run can be
                  double-checked against what the agents truly said. */}
              {bandRoomId && (
                <Panel
                  title={`Band room · live${bandRoom.length ? ` · ${bandRoom.length}` : ""}`}
                >
                  <div className="space-y-2 max-h-[300px] overflow-y-auto scrollbar-thin">
                    {bandRoom.length === 0 ? (
                      <p className="text-xs text-slate-600 py-1">
                        Room open — waiting for the agents to reply…
                      </p>
                    ) : (
                      bandRoom.map((m) => <RoomMessage key={m.id} m={m} />)
                    )}
                  </div>
                </Panel>
              )}

              {/* Live agent activity (local pipeline narration) */}
              <Panel title={`Agent activity · Band${messages.length ? ` · ${messages.length}` : ""}`}>
                <div className="space-y-2 max-h-[260px] overflow-y-auto scrollbar-thin">
                  {recent.length === 0 && <div className="text-xs text-slate-600 py-1">Waiting for agents…</div>}
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
                            style={{ color: SPONSOR_META[m.sponsor].color, background: `${SPONSOR_META[m.sponsor].color}1a` }}
                          >
                            {SPONSOR_META[m.sponsor].label}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Panel>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-ink-700 bg-ink-900/40 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-ink-700">
        <h3 className="text-[10px] uppercase tracking-widest text-slate-500">{title}</h3>
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

// One message from the real Band room. Color-coded by who posted it: the
// research agents (purple/Band), the human owner, or the FirstPass orchestrator.
function RoomMessage({ m }: { m: BandRoomMessage }) {
  const band = SPONSOR_META.band.color;
  const accent =
    m.kind === "agent" ? band : m.kind === "human" ? "#3ddc97" : "#8aa0b6";
  const role =
    m.kind === "agent" ? "agent" : m.kind === "human" ? "you" : "orchestrator";
  return (
    <div
      className="rounded-lg border bg-ink-800/60 px-3 py-2"
      style={{ borderColor: `${accent}55` }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: accent }} />
        <span className="text-xs font-medium text-slate-200 truncate">{m.author}</span>
        <span
          className="text-[9px] px-1.5 py-0.5 rounded-full uppercase tracking-wide flex-shrink-0"
          style={{ color: accent, background: `${accent}1a` }}
        >
          {role}
        </span>
        {m.ts > 0 && (
          <span className="ml-auto text-[9px] text-slate-600 flex-shrink-0">{timeOf(m.ts)}</span>
        )}
      </div>
      <p className="text-xs text-slate-400 leading-relaxed whitespace-pre-wrap break-words">{m.content}</p>
    </div>
  );
}

function ViolationRow({ f }: { f: Finding }) {
  const m = STATUS_META[f.status];
  return (
    <div className="rounded-lg border px-3 py-2" style={{ borderColor: m.border, background: m.bg }}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-100">{f.title}</span>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {f.corrected && <span className="text-[9px] text-accent" title="Corrected by Reviewer">✓ corrected</span>}
          <span
            className="text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap"
            style={{ color: m.color, background: "rgba(0,0,0,0.25)" }}
          >
            {m.label}
          </span>
        </div>
      </div>
      <p className="text-xs text-slate-400 mt-1 leading-relaxed">{f.message}</p>
      {f.codeSection && <div className="text-[10px] text-slate-500 mt-1.5">Cite: {f.codeSection}</div>}
    </div>
  );
}
