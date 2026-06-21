// Band-first orchestrator — streams phased firm-style Band conversations (3 chats max).
import type { Phase, Project, ProjectState } from "./types";
import type { BandChannel } from "./integrations/band";
import { outputFresh } from "./band-output";
import { ANTHROPIC_AGENT_MODEL } from "./anthropic-model";

const POLL_MS = 4_000;
const MAX_RUN_MS = 45 * 60_000;

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
  "Permit Report Agent": "report",
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
  if (await outputFresh("solutions_report.txt", runStartedMs)) return true;
  const hasCloseout =
    !!process.env.BAND_AGENT_SOLUTIONS_ID || !!process.env.BAND_AGENT_PERMIT_ID;
  if (!hasCloseout && (await outputFresh("plan_vs_code.txt", runStartedMs))) return true;
  return false;
}

export async function* runBandPipeline(
  project: Project,
  channel: BandChannel
): AsyncGenerator<ProjectState> {
  await channel.ready;

  const state: ProjectState = {
    project: { ...project, status: "jurisdiction" },
    sources: [],
    rules: [],
    facts: [],
    findings: [],
    checklist: [],
    messages: [],
    report: undefined,
    bandRoomId: channel.roomId,
    bandTranscript: [],
  };

  const runStartedMs = project.createdAt ?? Date.now();
  const started = Date.now();
  let lastAuthor = "";

  const snapshot = (): ProjectState => ({
    ...state,
    messages: [...state.messages],
    findings: [...state.findings],
    bandTranscript: state.bandTranscript ? [...state.bandTranscript] : [],
  });

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

    if (await isWorkflowDone(runStartedMs)) {
      state.project.status = "done";
      state.messages.push({
        id: `band_complete_${Date.now()}`,
        ts: Date.now(),
        from: "orchestrator",
        type: "done",
        text: "Workflow complete — see output/ reports and the Band conversation across all chats.",
        sponsor: "band",
      });
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
