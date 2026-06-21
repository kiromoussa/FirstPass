// Demo-paced pipeline — a deterministic, reliable walk through the FirstPass
// phases for the Los Angeles(1).dwg garage-conversion ADU. Used for live demos
// (gated by FIRSTPASS_DEMO=1) so the run visibly iterates through every step,
// shows real findings + a cited report, and never depends on flaky live agent
// handoffs. The DWG sheet viewer is served from the seeded plot cache.
import type {
  AgentMessage,
  Finding,
  Project,
  ProjectState,
  Report,
  ChecklistItem,
  PlanFact,
} from "./types";
import type { BandChannel } from "./integrations/band";
import { rulesFor } from "./code-db";
import { JURISDICTION_ID } from "./fixtures";
import { saveState } from "./store";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FACTS: PlanFact[] = [
  { key: "unitSize", label: "ADU size", value: 361, unit: "sqft", sheet: "A1.0", bbox: null, confidence: 0.95, raw: "EXISTING (361 SQ.FT.) GARAGE TO BE CONVERTED TO ADU" },
  { key: "height", label: "Building height", value: 19, unit: "ft", sheet: "A5.0", bbox: null, confidence: 0.93, raw: "TOP OF ROOF ±19'-0\"" },
  { key: "setbackSide", label: "Side setback", value: 8, unit: "ft", sheet: "A1.0", bbox: null, confidence: 0.9, raw: "8'-0\" side yard" },
  { key: "setbackRear", label: "Rear setback", value: 9.83, unit: "ft", sheet: "A1.0", bbox: null, confidence: 0.9, raw: "9'-10\" rear yard" },
];

const FINDINGS: Finding[] = [
  {
    id: "f_size", ruleKey: "maxSize", title: "ADU size within limit", status: "PASS",
    message: "361 sq ft is well under the 1,200 sq ft maximum for a converted/detached ADU.",
    factRef: "unitSize", sheet: "A1.0",
    codeSection: "LAMC §12.22-A.33", codeText: "An ADU shall not exceed 1,200 square feet of floor area.",
  },
  {
    id: "f_height", ruleKey: "height", title: "Building height needs review", status: "NEEDS_REVIEW",
    message: "Roof at ±19'-0\" exceeds the 16 ft base limit. Permitted up to 18 ft (or 25 ft / 2 stories under SB 1211) only if the parcel is within 1/2 mile of a major transit stop.",
    suggestedCorrection: "Add a transit-distance exhibit on A0.0, or drop the ridge ~3 ft on A5.0 to ≤16 ft.",
    factRef: "height", sheet: "A5.0",
    codeSection: "CA Gov. Code §65852.2(a)(1)(D)", codeText: "Local agencies shall not impose a height limit below 16 feet; higher limits apply near transit and for detached ADUs.",
  },
  {
    id: "f_side", ruleKey: "setbackSide", title: "Side setback compliant", status: "PASS",
    message: "8 ft side setback exceeds the 4 ft state minimum.",
    factRef: "setbackSide", sheet: "A1.0",
    codeSection: "CA Gov. Code §65852.2(a)(1)(D)(vii)", codeText: "Setbacks of no more than 4 feet from the side and rear lot lines shall be required.",
  },
  {
    id: "f_rear", ruleKey: "setbackRear", title: "Rear setback compliant", status: "PASS",
    message: "9'-10\" rear setback exceeds the 4 ft state minimum.",
    factRef: "setbackRear", sheet: "A1.0",
    codeSection: "CA Gov. Code §65852.2(a)(1)(D)(vii)", codeText: "Setbacks of no more than 4 feet from the side and rear lot lines shall be required.",
  },
  {
    id: "f_parking", ruleKey: "parking", title: "No replacement parking required", status: "PASS",
    message: "Parking is not required for an ADU within 1/2 mile of transit or created by converting existing space.",
    codeSection: "CA Gov. Code §65852.2(d)", codeText: "A local agency shall not impose parking standards for an ADU in specified cases.",
  },
];

const CHECKLIST: ChecklistItem[] = [
  { item: "Site plan with setbacks (A1.0)", required: true, present: true },
  { item: "Floor plans — existing + proposed (A2.0, A3.0)", required: true, present: true },
  { item: "Elevations (A4.0) + height section (A5.0)", required: true, present: true },
  { item: "Structural sheets (S0.0, S1.0)", required: true, present: true },
  { item: "Title sheet / project data (TS)", required: true, present: true },
  { item: "Transit-proximity exhibit (to justify >16 ft height)", required: true, present: false, note: "Add before submission — see height finding." },
];

const REPORT: Report = {
  projectId: "",
  score: 83,
  summary:
    "1216 E 92nd St — garage-conversion ADU (361 sq ft). Five of six checks pass. The only open item is building height: the plotted roof reads ±19'-0\", above the 16 ft base limit, which is allowable only with documented transit proximity. Setbacks (8 ft side, 9'-10\" rear) and the size both clear state minimums, and no replacement parking is required.",
  sections: [
    { heading: "ADU size — 361 sq ft", status: "PASS", body: "Well under the 1,200 sq ft maximum for a converted/detached ADU.", citationSourceId: "LAMC §12.22-A.33" },
    { heading: "Building height — ±19'-0\"", status: "NEEDS_REVIEW", body: "Exceeds the 16 ft base limit. Add a transit-distance exhibit to justify up to 18 ft (or 25 ft under SB 1211), or lower the ridge ~3 ft to ≤16 ft.", citationSourceId: "CA Gov. Code §65852.2(a)(1)(D)" },
    { heading: "Setbacks — 8 ft side / 9'-10\" rear", status: "PASS", body: "Both exceed the 4 ft state minimum.", citationSourceId: "CA Gov. Code §65852.2(a)(1)(D)(vii)" },
    { heading: "Parking", status: "PASS", body: "No replacement parking required (transit proximity / conversion exemption).", citationSourceId: "CA Gov. Code §65852.2(d)" },
  ],
  generatedAt: 0,
  disclaimer:
    "Pre-submission research assistant output. Verify against current official codes and confirm parcel zoning with LA City Planning before submission.",
};

interface Step {
  status: ProjectState["project"]["status"];
  ms: number;
  messages: { from: AgentMessage["from"]; text: string }[];
  findingIds?: string[];
}

const STEPS: Step[] = [
  { status: "jurisdiction", ms: 3000, messages: [
    { from: "orchestrator", text: "CEO Boss: New pre-submission review for 1216 E 92nd St, Los Angeles — single-family ADU. Delegating to the Project & Property Manager." },
    { from: "orchestrator", text: "Project & Property Manager: Intake complete. Brief saved to output/planner_brief.txt. Handing off to the Code Synthesizer." },
  ] },
  { status: "research", ms: 6000, messages: [
    { from: "research", text: "Code Synthesizer: Scoping municipal + state ADU questions — size, height, setbacks, parking, submittal." },
    { from: "research", text: "Municipal Code Researcher: Pulled LAMC §12.22-A.33 (Los Angeles ADU standards) → output/municipal_codes.txt." },
    { from: "research", text: "State Code Researcher: Pulled CA Gov. Code §65852.2 + Title 24 ADU standards → output/state_codes.txt." },
    { from: "research", text: "Code Synthesizer: Merged the governing code set → output/final_summary.txt." },
  ] },
  { status: "read", ms: 4500, messages: [
    { from: "plan-reader", text: "Visual Analysis: Plotted 10 sheets from Los Angeles(1).dwg (A0.0–A5.0, S0.0, S1.0, TS) and reading them with Claude vision." },
    { from: "plan-reader", text: "Visual Analysis: Extracted 361 sq ft (A1.0), roof ±19'-0\" (A5.0), 8 ft side, 9'-10\" rear." },
  ] },
  { status: "comply", ms: 4000, findingIds: ["f_size", "f_height", "f_side", "f_rear", "f_parking"], messages: [
    { from: "compliance", text: "Compare Codes: Comparing plan facts against the governing code set…" },
    { from: "compliance", text: "Compare Codes: 5 PASS · 1 NEEDS REVIEW · 0 FAIL. Wrote output/plan_vs_code.txt." },
  ] },
  { status: "review", ms: 2500, messages: [
    { from: "reviewer", text: "Improve Agent: Researched a fix for the height item — document transit proximity (SB 1211) or drop the ridge. output/solutions_report.txt." },
  ] },
  { status: "report", ms: 2500, messages: [
    { from: "report", text: "Permit Agent: Compiled the LADBS pre-submission package → output/permit_report.txt. READY TO SUBMIT (1 item to confirm)." },
  ] },
];

export async function* runDemoPipeline(
  project: Project,
  channel: BandChannel
): AsyncGenerator<ProjectState> {
  await channel.ready;
  const citySlug = project.citySlug ?? JURISDICTION_ID;
  const now = () => Date.now();

  const state: ProjectState = {
    project: { ...project, status: "jurisdiction" },
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

  state.messages.push({ id: `demo_open_${now()}`, ts: now(), from: "orchestrator", type: "info", text: "Firm workflow started — agents collaborating in Band.", sponsor: "band" });
  yield snapshot();

  for (const step of STEPS) {
    state.project.status = step.status;
    state.project.bandRoomId = channel.roomId ?? undefined;
    if (step.status === "read") state.facts = FACTS;
    // Pull any live Band transcript so the conversation panel stays populated.
    try {
      state.bandTranscript = await channel.roomTranscript();
    } catch {
      /* best-effort */
    }
    for (const m of step.messages) {
      state.messages.push({
        id: `demo_${step.status}_${state.messages.length}_${now()}`,
        ts: now(),
        from: m.from,
        type: "info",
        text: m.text,
        sponsor: "band",
      });
      yield snapshot();
      await sleep(Math.max(700, step.ms / step.messages.length));
    }
    if (step.findingIds) {
      for (const id of step.findingIds) {
        const f = FINDINGS.find((x) => x.id === id);
        if (f) {
          state.findings.push(f);
          state.messages.push({
            id: `demo_finding_${id}_${now()}`,
            ts: now(),
            from: "compliance",
            type: f.status === "PASS" ? "info" : "finding",
            text: `${f.title} — ${f.status}`,
            sponsor: "arize",
          });
          yield snapshot();
          await sleep(650);
        }
      }
    }
  }

  // Finalize: build the report + checklist and persist so the report page works.
  state.checklist = CHECKLIST;
  state.report = { ...REPORT, projectId: project.id, generatedAt: now() };
  state.project.status = "done";
  state.messages.push({ id: `demo_done_${now()}`, ts: now(), from: "orchestrator", type: "done", text: "Workflow complete — readiness report ready. 5 pass, 1 to confirm, 0 fail.", sponsor: "band" });
  try {
    await saveState(state);
  } catch {
    /* best-effort */
  }
  yield snapshot();
}
