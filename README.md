# FirstPass

**AI-powered pre-submission permit-readiness assistant** for residential ADU projects.
Upload a plan set and get a cited, sheet-by-sheet readiness report — likely violations,
official citations with retrieval dates, a readiness score, and missing documents —
before submitting to the city.

> Pre-submission compliance assistant. Not official permit approval. See the disclaimer in-app.

Built for the UC Berkeley AI Hackathon. Full product/engineering brief: [`PLAN.md`](./PLAN.md).

## Stack & sponsors

- **Next.js (App Router) + TypeScript**, deployed on **Vercel**.
- **Claude** (`claude-opus-4-8`) — plan extraction, rule interpretation, report writing.
- **Browserbase** — live navigation of official Alameda permitting sources.
- **Band** — multi-agent message bus powering the live activity feed.
- **Redis** — shared agent memory + rule/finding/source stores.
- **Arize** — tracing + evals (citation, authority, applicability, hallucination).
- **Autodesk APS** — DWG upload → Model Derivative (SVF2) translation + in-browser Viewer.

**Input is DWG** (AutoCAD): the file is uploaded to APS, translated, and rendered in the
dashboard via the Autodesk Viewer. Compliance runs against a **chunked code database** in
Redis — each check retrieves only its relevant code section (token-efficient RAG), shown in
the finding inspector as "Retrieved code · RAG from Redis".

Every integration is an **adapter that runs live when its key is present and falls back to
deterministic cached data when it isn't** — so the app runs and demos with zero keys, and
lights up as you add them.

## Run locally

```bash
npm install
cp .env.example .env.local   # optional — add keys to go live
npm run dev                  # http://localhost:3000
```

Create a project → it runs the multi-agent pipeline live over SSE → view the report.

## The demo set piece (PLAN.md §10)

The plan shows an 18 ft detached ADU. Compliance first applies the **attached**-ADU 16 ft
limit → **FAIL**. The Arize **applicability eval** scores it low → the Reviewer posts a
disagreement on the Band feed citing the source → Compliance re-runs with the correct
detached rule → **PASS (corrected)**. A genuine 3 ft side-setback violation stays FAIL,
and a missing Title-24 report shows as NEEDS REVIEW + a checklist gap.

## Architecture

```
src/lib/pipeline.ts        Orchestrator (async generator, streams ProjectState)
src/lib/compliance.ts      Deterministic checks, applicability gate, score, language lint
src/lib/fixtures.ts        Alameda ADU rules, cached official sources, demo plan facts
src/lib/store.ts           Redis (ioredis) with in-memory fallback
src/lib/integrations/      claude · browserbase · band · arize adapters
src/app/api/run/[id]       SSE stream that drives the pipeline
src/app/project/[id]       Live dashboard (blueprint overlays, agent feed, findings)
src/app/project/[id]/report  Cited report + print-to-PDF
```

## Keys

See [`.env.example`](./.env.example). Needed to go fully live:
`ANTHROPIC_API_KEY`, `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID`, `REDIS_URL`,
`ARIZE_API_KEY` + `ARIZE_SPACE_ID`, `BAND_API_KEY` (+ `BAND_PROJECT_ID`).

## Deploy (Vercel)

```bash
vercel
# add the env vars in the Vercel project settings, then:
vercel --prod
```

Use Upstash Redis (a `redis://`/`rediss://` URL works directly via `REDIS_URL`).
