# FirstPass (PermitOS)

Multi-agent building code research for pre-submission ADU permit reviews. Three Band agents scrape codes and write `.txt` reports to `output/`.

## Setup

```bash
cp firstpass.config.yaml.example firstpass.config.yaml
# Fill in anthropic, browserbase, and band API keys
uv sync
```

## Run locally (no Claude cost)

Uses scraping only — no Band agents, no Anthropic API calls:

```bash
uv run firstpass-local --address "1109 Evelyn Ave, Albany, CA 94706"
uv run firstpass-local --ocr-only   # skip Browserbase, fastest
```

## Run with Band agents (uses Claude API)

Start three agents in separate terminals:

```bash
uv run firstpass-municipal
uv run firstpass-state
uv run firstpass-synthesizer
```

In Band chat, send:

```
@Municipal Code Researcher @State Code Researcher @Code Synthesizer

Address: 1109 Evelyn Ave, Albany, CA 94706
Project type: Detached ADU
```

Or create a room from the terminal:

```bash
uv run firstpass-kickoff --address "1109 Evelyn Ave, Albany, CA 94706"
```

## Cost tips

| Mode | Claude API | Browserbase |
|------|------------|---------------|
| `firstpass-local --ocr-only` | None | None |
| `firstpass-local` | None | Yes |
| Band agents | Yes (Haiku 4.5) | Yes |

To minimize Anthropic spend:

- Default model is **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) in `firstpass.config.yaml`
- Use `firstpass-local` for scrape testing; use Band only for demos
- One Band room per address — stop agents (`Ctrl+C`) when done
- Use a **separate Anthropic API key** for FirstPass vs Cursor to track usage

## Output

- `output/municipal_codes.txt`
- `output/state_codes.txt`
- `output/final_summary.txt`
