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
import { JURISDICTION_ID, deriveChecklist } from "./fixtures";
import { researchSources } from "./integrations/browserbase";
import { extractPlanFacts, explain, interpretDwgText, extractPlanFactsFromDoc, extractPlanFactsFromDocs, extractPlanFactsFromImages } from "./integrations/claude";
import { APS_LIVE, listViewables, extractSheetText, waitForTranslation } from "./integrations/aps";
import { plotDwgSheets, tilesFromPdf } from "./integrations/autocad-da";
import {
  persistPlotViewerFromSheets,
  setPlotViewerFailed,
} from "./plot-viewer-cache";
import { evaluateFinding } from "./integrations/arize";
import { BandChannel } from "./integrations/band";
import { flushTraces } from "./integrations/otel";
import {
  compareNumeric,
  selectRule,
  scoreFrom,
  languageLint,
} from "./compliance";
import { saveState, kvGet, kvSet } from "./store";
import { seedCodeChunks, retrieveCodeHybrid, cityLabel, rulesFor } from "./code-db";

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
  // The city corpus this run retrieves code from (data/cities/<slug>).
  const citySlug = project.citySlug ?? JURISDICTION_ID;
  // The jurisdiction's own compliance rules (LA plan → LA limits, Alameda plan →
  // Alameda limits). Falls back to the built-in set for un-researched cities.
  const rules = rulesFor(citySlug);
  const state: ProjectState = {
    project: { ...project, status: "jurisdiction" },
    sources: [],
    rules,
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
    msg("jurisdiction", "done", `Resolved jurisdiction: ${cityLabel(citySlug)} · agencies: Planning, Building.`, { sponsor: "claude" })
  );
  state.project.jurisdictionId = citySlug;
  yield snapshot();
  await sleep(400);

  // ---- Phase 2: Code Research (Browserbase) ----
  state.project.status = "research";
  emit(msg("research", "info", `Navigating ${cityLabel(citySlug)} planning & building sources…`, { sponsor: "browserbase" }));
  yield snapshot();
  const { sources, live } = await researchSources(citySlug);
  state.sources = sources;
  emit(
    msg(
      "research",
      "info",
      `Captured ${sources.length} official sources ${live ? "(live)" : "(cached)"} with retrieval dates.`,
      { sponsor: live ? "browserbase" : "redis", refs: sources.map((s) => s.id) }
    )
  );
  yield snapshot();
  const chunkCount = await seedCodeChunks(citySlug);
  emit(
    msg("research", "done", `Indexed ${chunkCount} chunked code sections to Redis — checks retrieve only the relevant chunk (token-efficient).`, { sponsor: "redis" })
  );
  yield snapshot();
  await sleep(400);

  // ---- Phase 3: Plan Reading (APS translation + Claude) ----
  state.project.status = "read";
  let facts: PlanFact[];
  // `extractedFacts` = we genuinely read dimensioned values off the drawing.
  // When a DWG is uploaded but nothing readable comes back, we must NOT pass the
  // reference demo numbers off as measured — the checks become "needs review".
  let extractedFacts = false;
  // Set when the plan READER itself failed (token-budget truncation, refusal,
  // API/parse error, or the set couldn't be loaded) — distinct from a dimension
  // simply not being drawn. Drives a specific, actionable finding message.
  let planReadError: string | undefined;
  let sheetNames: string[] = [];
  const urn = project.apsUrn;
  if (project.planMime) {
    // Accurate path: Claude reads the uploaded plan set (PDF/image) natively.
    emit(msg("plan-reader", "info", `Reading the ${/pdf/i.test(project.planMime) ? "PDF" : "image"} plan set with Claude vision — measuring dimensions off the drawings…`, { sponsor: "claude" }));
    yield snapshot();
    const stored = await kvGet<{ mediaType: string; data: string }>(`plan:${project.id}`);
    if (stored?.data) {
      facts = await extractPlanFactsFromDoc(stored.data, stored.mediaType, project.projectType);
      const read = facts.filter((f) => f.key !== "sheets" && f.value != null);
      const sf = facts.find((f) => f.key === "sheets");
      if (Array.isArray(sf?.value)) sheetNames = sf.value as string[];
      extractedFacts = read.length > 0;
      emit(msg("plan-reader", "done", `Read ${read.length}/4 dimensions from the plans${sheetNames.length ? ` across ${sheetNames.length} sheets` : ""}. Unread values will be flagged for manual review.`, { sponsor: "claude" }));
      yield snapshot();
    } else {
      emit(msg("plan-reader", "info", "Plan set could not be loaded — flagging checks for manual review.", { sponsor: "claude" }));
      planReadError = "the uploaded plan set could not be loaded from storage";
      facts = await extractPlanFacts([]);
    }
  } else if (APS_LIVE && urn) {
    // Accurate DWG path: plot every layout to a legible PDF with Autodesk Design
    // Automation (real AutoCAD in the cloud), then read the sheets with Claude
    // vision. APS Model Derivative properties are empty and its rasters are
    // illegible, so this plot→vision route is what makes DWG facts trustworthy.
    emit(msg("plan-reader", "info", "Plotting the DWG sheets to PDF with Autodesk (AutoCAD cloud)…", { sponsor: "claude" }));
    yield snapshot();
    const { sheets: plotted, failure: plotFailure } = await plotDwgSheets(urn);
    if (plotted.length > 0) {
      sheetNames = plotted.map((s) => s.name);
      emit(msg("plan-reader", "info", `Plotted ${plotted.length} sheet${plotted.length === 1 ? "" : "s"} (${sheetNames.join(", ")}). Tiling at high resolution so dimensions are legible…`, { sponsor: "claude" }));
      yield snapshot();
      // Persist display renders for the in-app viewer (PlanSheetViewer).
      try {
        await persistPlotViewerFromSheets(project.id, plotted);
      } catch {
        /* viewer falls back to schematic */
      }
      // Tile each sheet into high-DPI crops — a full ARCH-D sheet downsampled to
      // vision's ~1568px makes dimension text unreadable; tiles keep it legible.
      const tiles: { label: string; data: string }[] = [];
      for (const s of plotted) {
        if (tiles.length >= 80) break; // stay under the 100-image/request cap
        tiles.push(...(await tilesFromPdf(s.data, s.name)));
      }
      emit(msg("plan-reader", "info", `Reading ${tiles.length} sheet tiles with Claude vision — measuring dimensions off the drawings…`, { sponsor: "claude" }));
      yield snapshot();
      facts = tiles.length > 0
        ? await extractPlanFactsFromImages(tiles, project.projectType)
        : await extractPlanFactsFromDocs(plotted, project.projectType);
      const read = facts.filter((f) => f.key !== "sheets" && f.value != null);
      extractedFacts = read.length > 0;
      for (const f of facts.filter((x) => x.key !== "sheets" && x.value != null)) {
        emit(msg("plan-reader", "finding", `Read ${f.label}: ${f.value}${f.unit} from sheet ${f.sheet} (${Math.round(f.confidence * 100)}% conf) — "${f.raw}".`, { sponsor: "claude" }));
      }
      emit(msg("plan-reader", "done", `Read ${read.length}/4 dimensions across ${plotted.length} plotted sheets. Unread values will be flagged for manual review.`, { sponsor: "claude" }));
      yield snapshot();
    } else {
      // DA unavailable/failed → fall back to the (text) extraction path, which is
      // honest about what it can and can't read.
      emit(msg("plan-reader", "info", `Could not plot the DWG (${plotFailure ?? "unknown reason"}) — falling back to text extraction; unread checks will be flagged for manual review.`, { sponsor: "claude" }));
      yield snapshot();
      // Tell the in-app viewer there are no sheets to show so it stops waiting and
      // surfaces a clean message instead of spinning forever.
      await setPlotViewerFailed(project.id, plotFailure);
      // The text-extraction path reads Model Derivative metadata, which only
      // exists once translation completes. translate() was kicked off at upload
      // and never awaited, so wait for it here before listing/reading viewables —
      // otherwise we'd read an empty manifest and flag everything for review.
      const md = await waitForTranslation(urn);
      if (md && md.status !== "success") {
        emit(msg("plan-reader", "info", `Autodesk translation ${md.status} (${md.progress}) — no readable sheets; checks will be flagged for manual review.`, { sponsor: "claude" }));
        yield snapshot();
      }
      const lines: string[] = [];
      const sheets = await listViewables(urn);
      sheetNames = sheets.map((s) => s.name).filter((n) => n && !/^(2D|3D) Views$/i.test(n));
      for (const v of sheets) lines.push(...(await extractSheetText(urn, v)));
      facts = lines.length > 0 ? ((extractedFacts = true), await interpretDwgText(lines)) : await extractPlanFacts([]);
    }
  } else {
    // No DWG uploaded — the curated reference set is the intended demo input.
    emit(msg("plan-reader", "info", "Reading the reference plan set and extracting structured facts…", { sponsor: "claude" }));
    yield snapshot();
    facts = await extractPlanFacts(pageImages);
    extractedFacts = true;
  }

  // Honesty gate: a DWG was uploaded but we couldn't measure it → don't fabricate
  // values. Null the numeric facts (engine → NEEDS_REVIEW) but keep the REAL
  // sheet list we got from the translation.
  const unverified = (!!urn || !!project.planMime) && !extractedFacts;
  if (unverified) {
    facts = facts.map((f) =>
      f.key === "sheets"
        ? sheetNames.length
          ? { ...f, value: sheetNames, raw: `Sheets in set: ${sheetNames.join(", ")}`, confidence: 0.95 }
          : f
        : { ...f, value: null, confidence: 0, raw: "Not extracted — the DWG exposed no readable dimension text." }
    );
  }

  // Surface WHY the read failed, not just that values are missing. Prefer the
  // reason the reader reported (truncation / refusal / API error); fall back to
  // the generic "nothing readable" only when the reader gave no specific cause.
  if (unverified) {
    planReadError =
      planReadError ??
      facts.find((f) => f.key === "sheets")?.readError ??
      "no readable dimensions were found on the drawing";
    emit(
      msg("plan-reader", "info", `Plan reader could not measure the drawing — ${planReadError}. The four dimensional checks are flagged for manual verification.`, { sponsor: "claude" })
    );
    yield snapshot();
  }

  state.facts = facts;
  const shown = facts.filter((f) => f.key !== "sheets").slice(0, 3);
  for (const f of shown) {
    const valStr = f.value == null ? "not found in drawing" : `${f.value}${f.unit && f.unit !== "docs" ? f.unit : ""}`;
    emit(
      msg("plan-reader", f.value == null ? "info" : "finding", `${f.label}: ${valStr} (sheet ${f.sheet}, ${Math.round(f.confidence * 100)}% conf)`, { sponsor: "claude" })
    );
  }
  yield snapshot();
  await sleep(400);

  // ---- Phase 4: Compliance (deterministic, buggy first pass) ----
  state.project.status = "comply";
  emit(msg("compliance", "info", "Running deterministic compliance checks…"));
  yield snapshot();

  // Fact key for a rule key — only maxSize reads off the unitSize fact; every
  // other rule key shares its fact key directly (height, setback*, lotCoverage,
  // far, parking …).
  const factForRuleKey = (k: string) => facts.find((f) => f.key === (k === "maxSize" ? "unitSize" : k));
  // Every numeric rule that applies to this project type (its own subtype or
  // "any"), deduped in stable order — this is the set of checks we run. ADU
  // projects get {maxSize, height, setback*}; single/multi-family additionally
  // get {setbackFront, lotCoverage, far, parking}.
  const numericKeys = [
    ...new Set(
      rules
        .filter((r) => r.operator !== "present")
        .filter((r) => r.appliesTo === project.projectType || r.appliesTo === "any")
        .map((r) => r.key)
    ),
  ];
  // ADU keeps the scripted "buggy first pass" (applicability OFF) so the wrong
  // attached-vs-detached rule is picked and Arize can catch it. Single/multi-
  // family enforce applicability from the start — there's no scripted bug there.
  const isAdu = project.projectType === "detached_adu" || project.projectType === "attached_adu";

  for (const key of numericKeys) {
    const rule = selectRule(rules, key, project.projectType, !isAdu);
    const fact = factForRuleKey(key);
    if (!rule || !fact) continue;
    const res = compareNumeric(fact, rule);
    const chunk = await retrieveCodeHybrid(key, rule.appliesTo, citySlug); // RAG: RedisVL hybrid, lexical fallback
    // When the value is missing, distinguish a READER failure (truncation /
    // refusal / API error — re-running may fix it) from a value that's simply
    // not drawn on the legible sheets. Either way, cite the applicable limit so
    // the reviewer knows exactly what to verify by hand.
    const limit = `applicable limit: ${rule.operator} ${rule.threshold}${rule.unit ?? ""} (${chunk?.section ?? rule.sourceId})`;
    const detail =
      fact.value != null
        ? res.detail
        : planReadError
        ? `Plan reader couldn't measure this — ${planReadError}. ${limit}. Re-run the read, or verify manually.`
        : `Not shown on the readable sheets — ${limit}. Verify manually.`;
    const f: Finding = {
      id: `f_${key}`,
      ruleKey: key,
      title: RULE_LABELS[key] ?? rule.label,
      status: res.status,
      message: detail,
      factRef: fact.key,
      ruleRef: rule.key,
      sourceRef: rule.sourceId,
      bbox: fact.bbox,
      sheet: fact.sheet,
      codeSection: chunk?.section,
      codeText: chunk?.text,
    };
    state.findings.push(f);
    emit(
      msg("compliance", res.status === "FAIL" ? "finding" : "info", `${f.title}: ${res.status} — ${detail}`, { refs: [f.id] })
    );
    await sleep(250);
    yield snapshot();
  }

  // Required documents check
  const checklist = deriveChecklist(facts);
  state.checklist = checklist;
  const missing = checklist.filter((c) => c.required && c.present === false);
  const docsChunk = await retrieveCodeHybrid("requiredDocs", undefined, citySlug);
  const docsFinding: Finding = {
    id: "f_requiredDocs",
    ruleKey: "requiredDocs",
    title: "Required documents",
    status: missing.length ? "NEEDS_REVIEW" : "PASS",
    message: missing.length
      ? `Missing: ${missing.map((m) => m.item).join(", ")}.`
      : "All required documents present.",
    sourceRef: "S4",
    codeSection: docsChunk?.section,
    codeText: docsChunk?.text,
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
    const rule = rules.find((r) => r.key === f.ruleKey && r.sourceId === f.sourceRef) ?? rules.find((r) => r.key === f.ruleKey);
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

      // Re-select WITH applicability enforced → the rule for this project type.
      const correctRule = selectRule(rules, f.ruleKey, project.projectType, true);
      const correctFact = factForRuleKey(f.ruleKey);
      if (correctRule && correctFact) {
        const res = compareNumeric(correctFact, correctRule);
        f.previousStatus = f.status;
        f.status = res.status;
        f.message = res.detail;
        f.ruleRef = correctRule.key;
        f.sourceRef = correctRule.sourceId;
        const correctChunk = await retrieveCodeHybrid(f.ruleKey, correctRule.appliesTo, citySlug);
        f.codeSection = correctChunk?.section ?? f.codeSection;
        f.codeText = correctChunk?.text ?? f.codeText;
        f.corrected = true;
        f.evals = evaluateFinding({
          finding: f,
          rule: correctRule,
          fact: correctFact,
          source: state.sources.find((s) => s.id === correctRule.sourceId),
          projectSubtype: project.projectType,
        });
        emit(
          msg("compliance", "retry", `Re-ran ${f.title} with the ${correctRule.appliesTo.replace(/_/g, " ")} rule (source ${correctRule.sourceId}): ${f.previousStatus} → ${f.status}.`, { sponsor: "arize", refs: [f.id] })
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
