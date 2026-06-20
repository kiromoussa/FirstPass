# Chunking building codes for retrieval

How FirstPass turns a city's researched building code into small, retrievable
units, and *why* it chunks the way it does. The goal: at check time, retrieve
**only the one provision that governs a rule** — never the whole code book —
so prompts stay small, cheap, and citable.

This is implemented by [`scripts/chunk_codes.py`](../scripts/chunk_codes.py)
(raw → `chunks.json`) and consumed by [`src/lib/code-db.ts`](../src/lib/code-db.ts).

## Why building codes need their own strategy

Building/zoning codes aren't prose — they're a **hierarchy of numbered
provisions** (Title → Chapter → Article → Section → subsection), dense with
exact identifiers (`§30-5.21(b)`, `1,200 sq ft`, `18 feet`) and cross-references.
Two consequences:

1. **The section is the natural retrieval unit.** A single subsection usually
   states one complete rule. Splitting by fixed character windows would sever a
   provision from its qualifier ("…shall not exceed 1,200 sq ft" / "…except for
   conversions"). So we split on **structure first**, size second.
2. **Exact terms matter more than semantics.** Queries hit on section numbers
   and literal values. Pure embedding similarity under-retrieves these; lexical
   matching (BM25-style) is essential. FirstPass's retrieval is deterministic
   tag + term scoring, which is lexical by construction.

## The strategy (and the evidence)

| Decision | What we do | Why |
| --- | --- | --- |
| **Structure-aware split** | Split on `### Section [Sx]` headers; one section = one chunk. | Section-based / document-structure chunking is the recommended approach for structured legal docs. |
| **Size target** | Keep a whole section together; split only above ~1100 chars (~275 tokens). | "A few hundred tokens" / 256–512 is the retrieval sweet spot; codes sections fit. |
| **Overlap on splits** | When a section must split, carry ~120 chars of the previous piece forward. | Overlap preserves continuity across the boundary. |
| **Contextual header** | Prepend `City, State · Code · §Section` to each chunk **when indexing** (`context` field; display still uses `text`). | Anthropic *Contextual Retrieval*: prepending 50–100 tokens of situating context cut retrieval failures **35%** (embeddings) / **49%** with BM25. We build it deterministically from structure — no LLM call. |
| **Carry citation + source** | Every chunk keeps `section`, `citation`, and `sourceId` → URL in `meta.json`. | Findings must cite the exact code section + official source. |
| **Topic tags** | Infer rule keys (`maxSize`, `height`, `setbackSide`…) from the header, body as fallback. | Lets a check retrieve by the rule it's evaluating, header-first to avoid incidental-term mis-tagging. |
| **Hybrid + rerank (direction)** | Lexical term/tag scoring today; embeddings + BM25 rank-fusion + rerank is the upgrade path. | Contextual embeddings + BM25 + rerank cut failures **67%**. |

## Chunk shape

```jsonc
{
  "id": "alameda-ca-amc-30-5-21-b-unit-size",
  "section": "AMC §30-5.21(b) — Unit Size",
  "topics": ["maxSize", "unitSize"],          // rule keys this chunk governs
  "text": "The maximum floor area … 1,200 square feet …",  // verbatim, for citing
  "sourceId": "S1",                            // → meta.json source URL
  "citation": "AMC §30-5.21(b) — Unit Size",
  "context": "Alameda, CA · Municipal code · AMC §30-5.21(b) — Unit Size",
  "tokensEst": 76
}
```

## Pipeline

```
research (Band agents / scraper)
  → data/cities/<slug>/raw/*.txt   + meta.json     (stored in the repo)
  → python3 scripts/chunk_codes.py <slug>          (deterministic chunker)
  → data/cities/<slug>/chunks.json                 (committed)
  → code-db.ts loads chunks.json on request         (instant, token-cheap)
```

Once a city's `data/cities/<slug>/` is committed, that city works **straight
from the codebase** — no re-research, no model, no network. New cities are
ingested via `POST /api/cities/ingest`, which writes the raw docs, runs the
chunker, and seeds the result.

## Raw format contract

Each raw `.txt` is split into sections by a header line, with the source id in
brackets so each chunk can be traced to an official URL:

```
### AMC §30-5.21(b) — Unit Size [S1]
The maximum floor area of a detached ADU shall not exceed 1,200 square feet …
```

## Known gaps / upgrade path

- **Tables** (setback/height matrices) should be kept whole with their column
  headers; today they'd be treated as paragraph text.
- **Cross-references** ("see §30-5.20") aren't resolved/expanded yet.
- **Retrieval** is lexical; adding embeddings + BM25 rank-fusion + a reranker is
  the highest-leverage next step per the Anthropic numbers above.

## Sources

- [Anthropic — Introducing Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval)
- [Pinecone — Chunking Strategies for LLM Applications](https://www.pinecone.io/learn/chunking-strategies/)
