# FirstPass — Execution Brief

**AI-powered pre-submission permit-readiness assistant for residential ADU projects.**

> Upload your residential plans and receive a cited, sheet-by-sheet permit-readiness report before submitting them to the city.

Built for the UC Berkeley AI Hackathon. Sponsor stack: **Browserbase · Band · Redis · Arize · Anthropic/Claude**. Frontend: **Next.js (App Router) + Vercel**.

---

## 1. Product Definition

FirstPass is the *first pass* a residential plan set gets before a human plan reviewer at a city permit office sees it. An independent architect or small firm uploads a PDF plan set for a **detached ADU in Alameda, California**, FirstPass identifies the jurisdiction and the governing rules, extracts structured facts from the plans, runs deterministic compliance checks, and produces a **cited permit-readiness report** with a score, flagged issues, evidence overlays on the blueprint, and a missing-documents checklist.

**Positioning.** Not permit approval software. A *pre-submission compliance assistant* that helps catch likely issues earlier. Hybrid of (a) AI developer/workflow tooling for architecture+permitting teams and (b) civic-impact infrastructure that reduces housing/permitting friction.

**Why it wins.** Real-world usefulness + visible multi-agent collaboration + visible citations and traceability + a smooth, memorable demo with a caught-mistake moment.

---

## 2. Refined Scope (hard constraints)

| Dimension | Locked choice |
|---|---|
| Jurisdiction | **Alameda, California** only |
| Project type | **Detached ADU** only |
| User persona | **Small residential architecture firm / independent architect** |
| Compliance checks | **4 high-signal checks** (below) |
| Priority | Reliability + demo quality over breadth |

**The 4 checks** (deterministic; see §10):
1. **Max unit size** — ADU conditioned floor area ≤ allowed sq ft for the lot/type.
2. **Height limit** — ADU height ≤ jurisdiction max (ft).
3. **Setbacks** — rear/side setbacks ≥ minimum (ft).
4. **Required documents present** — site plan, floor plan, elevations present in the set.

A 5th, **fire egress / window size**, is a stretch check kept in code but flagged `NEEDS REVIEW` if extracted.

---

## 3. MVP Feature Set (must-have)

- Create project → enter address + project type → upload PDF plan set.
- Live agent activity feed (Band) showing agents working, disagreeing, retrying.
- ≥3 extracted plan facts with the sheet/region they came from.
- The 4 compliance checks with PASS / FAIL / WARNING / NEEDS REVIEW.
- Clickable blueprint viewer with highlighted regions → finding inspector.
- Evidence/citation panel: official source URL + excerpt + retrieval date (Browserbase).
- Permit-readiness score (0–100) + issue summary.
- Missing-documents checklist.
- Final report page (viewable + downloadable).
- **The Arize "caught mistake" moment**: an inapplicable/incorrect rule is flagged by eval and corrected live.

## 4. Stretch Goals (nice-to-have, cut first)

- 5th compliance check (fire egress).
- Multi-page blueprint navigation with thumbnails.
- PDF export of the report (vs HTML/print).
- "Re-research sources" button that re-runs Browserbase live.
- Confidence sliders / per-finding human-override.

## Features to EXCLUDE during the hackathon

- Multiple cities or project types.
- User auth / accounts / billing.
- Real submission to any city system.
- Editing/annotating the PDF.
- Mobile-optimized layout (desktop demo only).
- Persisting projects across server restarts beyond Redis TTL.

---

## 5. Sponsor Integration Plan

### Browserbase — live official-source research (essential, not an add-on)
- **Where**: the **Code Research Agent** drives a Browserbase headless session to navigate Alameda's planning/building department site, find the ADU/zoning rules page and the permit-submittal checklist, and extract rule text + the canonical URL + retrieval timestamp.
- **Why necessary vs static prompts**: rules change and must be *attributable*. The demo shows a real browser visiting a real `.gov`/city page and pulling the exact excerpt we cite — provenance a static prompt can't credibly provide.
- **Demo moment**: split-second live "agent is browsing alameda…" with the fetched URL + excerpt appearing in the evidence panel, retrieval date stamped now.
- **Reliability**: cache the scraped sources in Redis (§Redis). Demo path reads cache; a "Refresh sources" button re-runs live. If Browserbase is slow/down mid-demo, we fall back to the cached source set (clearly timestamped) — never a hard failure.

### Band — visible multi-agent collaboration
- **Where**: Band is the message bus between agents. The Orchestrator routes work; agents publish status/findings; the **Reviewer Agent** can publish a *correction* back to the Compliance Agent (the visible disagreement).
- **Agents on the bus**: Orchestrator, Jurisdiction, Code Research, Plan Reader, Compliance, Reviewer, Permit Checklist, Report.
- **Example flow**: `Compliance → "FAIL: height 18ft > 16ft"` → `Reviewer → "DISAGREE: 16ft limit is for attached ADU; detached limit is 18ft (see source S-2). Re-run."` → `Compliance → "PASS (corrected)"`.
- **UX treatment**: a right-rail **Agent Activity Feed** — avatar chips per agent, color-coded message types (info / finding / disagreement / retry / done), timestamps, and a thin connection graph that pulses on each message. This is what makes the multi-agent story legible to judges.

### Redis — shared memory + retrieval infrastructure (not just cache)
- **Project state**, **agent task state**, **shared memory blackboard**, **rule store**, **finding store**, **source store with dedup + freshness**, and **retrieval over prior researched code sections** (embedded rule chunks → vector similarity for "which rule applies to this fact").
- See §8 for data model and §Redis-details below.

### Arize — observability + evaluation (the differentiator)
- **Trace** every agent step + every Claude call (OpenTelemetry / Arize tracing).
- **Evals**: citation correctness (does the excerpt support the rule?), source authority (is the URL an official Alameda/CA source?), rule applicability (does this rule apply to *detached ADU*?), hallucination risk.
- **Before/after demo story** (§10): Compliance initially applies the *attached*-ADU height limit (16ft) to our detached ADU and emits a FAIL. The **rule-applicability eval scores it low** → flagged → Reviewer re-runs with the correct detached limit (18ft) → result flips to PASS. Arize dashboard shows the bad trace, the eval score, and the corrected trace side by side. This is the wow moment that proves the system catches its own mistakes.

### Anthropic / Claude — reasoning, extraction, writing
- **Claude does**: jurisdiction interpretation, structured extraction from the plan set (PDF → typed facts with source regions), rule interpretation, explanation generation, reviewer analysis, final report writing.
- **Deterministic logic does**: all numerical comparisons, unit normalization, applicability gating, score computation, PASS/FAIL/WARNING/NEEDS-REVIEW classification.
- **Model**: `claude-opus-4-8`, adaptive thinking (`thinking: {type:"adaptive"}`), `output_config.effort: "high"`, **structured outputs** (`output_config.format` with JSON schema) for every extraction so we never parse free text. Vision via base64 page images for blueprint understanding. Streaming for long calls.

---

## 6. Multi-Agent Architecture

Orchestrator runs the pipeline; agents communicate over Band; state lives in Redis; every step traces to Arize.

```
Project Orchestrator
  ├─ Jurisdiction Agent      (address → jurisdiction + agencies)
  ├─ Code Research Agent     (Browserbase → official rules + sources → Redis)
  ├─ Plan Reader Agent       (PDF → structured plan facts + regions)  [Claude vision]
  ├─ Compliance Agent        (facts × rules → findings)               [deterministic + Claude explain]
  ├─ Reviewer Agent          (Arize evals → corrections via Band)
  ├─ Permit Checklist Agent  (required docs present?)
  └─ Report Agent            (findings + score → cited report)        [Claude writing]
```

Per-agent spec (job / inputs / outputs / tools / validation / failure / recovery):

| Agent | Primary job | Inputs | Outputs | Tools | Validation | What can go wrong | Recovery / escalation |
|---|---|---|---|---|---|---|---|
| **Orchestrator** | Sequence agents, own project state, publish overall status | Project record | Phase transitions, final status | Redis, Band | Each phase produces required artifact before advancing | An agent stalls/throws | Retry once; on hard fail mark phase `error`, continue with degraded data, surface in report |
| **Jurisdiction** | Resolve address → jurisdiction + relevant agencies | Address, project type | `{jurisdiction:"Alameda, CA", agencies:[...]}` | Claude (structured) | Output matches enum of supported jurisdictions | Address ambiguous/out-of-scope | If not Alameda → `NEEDS REVIEW`, demo uses Alameda default |
| **Code Research** | Find + extract official ADU/zoning rules and the permit checklist | Jurisdiction | Rule records + Source records (URL, excerpt, retrieved_at) | **Browserbase**, Claude (extract), Redis | Source URL is official domain; excerpt non-empty | Site down / layout changed / slow | Fall back to cached sources in Redis (timestamped); never hard-fail |
| **Plan Reader** | Extract typed facts from the plan set with source regions | PDF pages (images) | PlanFact records `{key,value,unit,sheet,bbox,confidence}` | **Claude vision** (structured outputs) | Numeric facts have units; confidence in [0,1] | OCR/vision misread, missing sheet | Low-confidence → `NEEDS REVIEW`; missing fact → checklist gap |
| **Compliance** | Compare facts vs rules deterministically | Facts, Rules | Finding records w/ status + evidence | Deterministic engine + Claude (explanation only) | Units normalized; applicability gate passes | Applies wrong/inapplicable rule | Reviewer + Arize catch it → correction message → re-run |
| **Reviewer** | Audit findings via Arize evals; route corrections | Findings, eval scores | Corrected findings, disagreement msgs | **Arize** evals, Band, Claude | Eval scores attached; correction has rationale + source | Misses a bad finding | Eval thresholds tuned; flag uncertain as `NEEDS REVIEW` |
| **Permit Checklist** | Verify required submittal docs present | Plan facts / sheet index | ChecklistItem records (present/missing) | Claude (classify), Redis | Each required item resolved present/missing | Mislabels a sheet | Ambiguous → `NEEDS REVIEW` |
| **Report** | Compose cited, readable report + score | All findings, sources, checklist | Report record (sections + citations) | Claude (writing, structured) | Every claim links a finding or source | Overclaims / unsafe language | Language linter (§ Safety) strips banned phrasing |

**Failure philosophy**: degrade, never crash the demo. Any agent failure produces a visible `NEEDS REVIEW` rather than a stack trace.

---

## 7. UX & Screen-by-Screen Plan

Polished, startup-quality, desktop demo. Tailwind + shadcn/ui. Calm professional palette (slate/ink + a single confident accent; avoid generic AI-purple-gradient).

**Screens**
1. **Landing / New Project** — one-line promise, project name, address, project-type select (ADU locked), drag-drop PDF, "Run FirstPass" CTA. Disclaimer in footer.
2. **Run / Dashboard** (the hero screen) — three-column layout:
   - **Left**: phase rail (Jurisdiction → Research → Read → Comply → Review → Report) with live status.
   - **Center**: **Blueprint viewer** with highlighted regions; tabs for Findings + Plan Facts. Clicking a region opens the **Finding Inspector** (status, rule, evidence, suggested correction).
   - **Right**: **Agent Activity Feed** (Band) — live messages, disagreement/retry chips, pulsing agent graph.
   - **Top**: **Permit-Readiness Score** gauge + issue counts (FAIL/WARN/REVIEW).
3. **Evidence / Citation panel** (slide-over) — source title, official URL, excerpt, retrieved-at, "open source" link; ties each finding to its source.
4. **Report page** — score header, executive summary, per-check sections (status + explanation + citation + suggested correction), missing-docs checklist, disclaimer; **Download** (print-to-PDF) + **View**.

**UI hierarchy**: Score → Findings → Evidence → Agent feed → raw facts. Findings are cards (status pill, title, one-line why, "view evidence" / "view on plan").

---

## 8. Data Model (Redis)

Prose schemas; stored as JSON in Redis (keys namespaced by project). Embedded rule chunks in a vector index for retrieval.

| Entity | Key pattern | Fields |
|---|---|---|
| **Project** | `proj:{id}` | id, name, address, projectType, jurisdictionId, status(phase), createdAt, pdfRef, score |
| **Jurisdiction** | `jur:{id}` | id, name("Alameda, CA"), agencies[], sourceRootUrl |
| **Rule** | `rule:{jurId}:{key}` | key(maxSize/height/setbackRear/…), appliesTo("detached_adu"), operator(≤/≥/present), threshold, unit, sourceId, description |
| **Source** | `src:{hash}` | id(hash of URL), url, title, excerpt, retrievedAt, authorityScore, jurId, contentHash(dedup) |
| **PlanFact** | `fact:{projId}:{key}` | key, value, unit, sheet, bbox[x,y,w,h], confidence, raw |
| **Finding** | `find:{projId}:{key}` | id, ruleKey, status(PASS/FAIL/WARNING/NEEDS_REVIEW), factRef, ruleRef, sourceRef, message, suggestedCorrection, evalScores |
| **ChecklistItem** | `chk:{projId}:{item}` | item, required(bool), present(bool/null), note |
| **AgentMessage** | `msg:{projId}` (list) | ts, fromAgent, toAgent, type(info/finding/disagreement/retry/done), text, refs |
| **EvaluationResult** | `eval:{projId}:{target}` | target(findingId), dimension(citation/authority/applicability/hallucination), score, passed, rationale, traceId |
| **Report** | `report:{projId}` | sections[], score, summary, citations[], generatedAt, disclaimer |

**Redis details**: project/agent task state as JSON; shared-memory blackboard hash per project; rule store + finding store as above; sources deduped by `contentHash` with `retrievedAt` freshness (re-research if older than TTL); **retrieval**: rule chunks embedded → vector search to map a plan fact to the applicable rule. Metadata stored for filtering: `jurId`, `appliesTo`, `unit`, `authorityScore`.

---

## 9. Compliance Logic

- **Deterministic numerical comparisons** in TS: `compare(factValue, operator, threshold)` after unit normalization.
- **Unit consistency**: normalize everything to canonical units (feet, sq ft) before compare; reject/flag on unit mismatch.
- **Applicability check** (the crux): a rule only applies if `rule.appliesTo === project.subtype` (`detached_adu`). This gate is what the Arize applicability eval guards — the demo bug is an applicability failure.
- **Confidence**: each PlanFact carries model confidence; below threshold → `NEEDS REVIEW`.
- **Human review flags**: any low-confidence fact, ambiguous applicability, or missing data.
- **Missing information**: missing fact → don't FAIL; emit `NEEDS REVIEW` + checklist gap.
- **Suggested corrections**: Claude generates a one-line fix per non-PASS finding.

**Status definitions**
| Status | Meaning |
|---|---|
| **PASS** | Fact present, rule applies, comparison satisfied. |
| **FAIL** | Fact present, rule applies, comparison violated (likely violation). |
| **WARNING** | Comparison near threshold, or rule applies but data slightly stale/indirect. |
| **NEEDS REVIEW** | Missing/low-confidence fact, ambiguous applicability, or eval flagged. |

**Score**: weighted — start 100, subtract per FAIL (−25), WARNING (−10), NEEDS REVIEW (−5); floor 0. Shown as a gauge with the breakdown.

---

## 10. Demo Scripts

**The set piece (Arize before/after)**: Plans show an 18ft-tall detached ADU. Compliance first applies the *attached*-ADU 16ft limit → **FAIL**. Arize rule-applicability eval scores it low → Reviewer posts a Band disagreement citing source S-2 (detached limit = 18ft) → Compliance re-runs → **PASS (corrected)**. Arize dashboard shows bad trace → eval → corrected trace.

**90-second script**
1. (0:10) "Architects lose weeks to permit rejections. FirstPass is the first pass before the city sees your plans."
2. (0:20) New project → Alameda address → drop ADU PDF → Run.
3. (0:35) Agents light up (Band feed). Browserbase visibly browses Alameda's site; a real source URL + excerpt + today's date land in the evidence panel.
4. (0:55) Score gauge fills; findings appear; click the highlighted height region on the blueprint → inspector.
5. (1:15) The height check flips FAIL → PASS live as Reviewer corrects Compliance (Arize caught the inapplicable rule). Show the Arize before/after.
6. (1:30) "Cited, sheet-by-sheet readiness report — before submission. Browserbase for provenance, Band for collaboration, Redis for memory, Arize for trust, Claude for reasoning."

**3-minute script**: same arc, plus — walk all 4 checks; open the evidence slide-over and click through to the live source; show the missing-docs checklist; open the full report and download it; 30-sec sponsor-by-sponsor narration (§11).

**Sponsor judging narrative**: "Browserbase gives our citations real provenance. Band makes multi-agent disagreement *visible*. Redis is our shared brain + rule retrieval. Arize is why you can trust the output — it caught our own mistake on stage. Claude reasons; deterministic code decides the numbers."

---

## 11. Judging Strategy & 12. How to Win

**What judges care about**: does it solve a real problem, is the multi-agent system real and legible, are claims traceable, is the demo stable, are sponsors used meaningfully.

**How to win**
- **Strongest wow**: the live FAIL→PASS self-correction backed by an Arize eval. Rehearse it cold.
- **Make sponsors impossible to miss**: a tiny always-visible "sponsor rail" showing each sponsor lighting up as its agent acts (Browserbase browsing, Band messaging, Redis writing, Arize scoring, Claude thinking).
- **Startup story, not tech story**: lead with the architect's pain and the wedge into permitting software; tech is the proof.
- **Depth vs stability**: everything reads from Redis cache during the demo; live calls (Browserbase/Arize) have cached fallbacks; never a blank screen.
- **Cut first if short on time**: 5th check → PDF export → multi-page nav → re-research button. Protect the score + one finding + the Arize moment.

---

## 13. Team Work Split (4 people)

- **A — Agents/orchestration**: Orchestrator, Band wiring, Redis state, compliance engine.
- **B — Sponsors/integrations**: Browserbase research agent, Arize tracing + evals, Claude extraction/reporting prompts.
- **C — Frontend**: dashboard, blueprint viewer, agent feed, evidence panel, report page.
- **D — Demo/data/glue**: the canonical ADU PDF + fixtures, the scripted bug, demo script, deploy to Vercel, fallback paths.

## 14. Execution Timeline (hackathon)

| Block | Goal |
|---|---|
| H0–H3 | Repo scaffold, Next.js shell, Redis up, Claude key wired, canonical PDF chosen, types defined |
| H3–H8 | Plan Reader (vision extraction) + Compliance engine + 4 rules hardcoded → end-to-end on fixtures |
| H8–H14 | Browserbase research agent + Redis source store; Band feed live; dashboard + blueprint overlays |
| H14–H20 | Arize tracing + applicability eval; the scripted FAIL→PASS correction; report page |
| H20–H26 | Polish UI, sponsor rail, fallbacks, deploy to Vercel |
| H26–end | Rehearse 90s + 3min demos cold; freeze; buffer |

## 15. Risks & Fallback Plan

| Risk | Mitigation / fallback |
|---|---|
| Browserbase slow/down in demo | Demo reads cached sources from Redis (timestamped); live refresh optional |
| Vision extraction unreliable | Pre-validated canonical PDF + cached fact set; live run is "best effort", cache is truth |
| Arije/Band API hiccup | Trace/feed degrade gracefully; eval result can be replayed from cache for the set piece |
| Claude latency | Stream; show thinking in agent feed so waiting feels intentional |
| Scope creep | Strict exclude list (§4); 4 checks only |

## 16. Final Messaging & Pitch

**Tagline**: *Catch permit problems before the city does.*

**Pitch**: "Small architecture firms lose weeks and clients to avoidable permit rejections. FirstPass is the pre-submission first pass: upload an ADU plan set and get a cited, sheet-by-sheet readiness report — likely violations, official citations with retrieval dates, a readiness score, and the missing documents — in minutes. Multiple specialized agents research the real rules (Browserbase), read the plans (Claude), check them deterministically, and *audit each other* (Arize) before we ever show you a result. It's the wedge into the broader architecture-and-permitting workflow stack."

---

## Safety & Legal Language Guidelines

**Use**: "likely violation", "potential issue", "pre-submission review", "requires professional confirmation".
**Never**: "officially approved", "guaranteed code compliant", "certified by the city", "guaranteed permit approval".
A `languageLint()` pass scrubs banned phrasing from any generated report text.

**Recommended disclaimer** (footer + report):
> FirstPass is a pre-submission compliance assistant, not an official permit review. Findings indicate *likely* issues for early correction and require confirmation by a licensed professional and the governing jurisdiction. FirstPass does not approve, certify, or guarantee permit approval.

---

## Keys / secrets needed from the user
Set in `.env.local` (and Vercel project env). See `.env.example`.
- `ANTHROPIC_API_KEY`
- `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`
- `REDIS_URL` (Upstash works on Vercel)
- `ARIZE_API_KEY`, `ARIZE_SPACE_ID`
- Band: `BAND_API_KEY` (+ any project/workspace id Band requires)
