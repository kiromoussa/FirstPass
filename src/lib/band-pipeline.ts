// Band-first orchestrator — streams phased firm-style Band conversations (3 chats max).
import type { Phase, Project, ProjectState } from "./types";
import type { BandChannel } from "./integrations/band";
import { outputFresh, clearStaleDeliverables } from "./band-output";
import { ANTHROPIC_AGENT_MODEL } from "./anthropic-model";
import { rulesFor } from "./code-db";
import { JURISDICTION_ID } from "./fixtures";
import { runPlanComplianceAgent, projectHasPlanInput } from "./plan-compliance-agent";
import { scoreFrom } from "./compliance";
import { saveState } from "./store";

const POLL_MS = 4_000;
const MAX_RUN_MS = 45 * 60_000;
// Once the plan set is known unreadable and code research is done, wait this long
// for any code-only comparison to land before ending the run gracefully — rather
// than hanging until MAX_RUN_MS waiting for a plan_vs_code.txt that can't come.
const DEGRADE_GRACE_MS = 90_000;

// Self-healing handoff watchdog. Every hop in the Band workflow depends on one
// (Haiku-class) LLM agent emitting the right @mention to wake the next agent;
// when an agent "handles" its message without posting that handoff, the chain
// stalls silently. The watchdog watches deliverable files and, once a stage is
// overdue, re-posts a direct @mention to the responsible agent (escalating to
// the next agent directly if needed) so the flow self-heals instead of hanging.
const NUDGE_COOLDOWN_MS = 60_000; // min gap between re-nudges of the same stage
const MAX_NUDGES = 3; // per stage, before we give up and let MAX_RUN_MS handle it

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const AUTHOR_PHASE: Record<string, Phase> = {
  "CEO Boss": "jurisdiction",
  "Project and Property Manager": "jurisdiction",
  "Project & Property Intake Agent": "jurisdiction",
  "Municipal Code Researcher": "research",
  "State Code Researcher": "research",
  "Code Synthesizer": "research",
  "Visual Analysis": "read",
  "Compare Codes": "comply",
  "Solutions Agent": "review",
  "Improve Agent": "review",
  "Permit Agent": "report",
};

async function checkAnthropic(): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return "ANTHROPIC_API_KEY is not set in .env.local";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_AGENT_MODEL,
        max_tokens: 8,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    return body.error?.message ?? `Anthropic API returned ${res.status}`;
  } catch (e) {
    return (e as Error).message;
  }
}

async function inferPhase(latestAuthor: string | undefined, runStartedMs: number): Promise<Phase> {
  // Deliverables drive the UI forward — not the last chat author (CEO/PPM map to jurisdiction).
  if (await outputFresh("permit_report.txt", runStartedMs)) return "done";
  if (await outputFresh("solutions_report.txt", runStartedMs)) return "report";
  if (await outputFresh("plan_vs_code.txt", runStartedMs)) return "review";
  if (await outputFresh("plan_facts.txt", runStartedMs)) return "comply";
  if (await outputFresh("final_summary.txt", runStartedMs)) return "read";
  if (
    (await outputFresh("municipal_codes.txt", runStartedMs)) ||
    (await outputFresh("state_codes.txt", runStartedMs))
  )
    return "research";
  if (await outputFresh("planner_brief.txt", runStartedMs)) return "research";
  if (latestAuthor && AUTHOR_PHASE[latestAuthor]) return AUTHOR_PHASE[latestAuthor];
  return "jurisdiction";
}

async function isWorkflowDone(runStartedMs: number): Promise<boolean> {
  if (await outputFresh("permit_report.txt", runStartedMs)) return true;
  const hasPermit = !!process.env.BAND_AGENT_PERMIT_ID;
  const hasSolutions = !!process.env.BAND_AGENT_SOLUTIONS_ID;
  if (
    (await outputFresh("solutions_report.txt", runStartedMs)) &&
    !hasPermit
  )
    return true;
  if (
    !hasSolutions &&
    !hasPermit &&
    (await outputFresh("plan_vs_code.txt", runStartedMs))
  )
    return true;
  return false;
}

export async function* runBandPipeline(
  project: Project,
  channel: BandChannel
): AsyncGenerator<ProjectState> {
  const bandReady = channel.ready;

  const citySlug = project.citySlug ?? JURISDICTION_ID;
  const state: ProjectState = {
    project: { ...project, status: "jurisdiction" },
    sources: [],
    rules: rulesFor(citySlug),
    facts: [],
    findings: [],
    checklist: [],
    messages: [
      {
        id: `band_boot_${Date.now()}`,
        ts: Date.now(),
        from: "orchestrator",
        type: "info",
        text: "Band agents online — opening intake chat…",
        sponsor: "band",
      },
    ],
    report: undefined,
    bandRoomId: channel.roomId,
    bandTranscript: [],
  };

  const snapshot = (): ProjectState => ({
    ...state,
    messages: [...state.messages],
    findings: [...state.findings],
    bandTranscript: state.bandTranscript ? [...state.bandTranscript] : [],
  });

  yield snapshot();

  await Promise.race([bandReady, sleep(5_000)]);

  const runStartedMs = project.createdAt ?? Date.now();
  const started = Date.now();
  let lastAuthor = "";

  // Drop deliverables from PRIOR runs so phase detection reflects ONLY this run
  // (the files are global on disk; without this a new run can "see" a previous
  // run's final_summary.txt and skip the live agent collaboration entirely).
  await clearStaleDeliverables(runStartedMs);

  let compareCodesStarted = false;

  // The Band agents collaborate in free text; the dashboard's findings list and
  // permit-readiness score need STRUCTURED findings from the real Compare Codes
  // pipeline (plot → vision → compareNumeric + code RAG).
  const runCompareCodes = async (): Promise<void> => {
    if (compareCodesStarted || state.findings.length > 0) return;
    compareCodesStarted = true;
    try {
      const result = await runPlanComplianceAgent(project, (m) => {
        state.messages.push(m);
      });
      if (result.facts.length) state.facts = result.facts;
      if (result.findings.length) state.findings = result.findings;
      state.project.score = scoreFrom(state.findings.map((f) => f.status));
    } catch {
      /* UI shows whatever we have */
    }
  };

  const finalizeFindings = async (): Promise<void> => {
    await runCompareCodes();
    state.project.score = scoreFrom(state.findings.map((f) => f.status));
  };

  if (!channel.roomId) {
    state.messages.push({
      id: `band_err_${Date.now()}`,
      ts: Date.now(),
      from: "orchestrator",
      type: "info",
      text: "Band could not open Chat 1 — check BAND_API_KEY and run ./scripts/run_workflow_agents.sh",
      sponsor: "band",
    });
    yield snapshot();
    return;
  }

  state.messages.push({
    id: `band_open_${Date.now()}`,
    ts: Date.now(),
    from: "orchestrator",
    type: "info",
    text: `Firm workflow started — Chat 1 (CEO intake). Chats 2–3 open automatically as each phase completes. Run ./scripts/run_workflow_agents.sh`,
    sponsor: "band",
  });

  if (project.apsUrn) {
    state.messages.push({
      id: `dwg_prep_${project.id}`,
      ts: Date.now(),
      from: "orchestrator",
      type: "info",
      text: "DWG uploaded. Plotting sheets with Autodesk in the background while code research runs in Chat 1.",
      sponsor: "claude",
    });
  } else if (project.planMime) {
    state.messages.push({
      id: `pdf_prep_${Date.now()}`,
      ts: Date.now(),
      from: "orchestrator",
      type: "info",
      text: "Plan PDF/image on file — mirrored to plans/ for the Visual agent at design review.",
      sponsor: "claude",
    });
  }

  const anthropicIssue = await checkAnthropic();
  if (anthropicIssue) {
    state.messages.push({
      id: `anthropic_err_${Date.now()}`,
      ts: Date.now(),
      from: "orchestrator",
      type: "info",
      text: `Anthropic API: ${anthropicIssue}`,
      sponsor: "band",
    });
  }

  yield snapshot();

  let plansPrepNotified = false;
  let chat2Notified = false;
  let lastPlotStatus = "";
  let waitingForResearchNotified = false;
  let degradedSinceMs = 0;

  // Watchdog bookkeeping: when each stage first became the blocking stage, and
  // how many times / how recently we've nudged it.
  const stageStart: Record<string, number> = {};
  const stageNudge: Record<string, { count: number; last: number }> = {};

  const addr = project.address || "the project address";
  const type = (project.projectType || "single_family").replace(/_/g, " ");

  // Fire a nudge for `id` when `blocking` has held for `graceMs`, throttled by
  // NUDGE_COOLDOWN_MS and capped at MAX_NUDGES. `send` receives the 0-based
  // attempt number so callers can escalate (e.g. re-ask the agent, then drive
  // the next agent directly). Returns true if a nudge was sent this tick.
  const maybeNudge = async (
    id: string,
    blocking: boolean,
    graceMs: number,
    send: (attempt: number) => Promise<boolean>
  ): Promise<boolean> => {
    if (!blocking) {
      delete stageStart[id];
      return false;
    }
    const now = Date.now();
    if (!stageStart[id]) stageStart[id] = now;
    if (now - stageStart[id] < graceMs) return false;
    const st = stageNudge[id] ?? { count: 0, last: 0 };
    if (st.count >= MAX_NUDGES || now - st.last < NUDGE_COOLDOWN_MS) return false;
    const sent = await send(st.count);
    if (sent) {
      stageNudge[id] = { count: st.count + 1, last: now };
      state.messages.push({
        id: `nudge_${id}_${st.count}_${now}`,
        ts: now,
        from: "orchestrator",
        type: "info",
        text: `Handoff for "${id}" was overdue — re-pinged the responsible agent to keep the workflow moving.`,
        sponsor: "band",
      });
    }
    return sent;
  };

  // Watch every handoff and re-drive whichever stage is currently stalled.
  const runWatchdog = async (): Promise<void> => {
    const fresh = (f: string) => outputFresh(f, runStartedMs);
    const [brief, muni, stateCodes, summary, planVsCode, solutions, permit] =
      await Promise.all([
        fresh("planner_brief.txt"),
        fresh("municipal_codes.txt"),
        fresh("state_codes.txt"),
        fresh("final_summary.txt"),
        fresh("plan_vs_code.txt"),
        fresh("solutions_report.txt"),
        fresh("permit_report.txt"),
      ]);
    const prep = channel.peekPlansPrep();
    const plansOk = !!prep && prep.ok;
    if (plansOk && projectHasPlanInput(project) && state.findings.length === 0) {
      await runCompareCodes().catch(() => undefined);
    }
    const hasSolutions = !!process.env.BAND_AGENT_SOLUTIONS_ID;
    const hasPermit = !!process.env.BAND_AGENT_PERMIT_ID;

    // 1. Intake brief (PPM).
    await maybeNudge("intake brief", !brief, 45_000, () =>
      channel.nudge(
        ["varbtw/project-property-intake"],
        `@varbtw/project-property-intake — I don't see \`output/planner_brief.txt\` yet. Complete intake for ${addr} (${type}), write \`output/planner_brief.txt\`, then @mention @varbtw/code-synthesizer **once**.`,
        0
      )
    );

    // 2. Scope + dispatch research. First re-ask the Synthesizer; if still stuck,
    //    drive the missing researcher(s) directly.
    await maybeNudge("code research", brief && !(muni && stateCodes), 120_000, (attempt) => {
      if (attempt === 0) {
        return channel.nudge(
          ["varbtw/code-synthesizer"],
          `@varbtw/code-synthesizer — \`output/planner_brief.txt\` is ready. List the municipal + state code research questions and @mention @varbtw/municipal-researcher and @varbtw/state-code-researcher in **one** message now, then stop.`,
          0
        );
      }
      const targets: string[] = [];
      if (!muni) targets.push("varbtw/municipal-researcher");
      if (!stateCodes) targets.push("varbtw/state-code-researcher");
      return channel.nudge(
        targets,
        `${targets.map((t) => `@${t}`).join(" ")} — research the zoning and building code for ${addr} (${type}). Municipal: write \`output/municipal_codes.txt\`. State (California Gov Code + Title 24): write \`output/state_codes.txt\`. Then @mention @varbtw/code-synthesizer **once**.`,
        0
      );
    });

    // 3. Merge into the governing code set.
    await maybeNudge("code merge", muni && stateCodes && !summary, 45_000, () =>
      channel.nudge(
        ["varbtw/code-synthesizer"],
        `@varbtw/code-synthesizer — \`output/municipal_codes.txt\` and \`output/state_codes.txt\` are both ready. Merge them into \`output/final_summary.txt\` now and @mention @varbtw/compare-codes **once**, then stop.`,
        0
      )
    );

    // 4. Plan vs code comparison (Chat 2) — only when sheets actually exist.
    await maybeNudge(
      "plan comparison",
      summary && channel.chatOpen(1) && plansOk && !planVsCode,
      80_000,
      () =>
        channel.nudge(
          ["varbtw/compare-codes"],
          `@varbtw/compare-codes — plan sheets are in \`plans/\` and the governing codes are in \`output/final_summary.txt\`. Read the sheets, write \`output/plan_facts.txt\` and \`output/plan_vs_code.txt\`, then @mention @varbtw/improve-agent **once**.`,
          1
        )
    );

    // 5. Solutions (Chat 3).
    await maybeNudge(
      "solutions",
      planVsCode && channel.chatOpen(2) && hasSolutions && !solutions,
      80_000,
      () =>
        channel.nudge(
          ["varbtw/improve-agent"],
          `@varbtw/improve-agent — \`output/plan_vs_code.txt\` is ready. Research a design fix for each FAIL / NEEDS REVIEW item, write \`output/solutions_report.txt\`, then @mention @varbtw/permit-report-agent **once**.`,
          2
        )
    );

    // 6. Permit package (Chat 3).
    await maybeNudge(
      "permit package",
      solutions && channel.chatOpen(2) && hasPermit && !permit,
      80_000,
      () =>
        channel.nudge(
          ["varbtw/permit-report-agent"],
          `@varbtw/permit-report-agent — \`output/solutions_report.txt\` is ready. Compile the pre-submission permit package into \`output/permit_report.txt\`, then @mention @varbtw/ceo-boss **once**.`,
          2
        )
    );
  };

  while (Date.now() - started < MAX_RUN_MS) {
    const plotStatus = channel.getPlotStatus();
    if (plotStatus && plotStatus !== lastPlotStatus) {
      lastPlotStatus = plotStatus;
      state.messages.push({
        id: `plot_status_${lastPlotStatus.replace(/\W+/g, "_").slice(0, 40)}`,
        ts: Date.now(),
        from: "orchestrator",
        type: "info",
        text: `Autodesk plot: ${plotStatus}`,
        sponsor: "claude",
      });
    }

    const prepResult = channel.peekPlansPrep();
    if (prepResult && !plansPrepNotified) {
      plansPrepNotified = true;
      const detail =
        prepResult.ok && prepResult.files.length
          ? `${prepResult.message ?? "Plan sheets ready"} (${prepResult.files.length} file${prepResult.files.length === 1 ? "" : "s"} in plans/). Visual agent will read them when Chat 2 opens.`
          : prepResult.message ?? "DWG plot failed. Upload a PDF instead or check APS credentials.";
      state.messages.push({
        id: `plans_prep_${project.id}`,
        ts: Date.now(),
        from: "orchestrator",
        type: prepResult.ok ? "info" : "finding",
        text: detail,
        sponsor: "claude",
      });
    }

    const { plansPrep, chat2Opened } = await channel.advancePhases(runStartedMs);
    if (chat2Opened && !chat2Notified) {
      chat2Notified = true;
      const detail =
        plansPrep?.ok && plansPrep.files.length
          ? `Chat 2 opened. Visual agent will read ${plansPrep.files.length} sheet${plansPrep.files.length === 1 ? "" : "s"} from plans/.`
          : plansPrep?.message ?? "Chat 2 opened but no plan sheets are available.";
      state.messages.push({
        id: `chat2_open_${project.id}`,
        ts: Date.now(),
        from: "orchestrator",
        type: plansPrep?.ok ? "info" : "finding",
        text: detail,
        sponsor: "band",
      });
    }
    state.bandTranscript = await channel.roomTranscript();
    for (const m of state.bandTranscript) {
      if (m.kind === "agent") lastAuthor = m.author;
    }

    state.project.status = await inferPhase(lastAuthor, runStartedMs);
    state.project.bandRoomId = channel.roomId ?? undefined;

    // Re-drive any silently-stalled handoff so the chain can't dead-end.
    await runWatchdog().catch(() => undefined);

    if (
      !waitingForResearchNotified &&
      Date.now() - started > 20_000 &&
      !(await outputFresh("final_summary.txt", runStartedMs))
    ) {
      waitingForResearchNotified = true;
      state.messages.push({
        id: `wait_research_${project.id}`,
        ts: Date.now(),
        from: "orchestrator",
        type: "info",
        text: "Still waiting for Chat 1 code research (needs output/final_summary.txt). DWG plotting runs in parallel. If Band is quiet, run ./scripts/run_workflow_agents.sh in a terminal.",
        sponsor: "band",
      });
    }

    yield snapshot();

    // Graceful terminal path: if the plan set is definitively unreadable (the DWG
    // plot failed / produced no sheets, or no plan was provided) then Compare
    // Codes can't produce plan_vs_code.txt. Once code research is done, give a
    // short grace window for any code-only comparison to land, then end the run
    // with a clear, actionable message instead of hanging until MAX_RUN_MS.
    const prep = channel.peekPlansPrep();
    const planUnreadable = !!prep && !prep.ok;
    if (
      planUnreadable &&
      (await outputFresh("final_summary.txt", runStartedMs)) &&
      !(await isWorkflowDone(runStartedMs))
    ) {
      if (!degradedSinceMs) degradedSinceMs = Date.now();
      const graceElapsed = Date.now() - degradedSinceMs > DEGRADE_GRACE_MS;
      const haveComparison = await outputFresh("plan_vs_code.txt", runStartedMs);
      if (graceElapsed && !haveComparison) {
        state.project.status = "review";
        await finalizeFindings();
        state.messages.push({
          id: `plans_unreadable_${project.id}`,
          ts: Date.now(),
          from: "orchestrator",
          type: "finding",
          text: `Could not turn this plan set into readable sheets — ${prep.message ?? "no sheets produced"}. Code research is complete (output/final_summary.txt). To finish the plan-vs-code comparison, re-upload a flattened PDF, or a DWG that contains paper-space layouts (the plotter reads paper space, not model space).`,
          sponsor: "claude",
        });
        await saveState(snapshot()).catch(() => undefined);
        yield snapshot();
        return;
      }
    }

    if (await isWorkflowDone(runStartedMs)) {
      state.project.status = "done";
      await finalizeFindings();
      state.messages.push({
        id: `band_complete_${Date.now()}`,
        ts: Date.now(),
        from: "orchestrator",
        type: "done",
        text: `Workflow complete — readiness score ${state.project.score}/100. See output/ reports and the Band conversation across all chats.`,
        sponsor: "band",
      });
      // Persist the finished run so revisiting the project replays this result
      // instead of re-running the whole pipeline from scratch.
      await saveState(snapshot()).catch(() => undefined);
      yield snapshot();
      return;
    }

    await sleep(POLL_MS);
  }

  state.messages.push({
    id: `band_timeout_${Date.now()}`,
    ts: Date.now(),
    from: "orchestrator",
    type: "info",
    text: "Still in progress — agents continue in Band. Keep local listeners running.",
    sponsor: "band",
  });
  yield snapshot();
}
