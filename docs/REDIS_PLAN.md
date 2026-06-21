# FirstPass — Redis Integration Plan

**Goal:** Use Redis as the firm's shared brain — not a cache — so judges see agent memory, vector search, and context retrieval in the demo.

Built for the **UC Berkeley AI Hackathon · Redis track**. Qualifying tools: Redis Cloud, Redis OSS, **RedisVL**, **Agent Memory Server**, Redis AI Incubator.

Related docs: [`PLAN.md`](../PLAN.md) §8 (data model), [`CHUNKING.md`](./CHUNKING.md) (retrieval strategy).

---

## 1. Current state

### What works today

| Component | File(s) | Redis usage |
|-----------|---------|-------------|
| Project state | `src/lib/store.ts` | JSON blobs at `state:{id}`, 6h TTL |
| Code corpus | `src/lib/code-db.ts` | Chunk index at `code:{slug}:*`, city registry |
| Plan uploads | `src/app/api/plans/upload/route.ts` | Base64 plan at `plan:{id}` |
| Pipeline | `src/lib/pipeline.ts` | Seeds chunks, emits "Indexed to Redis" sponsor message |
| City ingest | `src/app/api/cities/ingest/route.ts` | Persists runtime-ingested corpora to Redis |

Connection: `REDIS_URL` via **ioredis** (Upstash / Redis Cloud on Vercel). In-memory fallback when unset.

Retrieval today: **deterministic tag + lexical term scoring** in `retrieveCode()` — no embeddings, no vector index. See [`CHUNKING.md`](./CHUNKING.md) § "Hybrid + rerank (direction)".

### What's missing (gap vs. hackathon criteria)

| Criterion | Status |
|-----------|--------|
| Redis beyond caching | Partial — chunks are durable storage, but narrative still reads as "cache" |
| Agent memory | **Not built** — Python Band agents write to `output/*.txt`, not Redis |
| Vector search | **Not built** — lexical only |
| Context retrieval | Partial — `context` headers exist on chunks but aren't embedded |
| Cross-agent blackboard | **Not built** — Next.js and Python halves don't share state |
| Source dedup + freshness | **Not built** — sources live in project state only |

### The split-brain problem

```
Python Band agents          Next.js dashboard
─────────────────          ─────────────────
output/municipal_codes.txt     Redis (state, chunks)
output/state_codes.txt         SSE pipeline
output/final_summary.txt       Finding inspector
data/cities/<slug>/            Browserbase research

        ↑ no shared memory ↑
```

Until Redis bridges these, the multi-agent story is invisible to the dashboard and judges.

---

## 2. Target architecture

Redis sits at the center as **shared memory + retrieval infrastructure**:

```
                    ┌─────────────────────────────────┐
                    │         Redis Cloud             │
                    │  (Search + Vector + Streams)    │
                    └───────────────┬─────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
   Blackboard                  Code RAG                   Agent feed
   project:{id}:*              RedisVL index              Streams
        │                     firstpass:codes              agent:feed:{id}
        │                           │                           │
   ┌────┴────┐                 ┌────┴────┐                 ┌────┴────┐
   │ Python  │                 │ Next.js │                 │ Next.js │
   │ Band    │                 │ pipeline│                 │ SSE UI  │
   │ agents  │                 │ + checks│                 │ + Band  │
   └─────────┘                 └─────────┘                 └─────────┘
        │                           │
        └──── Agent Memory Server ──┘  (optional MCP layer)
              cross-session recall
```

**Principle:** Every agent *writes* artifacts to Redis; every downstream agent *reads* from Redis instead of re-parsing files. The dashboard streams the same keys.

---

## 3. Data model

Extends [`PLAN.md`](../PLAN.md) §8. Keys are namespaced; JSON values unless noted.

### 3.1 Project blackboard (multi-agent handoff)

| Key | Type | Writer | Reader | Contents |
|-----|------|--------|--------|----------|
| `project:{id}:meta` | STRING (JSON) | Orchestrator | All | `{ address, citySlug, phase, createdAt }` |
| `project:{id}:blackboard` | HASH | Each agent on phase complete | Downstream agents | Field per artifact: `municipal_codes`, `state_codes`, `synthesis`, `plan_vs_code`, `permit_report` |
| `project:{id}:phase` | STRING | Orchestrator | Dashboard | Current phase enum |
| `state:{id}` | STRING (JSON) | Next.js pipeline | Dashboard | Full `ProjectState` (existing) |

**Python write pattern** (after each agent finishes):

```python
# firstpass/redis_store.py (new)
r.hset(f"project:{project_id}:blackboard", "municipal_codes", report_text)
r.hset(f"project:{project_id}:blackboard", "municipal_codes_at", iso_timestamp)
r.publish(f"project:{project_id}:events", json.dumps({"from": "municipal", "type": "done"}))
```

**Bridge script:** Extend `scripts/ingest_band_output.py` to also push raw reports + chunk count to Redis after ingest.

### 3.2 Source store (dedup + freshness)

| Key | Type | Contents |
|-----|------|----------|
| `src:{contentHash}` | STRING (JSON) | `{ url, title, excerpt, retrievedAt, authorityScore, jurId }` |
| `project:{id}:sourceIds` | SET | Hashes of sources used in this project |
| `jur:{jurId}:sources` | SET | All known sources for a jurisdiction |

**Logic:** Before Browserbase scrape, check `src:{hash}` — if `retrievedAt` < 7 days, return cached with timestamp. Demo shows "(cached from Redis, scraped 2d ago)" vs "(live)".

### 3.3 Code corpus (existing + vector upgrade)

**Existing keys** (keep):

```
code:cities                          → registry of slugs
code:{slug}:index                    → chunk id list
code:{slug}:chunk:{id}               → CodeChunk JSON
code:{slug}:meta                     → CityMeta JSON
```

**New RedisVL index** (Search index, prefix `codev:`):

| Field | Type | Purpose |
|-------|------|---------|
| `chunk_id` | TAG | Stable id |
| `city` | TAG | Filter by jurisdiction |
| `category` | TAG | building, plumbing, state, city, … |
| `applies_to` | TAG | detached_adu, attached_adu |
| `topics` | TAG | maxSize, height, setbackSide, … |
| `text` | TEXT | BM25 on body + context header |
| `embedding` | VECTOR (384d, HNSW) | Semantic similarity on `indexText(chunk)` |

Index name: `firstpass:codes`. See [`CHUNKING.md`](./CHUNKING.md) for why hybrid (vector + BM25) beats either alone on legal text.

### 3.4 Agent activity feed

| Key | Type | Contents |
|-----|------|----------|
| `agent:feed:{projectId}` | STREAM | `{ from, to, type, text, sponsor, refs, ts }` |

Mirror Band messages into the stream so serverless SSE and multiple tabs stay in sync. Optional: replay for demo recording.

### 3.5 Findings + rules (future)

| Key | Type | Contents |
|-----|------|----------|
| `find:{projId}:{ruleKey}` | STRING (JSON) | Finding record |
| `rule:{jurId}:{key}` | STRING (JSON) | Rule threshold + applicability |

Lower priority for hackathon — pipeline already holds findings in `ProjectState`.

---

## 4. Retrieval upgrade: lexical → RedisVL hybrid

### Why upgrade

Current `retrieveCode()` in `code-db.ts` works for demo cities with hand-tagged topics. Real Band scrapes often have **untagged OCR chunks** — vector + BM25 hybrid recovers provisions lexical scoring misses.

The **attached vs detached height** correction story (Arize applicability eval) needs retrieval that respects `applies_to` metadata filters, not just term frequency.

### Query flow

```
Plan fact: "height 18 ft, detached ADU"
        │
        ▼
HybridQuery (RedisVL)
  • vector: embed("detached ADU maximum height feet")
  • text:   BM25("height", "18 feet", "detached")
  • filter: city == "alameda-ca" AND applies_to IN (detached_adu, *)
        │
        ▼
Top chunk → cited in Finding Inspector ("Retrieved code · RAG from Redis")
```

### Implementation options

| Option | Pros | Cons |
|--------|------|------|
| **A. Python ingest + TS calls `/api/code/retrieve`** | RedisVL is Python-native; reuse `chunk_codes.py` | New API route |
| **B. All in TypeScript** | Single runtime | No official RedisVL TS client; raw RediSearch commands |
| **C. Ingest in Python, query in Python microservice** | Clean separation | Extra deploy surface |

**Recommendation:** Option A — `scripts/index_codes_redisvl.py` for ingest; `src/app/api/code/retrieve/route.ts` proxies to a Python script or shared Redis index via `@redis/search` if available.

### Embedding model

Use **local sentence-transformers** via `redisvl[sentence-transformers]` for zero API cost during hackathon:

```bash
uv add redisvl
uv run python scripts/index_codes_redisvl.py --slug alameda-ca
```

Embed `indexText(chunk)` = `context + text` (already defined in `code-db.ts`).

---

## 5. Agent Memory Server (cross-session memory)

Optional but strong for the **"agent memory"** judging criterion.

### What to remember

| Memory | Example | Agent |
|--------|---------|-------|
| Jurisdiction patterns | "Alameda ADU reviews often need Title-24 + site plan" | Permit Agent |
| Applicability lessons | "Height check failed when attached limit applied to detached" | Compare Codes |
| User/project prefs | "This firm prefers state preemption framing" | Code Synthesizer |

### Integration

1. Run Agent Memory Server locally or on Redis Cloud:
   ```bash
   docker run -p 8000:8000 redislabs/agent-memory-server
   ```
2. Expose MCP tools to Band agents at phase boundaries: `store_memory`, `search_memories`.
3. Compare Codes queries memory before ruling: *"Have we seen this applicability error before?"*

**Demo line:** "Redis remembers every project the firm has run — not just this session."

Docs: https://redis.github.io/agent-memory-server/

---

## 6. Python ↔ Redis bridge

New module: `src/firstpass/redis_store.py`

```python
"""Shared Redis client for Band agents. Reads REDIS_URL from env."""
```

Wire into agents that currently call `write_text_report`:

| Agent | Write to Redis | Field |
|-------|----------------|-------|
| Municipal Researcher | `project:{id}:blackboard` | `municipal_codes` |
| State Researcher | `project:{id}:blackboard` | `state_codes` |
| Code Synthesizer | `project:{id}:blackboard` | `final_summary` |
| Compare Codes | read blackboard; write | `plan_vs_code` |
| Permit Agent | read blackboard; write | `permit_report` |

**Project ID:** Derive from address hash or pass via kickoff message in `orchestrator.py`.

Update `scripts/ingest_band_output.py`:

1. After writing `data/cities/<slug>/chunks.json`, call `persistChunks` equivalent in Python.
2. Run `index_codes_redisvl.py` for the slug.
3. Register slug in `code:cities`.

---

## 7. Demo narrative (for judges)

> **"Redis is FirstPass's shared brain — not a cache."**

| Step | What happens | Sponsor rail |
|------|--------------|--------------|
| 1 | User submits address + plan | — |
| 2 | Municipal + State agents **publish** code research to Redis blackboard | Redis lights up |
| 3 | Chunks **indexed** in RedisVL (vector + BM25) | Redis |
| 4 | Plan Reader extracts facts; Compliance runs checks | Claude |
| 5 | Each check **retrieves one chunk** from Redis — show in Finding Inspector | Redis |
| 6 | Compare Codes **reads** prior agent outputs from blackboard (not files) | Redis + Band |
| 7 | Arize flags wrong applicability; Reviewer **re-queries** Redis with `applies_to=detached_adu` | Redis + Arize |
| 8 | Agent Memory recalls prior Alameda projects | Redis (memory) |

**Wow moment:** Height check FAIL (attached limit) → re-retrieval from Redis with filter → PASS (detached 18ft). Side-by-side in Arize + Finding Inspector.

---

## 8. Implementation phases

### Phase 0 — Infrastructure (30 min)

- [ ] Create Redis Cloud database (Search enabled) or confirm Upstash supports RediSearch
- [ ] Set `REDIS_URL` in `.env.local` and Vercel
- [ ] Verify connection: `npm run dev` → no in-memory fallback warning in production

### Phase 1 — Blackboard (2–3 h) · P0

- [ ] Add `src/firstpass/redis_store.py` with `hset_artifact`, `get_artifact`, `ensure_project`
- [ ] Pass `project_id` in Band kickoff message (`orchestrator.py`)
- [ ] Municipal + State + Synthesizer write to blackboard on report complete
- [ ] Add `GET /api/projects/[id]/blackboard` for dashboard
- [ ] Show blackboard status in RunProgress / Agent Activity Feed

### Phase 2 — RedisVL hybrid retrieval (2–3 h) · P0

- [ ] Add `scripts/index_codes_redisvl.py` — index all `data/cities/*/chunks.json`
- [ ] Add `POST /api/code/retrieve` — `{ slug, ruleKey, appliesTo, query }` → chunk
- [ ] Update `retrieveCode()` to call RedisVL when index exists, fallback to lexical
- [ ] Re-ingest LA + Alameda corpora; verify attached/detached height retrieval
- [ ] Update Finding Inspector subtitle: "Hybrid RAG · RedisVL"

### Phase 3 — Source dedup + freshness (1 h) · P1

- [ ] Hash sources by URL in `researchSources()` (`src/lib/integrations/browserbase.ts`)
- [ ] Store at `src:{hash}` with `retrievedAt`
- [ ] Pipeline message: "(live)" vs "(cached from Redis, N days ago)"

### Phase 4 — Agent feed streams (1.5 h) · P1

- [ ] `XADD` on each Band/pipeline message
- [ ] SSE route reads stream with `XREAD BLOCK`
- [ ] Replay last N messages on dashboard connect

### Phase 5 — Agent Memory Server (2 h) · P2

- [ ] Docker-compose service for local dev
- [ ] Compare Codes + Permit Agent MCP memory tools
- [ ] One demo line showing cross-project recall

---

## 9. Files to create or modify

| Action | Path |
|--------|------|
| **Create** | `docs/REDIS_PLAN.md` (this file) |
| **Create** | `src/firstpass/redis_store.py` |
| **Create** | `scripts/index_codes_redisvl.py` |
| **Create** | `src/app/api/code/retrieve/route.ts` |
| **Create** | `src/app/api/projects/[id]/blackboard/route.ts` |
| **Modify** | `src/firstpass/agents/municipal.py`, `state.py`, `synthesizer.py` — write blackboard |
| **Modify** | `scripts/ingest_band_output.py` — Redis persist + vector index |
| **Modify** | `src/lib/code-db.ts` — hybrid retrieval fallback chain |
| **Modify** | `src/lib/pipeline.ts` — source dedup, stream publish |
| **Modify** | `src/components/RunProgress.tsx` — Redis phase copy |
| **Modify** | `src/components/FindingInspector.tsx` — "Hybrid RAG · RedisVL" |
| **Modify** | `pyproject.toml` — add `redis`, `redisvl` |
| **Modify** | `.env.example` — note Search requirement |

---

## 10. Environment

```bash
# .env.local / Vercel
REDIS_URL=rediss://default:xxx@xxx.upstash.io:6379   # or Redis Cloud

# Optional — Agent Memory Server
AGENT_MEMORY_URL=http://localhost:8000
AGENT_MEMORY_TOKEN=dev-token
```

**Redis requirement:** RediSearch / Redis Stack / Redis 8 with Search module. Plain Redis without Search cannot run RedisVL indices — confirm provider before Phase 2.

---

## 11. Success criteria

| Check | How to verify |
|-------|---------------|
| No split-brain | Compare Codes reads `municipal_codes` from Redis blackboard without opening `output/` |
| Vector search works | Query "detached ADU height 18 feet" returns Gov Code §65852.2 chunk for LA |
| Hybrid beats lexical | Untagged OCR chunk retrieved by semantic query (not in RULE_TERMS) |
| Demo never hard-fails | Redis down → lexical fallback + cached sources (existing pattern) |
| Judges see Redis 3+ times | Blackboard write, chunk index, retrieval in inspector, correction re-query |
| Qualifying tool used | RedisVL index visible via `FT.INFO firstpass:codes` or Redis Cloud dashboard |

---

## 12. What not to do (scope guard)

- Do **not** rebuild the entire PLAN.md entity model — ship blackboard + hybrid RAG first.
- Do **not** remove lexical retrieval — keep it as deterministic fallback for tagged demo chunks.
- Do **not** block the demo on Agent Memory Server — Phase 5 is optional polish.
- Do **not** store API keys in Redis — only project artifacts and code corpora.

---

## 13. Submission one-liner

> *FirstPass uses Redis as a multi-agent knowledge layer for permit review: Band agents publish to a shared blackboard, RedisVL hybrid-searches jurisdiction-specific code at check time, and Agent Memory retains project context across the firm's three-phase workflow — so every citation is retrieved, not hallucinated.*

---

## 14. References

- [RedisVL docs](https://docs.redisvl.com)
- [RedisVL hybrid search](https://redis.io/docs/latest/develop/ai/redisvl/concepts/queries/)
- [Agent Memory Server](https://redis.github.io/agent-memory-server/)
- [FirstPass chunking strategy](./CHUNKING.md)
- [FirstPass execution brief](../PLAN.md)
