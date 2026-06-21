// Demo-paced pipeline for Los Angeles(1).dwg — runs REAL plan read + code comparison,
// streaming updates to the UI so the run feels live (not a long freeze then replay).
import type {
  AgentMessage,
  Finding,
  Project,
  ProjectState,
  Report,
} from "./types";
import { DISCLAIMER } from "./types";
import type { BandChannel } from "./integrations/band";
import { seedCodeChunks, rulesFor, cityLabel, resolveCitySlug, loadCityChunks } from "./code-db";
import { deriveChecklist } from "./fixtures";
import { researchSources } from "./integrations/browserbase";
import { runPlanComplianceAgent, type PlanComplianceResult } from "./plan-compliance-agent";
import { scoreFrom, languageLint } from "./compliance";
import { saveState } from "./store";
import { persistProject } from "./project-persistence";
import { ensureProjectPlansStaged, publishViewerSheets } from "./plans-prep";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TICK_MS = 350;

function buildReport(project: Project, findings: Finding[], score: number): Report {
  const counts = findings.reduce(
    (a, f) => ((a[f.status] = (a[f.status] || 0) + 1), a),
    {} as Record<string, number>
  );
  const city = cityLabel(project.citySlug ?? "los-angeles-ca");
  return {
    projectId: project.id,
    score,
    summary: languageLint(
      `Permit-readiness score ${score}/100 for ${project.address || project.name} (${city}). ` +
        `${counts.FAIL || 0} likely violation(s), ${counts.WARNING || 0} warning(s), ${counts.NEEDS_REVIEW || 0} item(s) needing review. ` +
        `All findings are pre-submission and require professional confirmation.`
    ),
    sections: findings.map((f) => ({
      heading: f.title,
      status: f.status,
      body: languageLint(f.message),
      citationSourceId: f.sourceRef,
    })),
    generatedAt: Date.now(),
    disclaimer: DISCLAIMER,
  };
}

function phaseFromMessage(m: AgentMessage): ProjectState["project"]["status"] | null {
  if (m.from === "plan-reader") return "read";
  if (m.from === "compliance") return "comply";
  if (m.from === "reviewer") return "review";
  if (m.from === "report") return "report";
  if (m.from === "research") return "research";
  if (m.from === "jurisdiction") return "jurisdiction";
  return null;
}

export async function* runDemoPipeline(
  project: Project,
  channel: BandChannel
): AsyncGenerator<ProjectState> {
  const bandReady = channel.ready;
  const citySlug =
    /los\s*angeles\s*\(?1\)?/i.test(project.dwgName ?? "")
      ? "los-angeles-ca"
      : project.citySlug ?? (await resolveCitySlug(project.address));
  const enriched: Project = { ...project, citySlug, jurisdictionId: citySlug };
  const now = () => Date.now();

  const state: ProjectState = {
    project: { ...enriched, status: "jurisdiction" },
    sources: [],
    rules: rulesFor(citySlug),
    facts: [],
    findings: [],
    checklist: [],
    messages: [],
    report: undefined,
    bandRoomId: channel.roomId,
    bandTranscript: [],
  };

  const snapshot = (): ProjectState => ({
    ...state,
    messages: [...state.messages],
    findings: [...state.findings],
    facts: [...state.facts],
    checklist: [...state.checklist],
    bandTranscript: state.bandTranscript ? [...state.bandTranscript] : [],
  });

  const push = (from: AgentMessage["from"], text: string, type: AgentMessage["type"] = "info", sponsor: AgentMessage["sponsor"] = "band") => {
    state.messages.push({
      id: `demo_${from}_${state.messages.length}_${now()}`,
      ts: now(),
      from,
      type,
      text,
      sponsor,
    });
    const phase = phaseFromMessage({ from } as AgentMessage);
    if (phase) state.project.status = phase;
  };

  // ---- Warm-up: immediate motion on the phase rail ----
  push("orchestrator", "Firm workflow started — agents collaborating on your pre-submission review.", "info", "band");
  yield snapshot();
  await Promise.race([bandReady, sleep(3_000)]);
  await sleep(500);

  // Stage bundled plan sheets immediately so the viewer is ready when the run finishes.
  await ensureProjectPlansStaged(enriched);
  try {
    await publishViewerSheets(enriched.id);
  } catch {
    /* viewer hydrates on first GET */
  }

  push("orchestrator", "CEO Boss: New review — delegating to Project & Property Manager.", "info", "band");
  yield snapshot();
  await sleep(450);

  push("orchestrator", "Project & Property Manager: Intake complete → output/planner_brief.txt.", "info", "band");
  yield snapshot();
  await sleep(400);

  state.project.status = "research";
  push("research", "Code Synthesizer: Scoping municipal + state building code requirements…", "info", "band");
  yield snapshot();

  const { sources } = await researchSources(citySlug);
  state.sources = sources;
  const chunkCount = (await seedCodeChunks(citySlug)) || loadCityChunks(citySlug)?.length || 0;
  push(
    "research",
    `Indexed ${chunkCount.toLocaleString()} code chunks from data/cities/${citySlug}/ (Python corpus) for token-efficient retrieval.`,
    "done",
    "redis"
  );
  yield snapshot();
  await sleep(400);

  state.project.status = "read";
  push(
    "orchestrator",
    `Analyzing ${project.dwgName ?? "plan set"} against ${cityLabel(citySlug)} building code — APS plot → vision → compare…`,
    "info",
    "claude"
  );
  yield snapshot();

  // ---- Live analysis: tick the UI while Compare Codes runs ----
  let compliance: PlanComplianceResult | null = null;
  const complianceTask = runPlanComplianceAgent(enriched, (m) => {
    state.messages.push(m);
    const phase = phaseFromMessage(m);
    if (phase) state.project.status = phase;
  }).catch((e) => ({
    ok: false as const,
    facts: [] as PlanComplianceResult["facts"],
    findings: [] as Finding[],
    messages: [] as AgentMessage[],
    error: (e as Error).message ?? "Compare Codes failed",
  }));

  while (!compliance) {
    const winner = await Promise.race([
      complianceTask.then((r) => ({ kind: "done" as const, r })),
      sleep(TICK_MS).then(() => ({ kind: "tick" as const })),
    ]);
    try {
      state.bandTranscript = await channel.roomTranscript();
    } catch {
      /* best-effort */
    }
    yield snapshot();
    if (winner.kind === "done") compliance = winner.r;
  }

  state.facts = compliance.facts;
  state.checklist = deriveChecklist(compliance.facts);
  state.project.score = scoreFrom(compliance.findings.map((f) => f.status));

  if (!compliance.ok && compliance.error) {
    push("orchestrator", `Compare Codes: ${compliance.error}`, "finding", "claude");
    if (state.findings.length === 0) {
      state.findings.push({
        id: "f_compare_error",
        ruleKey: "requiredDocs",
        title: "Plan vs code comparison",
        status: "NEEDS_REVIEW",
        message: compliance.error,
      });
    }
    yield snapshot();
  }

  const failN = compliance.findings.filter((f) => f.status === "FAIL").length;
  const reviewN = compliance.findings.filter((f) => f.status === "NEEDS_REVIEW").length;
  const passN = compliance.findings.filter((f) => f.status === "PASS").length;

  // ---- Stream findings one-by-one so violations appear live ----
  state.project.status = "comply";
  state.findings = [];
  for (const f of compliance.findings) {
    state.findings.push(f);
    yield snapshot();
    await sleep(f.status === "PASS" ? 160 : f.status === "FAIL" ? 420 : 300);
  }

  push(
    "compliance",
    `Compare Codes finished — ${passN} pass · ${reviewN} need review · ${failN} fail.`,
    failN ? "finding" : "done",
    "arize"
  );
  yield snapshot();
  await sleep(500);

  state.project.status = "review";
  push("reviewer", "Improve Agent: Researching design fixes for FAIL / NEEDS REVIEW items.", "info", "band");
  yield snapshot();
  await sleep(700);

  state.project.status = "report";
  push("report", "Permit Agent: Compiling the pre-submission package from live findings.", "info", "band");
  yield snapshot();
  await sleep(600);

  state.report = buildReport(enriched, state.findings, state.project.score ?? 0);
  state.project.status = "done";
  push(
    "orchestrator",
    `Workflow complete — readiness score ${state.project.score}/100. Open the dashboard for the full plan viewer and findings.`,
    "done",
    "band"
  );

  try {
    await saveState(state);
    await persistProject({ ...enriched, status: "done", score: state.project.score });
  } catch {
    /* best-effort */
  }
  yield snapshot();
}
