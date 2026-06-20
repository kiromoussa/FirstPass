// Orchestrator (PLAN.md §6). Async generator that runs each agent in sequence,
// publishes Band messages, performs the deterministic checks, and executes the
// scripted Reviewer/Arize correction. Yields a full ProjectState after each
// step so the SSE route can stream progress to the dashboard.
import type {
  Project,
  ProjectState,
  AgentMessage,
  AgentName,
  MessageType,
  Sponsor,
  Finding,
  PlanFact,
  Report,
  ReportSection,
} from "./types";
import { DISCLAIMER } from "./types";
import { RULES, JURISDICTION_ID, deriveChecklist } from "./fixtures";
import { researchSources } from "./integrations/browserbase";
import { extractPlanFacts, explain, interpretDwgText } from "./integrations/claude";
import { APS_LIVE, manifest, extractText } from "./integrations/aps";
import { evaluateFinding } from "./integrations/arize";
import { BandChannel } from "./integrations/band";
import { flushTraces } from "./integrations/otel";
import {
  compareNumeric,
  selectRule,
  scoreFrom,
  languageLint,
} from "./compliance";
import { saveState } from "./store";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
function msg(
  from: AgentName,
  type: MessageType,
  text: string,
  opts: { to?: AgentName; sponsor?: Sponsor; refs?: string[] } = {}
): AgentMessage {
  return {
    id: `m${Date.now()}_${seq++}`,
    ts: Date.now(),
    from,
    type,
    text,
    ...opts,
  };
}

const RULE_LABELS: Record<string, string> = {
  maxSize: "Maximum unit size",
  height: "Height limit",
  setbackRear: "Rear setback",
  setbackSide: "Side setback",
  requiredDocs: "Required documents",
};

export async function* runPipeline(
  project: Project,
  channel: BandChannel,
  pageImages: string[] = []
): AsyncGenerator<ProjectState> {
  const state: ProjectState = {
    project: { ...project, status: "jurisdiction" },
    sources: [],
    rules: RULES,
    facts: [],
    findings: [],
    checklist: [],
    messages: [],
    report: undefined,
  };

  const emit = (m: AgentMessage) => {
    channel.publish(m);
    state.messages.push(m);
  };
  const snapshot = (): ProjectState => ({
    ...state,
    messages: [...state.messages],
    findings: state.findings.map((f) => ({ ...f })),
  });

  // ---- Phase 1: Jurisdiction ----
  state.project.status = "jurisdiction";
  emit(msg("orchestrator", "info", `Starting FirstPass for "${project.name}".`));
  yield snapshot();
  await sleep(500);
  emit(
    msg("jurisdiction", "done", `Resolved jurisdiction: Alameda, CA · agencies: Planning, Building.`, { sponsor: "claude" })
  );
  state.project.jurisdictionId = JURISDICTION_ID;
  yield snapshot();
  await sleep(400);

  // ---- Phase 2: Code Research (Browserbase) ----
  state.project.status = "research";
  emit(msg("research", "info", "Navigating Alameda planning & building sources…", { sponsor: "browserbase" }));
  yield snapshot();
  const { sources, live } = await researchSources();
  state.sources = sources;
  emit(
    msg(
      "research",
      "done",
      `Captured ${sources.length} official sources ${live ? "(live)" : "(cached)"}. Stored to Redis with retrieval dates.`,
      { sponsor: live ? "browserbase" : "redis", refs: sources.map((s) => s.id) }
    )
  );
  yield snapshot();
  await sleep(400);

  // ---- Phase 3: Plan Reading (APS translation + Claude) ----
  state.project.status = "read";
  let facts: PlanFact[];
  const urn = project.apsUrn;
  if (APS_LIVE && urn) {
    emit(msg("plan-reader", "info", "Checking Autodesk translation of the DWG…", { sponsor: "claude" }));
    yield snapshot();
    // Translation was kicked off at upload; poll briefly so the demo stays snappy.
    let mfst = await manifest(urn);
    for (let i = 0; i < 5 && mfst && mfst.status !== "success" && mfst.status !== "failed"; i++) {
      emit(msg("plan-reader", "info", `DWG translating… ${mfst.progress}`));
      yield snapshot();
      await sleep(3000);
      mfst = await manifest(urn);
    }
    if (mfst?.status === "success") {
      emit(msg("plan-reader", "done", "DWG translated. Extracting text & properties from the model…", { sponsor: "claude" }));
      yield snapshot();
      const lines = await extractText(urn);
      facts = await interpretDwgText(lines);
    } else {
      emit(msg("plan-reader", "info", "Translation still processing — using the validated reference facts for this pass.", { sponsor: "claude" }));
      facts = await extractPlanFacts(pageImages);
    }
  } else {
    emit(msg("plan-reader", "info", "Reading the plan set and extracting structured facts…", { sponsor: "claude" }));
    yield snapshot();
    facts = await extractPlanFacts(pageImages);
  }
  state.facts = facts;
  const shown = facts.filter((f) => f.key !== "sheets").slice(0, 3);
  for (const f of shown) {
    emit(
      msg("plan-reader", "finding", `${f.label}: ${f.value}${f.unit && f.unit !== "docs" ? f.unit : ""} (sheet ${f.sheet}, ${Math.round(f.confidence * 100)}% conf)`, { sponsor: "claude" })
    );
  }
  yield snapshot();
  await sleep(400);

  // ---- Phase 4: Compliance (deterministic, buggy first pass) ----
  state.project.status = "comply";
  emit(msg("compliance", "info", "Running deterministic compliance checks…"));
  yield snapshot();

  const factByKey = (k: string) => facts.find((f) => f.key === (k === "setbackRear" || k === "setbackSide" ? k : k === "maxSize" ? "unitSize" : k));
  const numericKeys = ["maxSize", "height", "setbackRear", "setbackSide"];

  for (const key of numericKeys) {
    // First pass deliberately does NOT enforce applicability — this is how the
    // wrong (attached) height rule gets selected, the bug Arize will catch.
    const rule = selectRule(RULES, key, project.projectType, false);
    const fact = factByKey(key);
    if (!rule || !fact) continue;
    const res = compareNumeric(fact, rule);
    const f: Finding = {
      id: `f_${key}`,
      ruleKey: key,
      title: RULE_LABELS[key],
      status: res.status,
      message: res.detail,
      factRef: fact.key,
      ruleRef: rule.key,
      sourceRef: rule.sourceId,
      bbox: fact.bbox,
      sheet: fact.sheet,
    };
    state.findings.push(f);
    emit(
      msg("compliance", res.status === "FAIL" ? "finding" : "info", `${f.title}: ${res.status} — ${res.detail}`, { refs: [f.id] })
    );
    await sleep(250);
    yield snapshot();
  }

  // Required documents check
  const checklist = deriveChecklist(facts);
  state.checklist = checklist;
  const missing = checklist.filter((c) => c.required && c.present === false);
  const docsFinding: Finding = {
    id: "f_requiredDocs",
    ruleKey: "requiredDocs",
    title: "Required documents",
    status: missing.length ? "NEEDS_REVIEW" : "PASS",
    message: missing.length
      ? `Missing: ${missing.map((m) => m.item).join(", ")}.`
      : "All required documents present.",
    sourceRef: "S4",
  };
  state.findings.push(docsFinding);
  emit(msg("checklist", "info", `${docsFinding.title}: ${docsFinding.status} — ${docsFinding.message}`, { refs: [docsFinding.id] }));
  yield snapshot();
  await sleep(400);

  // ---- Phase 5: Review (Arize evals + correction) ----
  state.project.status = "review";
  emit(msg("reviewer", "info", "Auditing findings with Arize evals (citation, authority, applicability, hallucination)…", { sponsor: "arize" }));
  yield snapshot();
  await sleep(300);

  for (const f of state.findings) {
    const rule = RULES.find((r) => r.key === f.ruleKey && r.sourceId === f.sourceRef) ?? RULES.find((r) => r.key === f.ruleKey);
    const fact = facts.find((x) => x.key === f.factRef);
    const source = state.sources.find((s) => s.id === f.sourceRef);
    const evals = evaluateFinding({ finding: f, rule, fact, source, projectSubtype: project.projectType });
    f.evals = evals;

    const applicability = evals.find((e) => e.dimension === "applicability");
    if (applicability && !applicability.passed) {
      // The scripted disagreement + correction (Band message bus).
      emit(
        msg("reviewer", "disagreement", `DISAGREE on ${f.title}: ${applicability.rationale} Re-run with the correct rule.`, { to: "compliance", sponsor: "arize", refs: [f.id] })
      );
      yield snapshot();
      await sleep(700);

      // Re-select WITH applicability enforced → the correct detached rule.
      const correctRule = selectRule(RULES, f.ruleKey, project.projectType, true);
      const correctFact = facts.find((x) => x.key === (f.ruleKey === "maxSize" ? "unitSize" : f.ruleKey));
      if (correctRule && correctFact) {
        const res = compareNumeric(correctFact, correctRule);
        f.previousStatus = f.status;
        f.status = res.status;
        f.message = res.detail;
        f.ruleRef = correctRule.key;
        f.sourceRef = correctRule.sourceId;
        f.corrected = true;
        f.evals = evaluateFinding({
          finding: f,
          rule: correctRule,
          fact: correctFact,
          source: state.sources.find((s) => s.id === correctRule.sourceId),
          projectSubtype: project.projectType,
        });
        emit(
          msg("compliance", "retry", `Re-ran ${f.title} with detached-ADU rule (source ${correctRule.sourceId}): ${f.previousStatus} → ${f.status}.`, { sponsor: "arize", refs: [f.id] })
        );
        yield snapshot();
        await sleep(400);
      }
    }
  }
  emit(msg("reviewer", "done", "Eval pass complete. Findings audited and corrected where needed."));
  yield snapshot();
  await sleep(300);

  // ---- Phase 6: Report (Claude writing) + score ----
  state.project.status = "report";
  emit(msg("report", "info", "Composing the cited permit-readiness report…", { sponsor: "claude" }));
  yield snapshot();

  const score = scoreFrom(state.findings.map((f) => f.status));
  state.project.score = score;

  // Suggested corrections for non-PASS findings (Claude, with safe fallback).
  for (const f of state.findings) {
    if (f.status === "PASS") continue;
    const fallback =
      f.status === "FAIL"
        ? `Adjust the design so ${f.title.toLowerCase()} meets the cited requirement before submission.`
        : f.status === "WARNING"
        ? `${f.title} is close to the limit — verify the dimension and consider added margin.`
        : `Provide the missing information for ${f.title.toLowerCase()} and re-check.`;
    f.suggestedCorrection = languageLint(
      await explain(
        `In one sentence, suggest how a residential architect could resolve this pre-submission finding: "${f.title}: ${f.message}". Use cautious language (likely/potential).`,
        fallback
      )
    );
  }

  const sections: ReportSection[] = state.findings.map((f) => ({
    heading: f.title,
    status: f.status,
    body: languageLint(`${f.message}${f.suggestedCorrection ? ` Suggested: ${f.suggestedCorrection}` : ""}`),
    citationSourceId: f.sourceRef,
  }));
  const counts = state.findings.reduce(
    (a, f) => ((a[f.status] = (a[f.status] || 0) + 1), a),
    {} as Record<string, number>
  );
  const summary = languageLint(
    `Permit-readiness score ${score}/100 for this detached ADU in Alameda, CA. ` +
      `${counts.FAIL || 0} likely violation(s), ${counts.WARNING || 0} warning(s), ${counts.NEEDS_REVIEW || 0} item(s) needing review. ` +
      `All findings are pre-submission and require professional confirmation.`
  );
  const report: Report = {
    projectId: project.id,
    score,
    summary,
    sections,
    generatedAt: Date.now(),
    disclaimer: DISCLAIMER,
  };
  state.report = report;
  state.project.status = "done";
  emit(msg("report", "done", `Report ready. Readiness score: ${score}/100.`, { sponsor: "claude" }));
  yield snapshot();

  await saveState(state);
  await flushTraces(); // ensure Arize spans export before the request ends
}
