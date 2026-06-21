// Plan Compliance Agent — partner's TypeScript pipeline (DWG/PDF → vision → compareNumeric)
// Registered in Band as **Compare Codes** (@varbtw/compare-codes). The Python listener
// calls POST /api/agents/compare-codes/run when @mentioned.
import fs from "fs/promises";
import path from "path";
import type {
  AgentMessage,
  AgentName,
  Finding,
  MessageType,
  PlanFact,
  Project,
  Sponsor,
} from "./types";
import { JURISDICTION_ID, deriveChecklist } from "./fixtures";
import {
  compareNumeric,
  selectRule,
} from "./compliance";
import { rulesFor, retrieveCodeForRule, retrieveCodeHybrid, resolveCitySlug } from "./code-db";
import { corpusChunkCount, runCorpusTopicChecks } from "./corpus-compliance";
import {
  extractPlanFacts,
  extractPlanFactsFromDoc,
  extractPlanFactsFromDocs,
  extractPlanFactsFromImages,
  interpretDwgText,
} from "./integrations/claude";
import {
  APS_LIVE,
  extractSheetText,
  listViewables,
  translate,
  uploadDwg,
  waitForTranslation,
} from "./integrations/aps";
import { plotDwgSheets, tilesFromPdf, type PlottedSheet } from "./integrations/autocad-da";
import { OUTPUT_DIR } from "./band-output";
import { readProjectDwg, projectDir } from "./project-files";
import { kvGet } from "./store";
import { getCachedPlanFacts } from "./plan-facts-cache";
import { loadPersistedPlanFacts, resolvePlanFacts } from "./plan-facts-store";

const RULE_LABELS: Record<string, string> = {
  maxSize: "Maximum unit size",
  height: "Height limit",
  setbackRear: "Rear setback",
  setbackSide: "Side setback",
  requiredDocs: "Required documents",
};

let seq = 0;
function agentMsg(
  from: AgentName,
  type: MessageType,
  text: string,
  opts: { sponsor?: Sponsor; refs?: string[] } = {}
): AgentMessage {
  return {
    id: `pca_${Date.now()}_${seq++}`,
    ts: Date.now(),
    from,
    type,
    text,
    sponsor: opts.sponsor ?? "claude",
    ...opts,
  };
}

export interface PlanComplianceResult {
  facts: PlanFact[];
  findings: Finding[];
  messages: AgentMessage[];
  planFactsPath?: string;
  planVsCodePath?: string;
  ok: boolean;
  error?: string;
}

async function findLocalDwgBytes(project: Project): Promise<Buffer | null> {
  return readProjectDwg(project);
}

/** Ensure project has an APS URN — upload staged DWG from projects/{id}/ when needed. */
export async function resolveProjectApsUrn(project: Project): Promise<string | undefined> {
  if (project.apsUrn) return project.apsUrn;
  if (!APS_LIVE || !project.dwgName) return undefined;
  const bytes = await findLocalDwgBytes(project);
  if (!bytes) return undefined;
  const up = await uploadDwg(project.dwgName, bytes);
  if (!up) return undefined;
  await translate(up.urn);
  return up.urn;
}

function formatPlanFactsReport(facts: PlanFact[], projectType: string): string {
  const lines = [
    "VISUAL PLAN ANALYSIS (Compare Codes — Claude vision + APS plot)",
    `Project type: ${projectType.replace(/_/g, " ")}`,
    "",
  ];
  for (const fact of facts) {
    if (fact.key === "sheets") {
      const sheets = fact.value;
      lines.push(
        `Sheets present: ${Array.isArray(sheets) ? sheets.join(", ") : sheets ?? "(none)"}`
      );
      continue;
    }
    const display =
      fact.value != null ? `${fact.value}${fact.unit ?? ""}` : "not shown";
    lines.push(
      `- ${fact.label} (${fact.key}): ${display} [sheet ${fact.sheet}, confidence ${Math.round((fact.confidence ?? 0) * 100)}%] — ${fact.raw ?? ""}`
    );
  }
  return lines.join("\n");
}

async function writePlanFactsFile(
  facts: PlanFact[],
  projectType: string
): Promise<string> {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const reportPath = path.join(OUTPUT_DIR, "plan_facts.txt");
  const header = [
    "FirstPass Visual Plan Analysis",
    `Project type: ${projectType.replace(/_/g, " ")}`,
    "Agent: Compare Codes (TypeScript — APS plot + Claude vision)",
    `${"=".repeat(60)}`,
    "",
  ].join("\n");
  await fs.writeFile(reportPath, header + formatPlanFactsReport(facts, projectType) + "\n", "utf-8");
  return reportPath;
}

async function writePlanVsCodeFile(
  findings: Finding[],
  facts: PlanFact[],
  project: Project
): Promise<string> {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const reportPath = path.join(OUTPUT_DIR, "plan_vs_code.txt");
  const lines = [
    "FirstPass Plan vs Code Comparison",
    "Agent: Compare Codes (deterministic compareNumeric + code RAG)",
    `Project: ${project.name}`,
    `Address: ${project.address}`,
    `Type: ${project.projectType.replace(/_/g, " ")}`,
    `${"=".repeat(60)}`,
    "",
    "FINDINGS",
    "--------",
  ];
  for (const f of findings) {
    const fact = facts.find((x) => x.key === (f.ruleKey === "maxSize" ? "unitSize" : f.ruleKey));
    const planVal =
      fact?.value != null ? `${fact.value}${fact.unit ?? ""}` : "not measured";
    lines.push(
      "",
      `${f.title} (${f.ruleKey})`,
      `  Verdict: ${f.status}`,
      `  Plan value: ${planVal}`,
      `  Detail: ${f.message}`,
      f.codeSection ? `  Code: ${f.codeSection}` : ""
    );
  }
  lines.push("", "End of comparison report.");
  await fs.writeFile(reportPath, lines.filter(Boolean).join("\n") + "\n", "utf-8");
  return reportPath;
}

async function loadPlottedSheetsFromDisk(projectId: string): Promise<PlottedSheet[]> {
  const dir = path.join(projectDir(projectId), "plans");
  try {
    const names = (await fs.readdir(dir))
      .filter((n) => n.toLowerCase().endsWith(".pdf") && !n.startsWith("."))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const sheets: PlottedSheet[] = [];
    for (const name of names.slice(0, 12)) {
      sheets.push({
        name: name.replace(/\.pdf$/i, ""),
        data: (await fs.readFile(path.join(dir, name))).toString("base64"),
      });
    }
    return sheets;
  } catch {
    return [];
  }
}

async function readFactsFromPlottedSheets(
  plotted: PlottedSheet[],
  project: Project,
  push: (m: AgentMessage) => void
): Promise<{ facts: PlanFact[]; extractedFacts: boolean; sheetNames: string[] }> {
  const sheetNames = plotted.map((s) => s.name);
  push(
    agentMsg(
      "plan-reader",
      "info",
      `Reading ${plotted.length} plotted sheet(s): ${sheetNames.join(", ")}. Tiling for Claude vision…`
    )
  );
  const tiles: { label: string; data: string }[] = [];
  for (const s of plotted) {
    if (tiles.length >= 80) break;
    tiles.push(...(await tilesFromPdf(s.data, s.name)));
  }
  push(
    agentMsg(
      "plan-reader",
      "info",
      `Reading ${tiles.length} tiles with Claude vision…`
    )
  );
  const facts =
    tiles.length > 0
      ? await extractPlanFactsFromImages(tiles, project.projectType)
      : await extractPlanFactsFromDocs(plotted, project.projectType);
  const extractedFacts = facts.filter((f) => f.key !== "sheets" && f.value != null).length > 0;
  for (const f of facts.filter((x) => x.key !== "sheets" && x.value != null)) {
    push(
      agentMsg(
        "plan-reader",
        "finding",
        `${f.label}: ${f.value}${f.unit} (sheet ${f.sheet}, ${Math.round(f.confidence * 100)}% conf)`
      )
    );
  }
  push(
    agentMsg(
      "plan-reader",
      "done",
      `Measured ${facts.filter((f) => f.key !== "sheets" && f.value != null).length}/4 dimensions from the plan set.`
    )
  );
  return { facts, extractedFacts, sheetNames };
}

async function finalizePlanFacts(
  project: Project,
  facts: PlanFact[],
  extractedFacts: boolean,
  sheetNames: string[],
  planReadError: string | undefined,
  push: (m: AgentMessage) => void
): Promise<{ facts: PlanFact[]; extractedFacts: boolean; planReadError?: string; sheetNames: string[] }> {
  const resolved = await resolvePlanFacts(project, facts, extractedFacts);
  const sf = resolved.facts.find((f) => f.key === "sheets");
  const names = Array.isArray(sf?.value)
    ? (sf.value as string[])
    : sheetNames.length
      ? sheetNames
      : [];

  if (resolved.source) {
    const label =
      resolved.source === "persisted"
        ? "cached plan measurements from a prior read of this file"
        : "validated measurements for this plan set";
    push(agentMsg("plan-reader", "info", `Using ${label}.`));
    for (const f of resolved.facts.filter((x) => x.key !== "sheets" && x.value != null)) {
      push(
        agentMsg(
          "plan-reader",
          "finding",
          `${f.label}: ${f.value}${f.unit} (sheet ${f.sheet}, ${Math.round(f.confidence * 100)}% conf)`
        )
      );
    }
    push(
      agentMsg(
        "plan-reader",
        "done",
        `Read ${resolved.facts.filter((f) => f.key !== "sheets" && f.value != null).length} dimensions from the plan set.`
      )
    );
    return { facts: resolved.facts, extractedFacts: true, sheetNames: names };
  }

  if (!resolved.extractedFacts) {
    const cleared = resolved.facts.map((f) =>
      f.key === "sheets"
        ? names.length
          ? { ...f, value: names, raw: `Sheets: ${names.join(", ")}`, confidence: 0.95 }
          : f
        : { ...f, value: null, confidence: 0, raw: "Not extracted from the plan set." }
    );
    const err =
      planReadError ??
      cleared.find((f) => f.key === "sheets")?.readError ??
      "no readable dimensions were found on the drawing";
    push(
      agentMsg(
        "plan-reader",
        "info",
        `Plan reader could not measure the drawing — ${err}. Checks flagged NEEDS REVIEW.`
      )
    );
    return { facts: cleared, extractedFacts: false, planReadError: err, sheetNames: names };
  }

  return { facts: resolved.facts, extractedFacts: true, planReadError, sheetNames: names };
}

async function readPlanFacts(
  project: Project,
  urn: string | undefined,
  messages: AgentMessage[],
  onMessage?: (m: AgentMessage) => void
): Promise<{ facts: PlanFact[]; extractedFacts: boolean; planReadError?: string; sheetNames: string[] }> {
  const push = (m: AgentMessage) => {
    messages.push(m);
    onMessage?.(m);
  };

  const persisted = await loadPersistedPlanFacts(project);
  if (persisted) {
    push(
      agentMsg(
        "plan-reader",
        "info",
        "Using saved plan measurements from a prior read of this file."
      )
    );
    const sf = persisted.find((f) => f.key === "sheets");
    const sheetNames = Array.isArray(sf?.value) ? (sf.value as string[]) : [];
    push(
      agentMsg(
        "plan-reader",
        "done",
        `Read ${persisted.filter((f) => f.key !== "sheets" && f.value != null).length} dimensions from cache.`
      )
    );
    return { facts: persisted, extractedFacts: true, sheetNames };
  }

  let facts: PlanFact[];
  let extractedFacts = false;
  let planReadError: string | undefined;
  let sheetNames: string[] = [];

  if (project.planMime) {
    push(
      agentMsg(
        "plan-reader",
        "info",
        `Reading the ${/pdf/i.test(project.planMime) ? "PDF" : "image"} plan set with Claude vision…`
      )
    );
    const stored = await kvGet<{ mediaType: string; data: string }>(`plan:${project.id}`);
    if (stored?.data) {
      facts = await extractPlanFactsFromDoc(stored.data, stored.mediaType, project.projectType);
      const read = facts.filter((f) => f.key !== "sheets" && f.value != null);
      const sf = facts.find((f) => f.key === "sheets");
      if (Array.isArray(sf?.value)) sheetNames = sf.value as string[];
      extractedFacts = read.length > 0;
      push(
        agentMsg(
          "plan-reader",
          "done",
          `Read ${read.length}/4 dimensions from uploaded plans${sheetNames.length ? ` (${sheetNames.length} sheets)` : ""}.`
        )
      );
      return finalizePlanFacts(project, facts, extractedFacts, sheetNames, planReadError, push);
    } else {
      planReadError = "the uploaded plan set could not be loaded from storage";
      facts = await extractPlanFacts([]);
    }
  } else if (APS_LIVE && urn) {
    const diskSheets = await loadPlottedSheetsFromDisk(project.id);
    if (diskSheets.length > 0) {
      push(
        agentMsg(
          "plan-reader",
          "info",
          `Using ${diskSheets.length} sheet(s) already plotted to projects/${project.id}/plans/…`
        )
      );
      const known = getCachedPlanFacts(project);
      if (known) {
        const sf = known.find((f) => f.key === "sheets");
        const names = Array.isArray(sf?.value) ? (sf.value as string[]) : diskSheets.map((s) => s.name);
        return finalizePlanFacts(project, known, true, names, undefined, push);
      }
      const read = await readFactsFromPlottedSheets(diskSheets, project, push);
      return finalizePlanFacts(project, read.facts, read.extractedFacts, read.sheetNames, planReadError, push);
    }

    push(
      agentMsg(
        "plan-reader",
        "info",
        "Plotting DWG sheets to PDF with Autodesk Design Automation…"
      )
    );
    const { sheets: plotted, failure: plotFailure } = await plotDwgSheets(urn);
    if (plotted.length > 0) {
      const read = await readFactsFromPlottedSheets(plotted, project, push);
      return finalizePlanFacts(project, read.facts, read.extractedFacts, read.sheetNames, planReadError, push);
    } else {
      push(
        agentMsg(
          "plan-reader",
          "info",
          `Could not plot DWG (${plotFailure ?? "unknown"}) — falling back to Model Derivative text.`
        )
      );
      const md = await waitForTranslation(urn);
      if (md && md.status !== "success") {
        push(
          agentMsg(
            "plan-reader",
            "info",
            `Autodesk translation ${md.status} — checks will be flagged for manual review.`
          )
        );
      }
      const lines: string[] = [];
      const sheets = await listViewables(urn);
      sheetNames = sheets.map((s) => s.name).filter((n) => n && !/^(2D|3D) Views$/i.test(n));
      for (const v of sheets) lines.push(...(await extractSheetText(urn, v)));
      facts =
        lines.length > 0
          ? ((extractedFacts = true), await interpretDwgText(lines))
          : await extractPlanFacts([]);
    }
  } else if (project.dwgName) {
    const diskSheets = await loadPlottedSheetsFromDisk(project.id);
    if (diskSheets.length > 0) {
      push(
        agentMsg(
          "plan-reader",
          "info",
          `Using ${diskSheets.length} sheet(s) from projects/${project.id}/plans/…`
        )
      );
      const known = getCachedPlanFacts(project);
      if (known) {
        const sf = known.find((f) => f.key === "sheets");
        const names = Array.isArray(sf?.value) ? (sf.value as string[]) : diskSheets.map((s) => s.name);
        return finalizePlanFacts(project, known, true, names, undefined, push);
      }
      const read = await readFactsFromPlottedSheets(diskSheets, project, push);
      return finalizePlanFacts(project, read.facts, read.extractedFacts, read.sheetNames, planReadError, push);
    }
    planReadError = APS_LIVE
      ? "DWG file found but could not be uploaded to APS"
      : "APS credentials not configured — add APS_CLIENT_ID and APS_CLIENT_SECRET to .env.local";
    facts = await extractPlanFacts([]);
  } else {
    push(agentMsg("plan-reader", "info", "No plan set attached — using reference demo facts."));
    facts = await extractPlanFacts([]);
    extractedFacts = true;
  }

  return finalizePlanFacts(project, facts, extractedFacts, sheetNames, planReadError, push);
}

async function runComplianceChecks(
  project: Project,
  facts: PlanFact[],
  planReadError: string | undefined,
  messages: AgentMessage[],
  onMessage?: (m: AgentMessage) => void
): Promise<Finding[]> {
  const push = (m: AgentMessage) => {
    messages.push(m);
    onMessage?.(m);
  };
  const citySlug = project.citySlug ?? JURISDICTION_ID;
  const rules = rulesFor(citySlug);
  const findings: Finding[] = [];
  const chunkN = corpusChunkCount(citySlug);

  push(
    agentMsg(
      "compliance",
      "info",
      chunkN
        ? `Running plan-vs-code checks against ${chunkN.toLocaleString()} chunked code sections (scripts/chunk_codes.py corpus)…`
        : "Running deterministic plan-vs-code checks…"
    )
  );

  const factForRuleKey = (k: string) =>
    facts.find((f) => f.key === (k === "maxSize" ? "unitSize" : k));
  const numericKeys = [
    ...new Set(
      rules
        .filter((r) => r.operator !== "present")
        .filter((r) => r.appliesTo === project.projectType || r.appliesTo === "any")
        .map((r) => r.key)
    ),
  ];

  for (const key of numericKeys) {
    const rule = selectRule(rules, key, project.projectType, true);
    const fact = factForRuleKey(key);
    if (!rule || !fact) continue;
    const res = compareNumeric(fact, rule);
    const chunk = await retrieveCodeForRule(key, rule.appliesTo, citySlug);
    const limit = `applicable limit: ${rule.operator} ${rule.threshold}${rule.unit ?? ""} (${chunk?.section ?? rule.sourceId})`;
    const detail =
      fact.value != null
        ? res.detail
        : planReadError
          ? `Plan reader couldn't measure this — ${planReadError}. ${limit}.`
          : `Not shown on readable sheets — ${limit}. Verify manually.`;
    const finding: Finding = {
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
    findings.push(finding);
    push(
      agentMsg(
        "compliance",
        res.status === "FAIL" ? "finding" : "info",
        `${finding.title}: ${res.status} — ${detail}`,
        { refs: [finding.id] }
      )
    );
  }

  const checklist = deriveChecklist(facts);
  const missing = checklist.filter((c) => c.required && c.present === false);
  const docsChunk = await retrieveCodeHybrid("requiredDocs", undefined, citySlug);
  const docsFinding: Finding = {
    id: "f_requiredDocs",
    ruleKey: "requiredDocs",
    title: "Required documents",
    status: missing.length ? "NEEDS_REVIEW" : "PASS",
    message: missing.length
      ? `Missing or not identified on sheets: ${missing.map((m) => m.item).join(", ")}.`
      : "Required submittal sheets appear present in the plan set.",
    sourceRef: "S4",
    codeSection: docsChunk?.section,
    codeText: docsChunk?.text,
  };
  findings.push(docsFinding);
  push(
    agentMsg(
      "compliance",
      docsFinding.status === "PASS" ? "info" : "finding",
      `${docsFinding.title}: ${docsFinding.status} — ${docsFinding.message}`,
      { refs: [docsFinding.id] }
    )
  );

  const corpusFindings = await runCorpusTopicChecks(project, facts, citySlug);
  for (const f of corpusFindings) {
    findings.push(f);
    push(
      agentMsg(
        "compliance",
        "finding",
        `${f.title}: ${f.status} — ${f.message}`,
        { refs: [f.id] }
      )
    );
  }

  push(
    agentMsg(
      "compliance",
      "done",
      `Compare Codes finished — ${findings.filter((f) => f.status === "FAIL").length} likely violation(s), ${findings.filter((f) => f.status === "NEEDS_REVIEW").length} need review.`
    )
  );
  return findings;
}

/** Run Compare Codes pipeline: read plans (DWG/PDF) and compare to governing code. */
export async function runPlanComplianceAgent(
  project: Project,
  onMessage?: (m: AgentMessage) => void
): Promise<PlanComplianceResult> {
  const messages: AgentMessage[] = [];
  const push = (m: AgentMessage) => {
    messages.push(m);
    onMessage?.(m);
  };

  push(
    agentMsg(
      "orchestrator",
      "info",
      "Compare Codes starting — APS plot → Claude vision → deterministic code compare.",
      { sponsor: "band" }
    )
  );

  try {
    const citySlug = project.citySlug ?? (await resolveCitySlug(project.address));
    const enriched: Project = { ...project, citySlug, jurisdictionId: citySlug };
    const urn = await resolveProjectApsUrn(enriched);
    const { facts, planReadError } = await readPlanFacts(enriched, urn, messages, onMessage);
    const findings = await runComplianceChecks(enriched, facts, planReadError, messages, onMessage);
    const planFactsPath = await writePlanFactsFile(facts, enriched.projectType);
    const planVsCodePath = await writePlanVsCodeFile(findings, facts, enriched);

    push(
      agentMsg(
        "orchestrator",
        "done",
        `Compare Codes wrote ${planFactsPath} and ${planVsCodePath}. Solutions can proceed.`,
        { sponsor: "band" }
      )
    );

    return {
      facts,
      findings,
      messages,
      planFactsPath,
      planVsCodePath,
      ok: true,
    };
  } catch (e) {
    const error = (e as Error).message;
    push(
      agentMsg("orchestrator", "info", `Compare Codes failed: ${error}`, {
        sponsor: "band",
      })
    );
    return { facts: [], findings: [], messages, ok: false, error };
  }
}

export function projectHasPlanInput(project: Project): boolean {
  return !!(project.apsUrn || project.planMime || project.dwgName);
}

/** Alias — Compare Codes is the Band-facing name for this pipeline. */
export const runCompareCodesAgent = runPlanComplianceAgent;
