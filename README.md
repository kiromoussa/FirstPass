# FirstPass

**AI-powered pre-submission permit-readiness assistant** for residential ADU projects. Multi-agent Band workflow + Next.js dashboard.

> Pre-submission compliance assistant. Not official permit approval. See [`PLAN.md`](./PLAN.md).

## Stack

- **Next.js** — dashboard, SSE pipeline, APS viewer
- **Python Band agents** — Municipal / State / Synthesizer scrape codes via Browserbase + Internet Archive
- **Band** — multi-agent chat orchestration (CEO → Project and Property Manager → researchers → visual → compare → …)
- **Claude** — plan reading, agent reasoning, report writing

## Setup

```bash
npm install
cp .env.example .env.local          # Next.js keys
cp firstpass.config.yaml.example firstpass.config.yaml   # Python + Band keys
uv sync                             # Python agents
```

## Run the web app

```bash
npm run dev   # http://localhost:3000
```

## Run Band code agents (Browserbase + Claude)

```bash
./scripts/run_agents.sh
# or individually:
uv run firstpass-municipal
uv run firstpass-state
uv run firstpass-synthesizer
```

Kickoff in Band (address only):

```
@varbtw/ceo-boss @varbtw/project-property-intake

1216 E 92nd St, Los Angeles, CA 90002
```

Or:

```bash
uv run firstpass-kickoff --address "YOUR ADDRESS"
```

## Scrape without Band (no Claude API cost)

```bash
uv run firstpass-local --address "1109 Evelyn Ave, Albany, CA 94706"
```

## Output

- `output/municipal_codes.txt`, `output/state_codes.txt`, `output/final_summary.txt`
- See `BAND_AGENTS.md` for the full agent team and keys reference.

## Deploy

```bash
vercel --prod
```

Add env vars from `.env.example` in Vercel project settings.
