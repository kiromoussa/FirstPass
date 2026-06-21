#!/usr/bin/env python3
"""Build the RedisVL hybrid-search index over the committed code corpora.

This is the Phase 2 upgrade in docs/REDIS_PLAN.md: the app's lexical
``retrieveCode()`` works for hand-tagged demo chunks, but real Band scrapes are
full of untagged OCR text. A RedisVL index — full-text (BM25) + a vector field
for semantic recall + TAG filters for jurisdiction/applicability — recovers the
provisions lexical scoring misses, and respects ``applies_to`` (the attached-vs-
detached height correction the Arize eval depends on).

What it does:
  1. read every ``data/cities/<slug>/chunks.json`` (or one --slug)
  2. embed each chunk's indexText (context header + body) with a local
     sentence-transformers model — zero API cost
  3. load them into the RediSearch index ``firstpass:codes`` (prefix ``codev:``)

The TypeScript query path (src/app/api/code/retrieve/route.ts) reads this SAME
index via FT.SEARCH, so indexing in Python and querying in TS share one index.

Requires the optional vector extras (heavy — torch):
    uv sync --extra vector
    uv run python scripts/index_codes_redisvl.py --all
Needs a Redis with the Search module (Redis Stack / Redis 8 / Redis Cloud with
Search). Plain Redis without RediSearch cannot host this index.

Verify afterwards:
    redis-cli FT.INFO firstpass:codes
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CITIES_DIR = ROOT / "data" / "cities"

INDEX_NAME = "firstpass:codes"
PREFIX = "codev"
# sentence-transformers/all-MiniLM-L6-v2 → 384-dim embeddings (matches §3.3).
EMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
EMBED_DIMS = 384


def _load_env() -> str:
    """Load REDIS_URL, honoring .env.local / .env if python-dotenv is around."""
    try:
        from dotenv import load_dotenv  # type: ignore

        for name in (".env.local", ".env"):
            p = ROOT / name
            if p.exists():
                load_dotenv(p)
    except Exception:
        pass
    url = os.getenv("REDIS_URL")
    if not url:
        sys.exit("REDIS_URL is not set — point it at a Redis with the Search module.")
    return url


def index_text(chunk: dict) -> str:
    """Mirror src/lib/code-db.ts indexText(): context header + body."""
    ctx = chunk.get("context")
    text = chunk.get("text", "")
    return f"{ctx}\n{text}" if ctx else text


def applies_to(chunk: dict) -> str:
    """Derive the applicability tag from topics, mirroring the lexical scorer's
    attached/detached handling. 'attached' chunks serve attached ADUs; everything
    else is general (detached + the rest)."""
    return "attached_adu" if "attached" in (chunk.get("topics") or []) else "detached_adu"


def build_schema() -> dict:
    return {
        "index": {"name": INDEX_NAME, "prefix": PREFIX, "storage_type": "hash"},
        "fields": [
            {"name": "chunk_id", "type": "tag"},
            {"name": "city", "type": "tag"},
            {"name": "category", "type": "tag"},
            {"name": "applies_to", "type": "tag"},
            {"name": "topics", "type": "tag", "attrs": {"separator": "|"}},
            {"name": "source_id", "type": "tag"},
            {"name": "section", "type": "text"},
            {"name": "text", "type": "text"},
            {
                "name": "embedding",
                "type": "vector",
                "attrs": {
                    "dims": EMBED_DIMS,
                    "distance_metric": "cosine",
                    "algorithm": "hnsw",
                    "datatype": "float32",
                },
            },
        ],
    }


def iter_cities(slug: str | None):
    if slug:
        yield slug, CITIES_DIR / slug / "chunks.json"
        return
    for d in sorted(p for p in CITIES_DIR.iterdir() if p.is_dir()):
        f = d / "chunks.json"
        if f.exists():
            yield d.name, f


def main() -> None:
    parser = argparse.ArgumentParser(description="Index code corpora into RedisVL")
    parser.add_argument("--slug", help="one city slug (default: all cities)")
    parser.add_argument("--all", action="store_true", help="index every city")
    args = parser.parse_args()
    if not args.slug and not args.all:
        parser.error("pass --slug <city> or --all")

    redis_url = _load_env()

    try:
        from redisvl.index import SearchIndex
        from redisvl.schema import IndexSchema
        from redisvl.utils.vectorize import HFTextVectorizer
    except ImportError:
        sys.exit(
            "redisvl not installed. Install the vector extras:\n"
            "  uv sync --extra vector\n"
            "(pulls in redisvl + sentence-transformers / torch)"
        )

    print(f"Loading embedding model {EMBED_MODEL} …")
    vectorizer = HFTextVectorizer(model=EMBED_MODEL)

    schema = IndexSchema.from_dict(build_schema())
    index = SearchIndex(schema, redis_url=redis_url)
    # Recreate so a re-ingest reflects the latest chunks (idempotent for demo).
    index.create(overwrite=True, drop=True)
    print(f"Index {INDEX_NAME!r} ready (prefix {PREFIX!r}).")

    total = 0
    for slug, path in iter_cities(args.slug):
        try:
            chunks = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            print(f"  ! skip {slug}: {exc}", file=sys.stderr)
            continue
        if not isinstance(chunks, list) or not chunks:
            continue

        texts = [index_text(c) for c in chunks]
        print(f"  {slug}: embedding {len(texts)} chunks …")
        embeddings = vectorizer.embed_many(texts, as_buffer=True)

        records = []
        for c, emb in zip(chunks, embeddings):
            records.append(
                {
                    "chunk_id": c["id"],
                    "city": slug,
                    "category": c.get("category") or "general",
                    "applies_to": applies_to(c),
                    "topics": "|".join(c.get("topics") or []) or "none",
                    "source_id": c.get("sourceId") or "",
                    "section": c.get("section") or "",
                    "text": index_text(c),
                    "embedding": emb,
                }
            )
        index.load(records, id_field="chunk_id")
        total += len(records)
        print(f"  {slug}: indexed {len(records)} chunks")

    print(f"Done. {total} chunk(s) indexed into {INDEX_NAME}.")
    print("Verify: redis-cli FT.INFO firstpass:codes")


if __name__ == "__main__":
    main()
