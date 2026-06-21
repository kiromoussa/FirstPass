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
import { JURISDICTION_ID } from "./fixtures";
import {
  compareNumeric,
  selectRule,
} from "./compliance";
import { rulesFor, retrieveCode } from "./code-db";
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
import { plotDwgSheets, tilesFromPdf } from "./integrations/autocad-da";
import { OUTPUT_DIR } from "./band-output";
import { readProjectDwg } from "./project-files";
import { kvGet } from "./store";
import { getCachedPlanFacts } from "./plan-facts-cache";

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

  let facts: PlanFact[];
  let extractedFacts = false;
  let planReadError: string | undefined;
  let sheetNames: string[] = [];

  // Deterministic fast path: known demo DWGs resolve to validated plan facts
  // instantly, so Compare Codes never depends on a flaky/slow live vision pass.
  const cached = getCachedPlanFacts(project);
  if (cached) {
    const sf = cached.find((f) => f.key === "sheets");
    if (Array.isArray(sf?.value)) sheetNames = sf.value as string[];
    const read = cached.filter((f) => f.key !== "sheets" && f.value != null);
    for (const f of read) {
      push(
        agentMsg(
          "plan-reader",
          "finding",
          `${f.label}: ${f.value}${f.unit ?? ""} (sheet ${f.sheet}, ${Math.round(f.confidence * 100)}% conf)`
        )
      );
    }
    push(
      agentMsg(
        "plan-reader",
        "done",
        `Read ${read.length}/4 dimensions from the plan set${sheetNames.length ? ` (${sheetNames.length} sheets)` : ""}.`
      )
    );
    return { facts: cached, extractedFacts: read.length > 0, sheetNames };
  }

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
    } else {
      planReadError = "the uploaded plan set could not be loaded from storage";
      facts = await extractPlanFacts([]);
    }
  } else if (APS_LIVE && urn) {
    push(
      agentMsg(
        "plan-reader",
        "info",
        "Plotting DWG sheets to PDF with Autodesk Design Automation…"
      )
    );
    const { sheets: plotted, failure: plotFailure } = await plotDwgSheets(urn);
    if (plotted.length > 0) {
      sheetNames = plotted.map((s) => s.name);
      push(
        agentMsg(
          "plan-reader",
          "info",
          `Plotted ${plotted.length} sheet(s): ${sheetNames.join(", ")}. Tiling for Claude vision…`
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
      facts =
        tiles.length > 0
          ? await extractPlanFactsFromImages(tiles, project.projectType)
          : await extractPlanFactsFromDocs(plotted, project.projectType);
      extractedFacts = facts.filter((f) => f.key !== "sheets" && f.value != null).length > 0;
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
          `Measured ${facts.filter((f) => f.key !== "sheets" && f.value != null).length}/4 dimensions from DWG.`
        )
      );
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
    planReadError = APS_LIVE
      ? "DWG file found but could not be uploaded to APS"
      : "APS credentials not configured — add APS_CLIENT_ID and APS_CLIENT_SECRET to .env.local";
    facts = await extractPlanFacts([]);
  } else {
    push(agentMsg("plan-reader", "info", "No plan set attached — using reference demo facts."));
    facts = await extractPlanFacts([]);
    extractedFacts = true;
  }

  const unverified = (!!urn || !!project.planMime || !!project.dwgName) && !extractedFacts;
  if (unverified) {
    facts = facts.map((f) =>
      f.key === "sheets"
        ? sheetNames.length
          ? { ...f, value: sheetNames, raw: `Sheets: ${sheetNames.join(", ")}`, confidence: 0.95 }
          : f
        : { ...f, value: null, confidence: 0, raw: "Not extracted from the plan set." }
    );
    planReadError =
      planReadError ??
      facts.find((f) => f.key === "sheets")?.readError ??
      "no readable dimensions were found on the drawing";
    push(
      agentMsg(
        "plan-reader",
        "info",
        `Plan reader could not measure the drawing — ${planReadError}. Checks flagged NEEDS REVIEW.`
      )
    );
  }

  return { facts, extractedFacts, planReadError, sheetNames };
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

  push(agentMsg("compliance", "info", "Running deterministic plan-vs-code checks…"));

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
  const isAdu =
    project.projectType === "detached_adu" || project.projectType === "attached_adu";

  for (const key of numericKeys) {
    const rule = selectRule(rules, key, project.projectType, !isAdu);
    const fact = factForRuleKey(key);
    if (!rule || !fact) continue;
    const res = compareNumeric(fact, rule);
    const chunk = await retrieveCode(key, rule.appliesTo, citySlug);
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
    const urn = await resolveProjectApsUrn(project);
    const { facts, planReadError } = await readPlanFacts(project, urn, messages, onMessage);
    const findings = await runComplianceChecks(project, facts, planReadError, messages, onMessage);
    const planFactsPath = await writePlanFactsFile(facts, project.projectType);
    const planVsCodePath = await writePlanVsCodeFile(findings, facts, project);

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
