#!/usr/bin/env python3
"""Query the RedisVL code index — semantic (vector) search with TAG filters.

The companion to index_codes_redisvl.py. Embeds a natural-language query and runs
a KNN vector search over ``firstpass:codes``, filtered by jurisdiction /
applicability (the attached-vs-detached distinction). Use it to verify the index
and to demo semantic retrieval that the lexical scorer can't do.

Examples:
    uv run python scripts/query_codes_redisvl.py --slug los-angeles-ca \
        --query "detached ADU maximum height in feet"
    uv run python scripts/query_codes_redisvl.py --slug los-angeles-ca \
        --query "water closet flow rate" --applies-to detached_adu -k 3

Requires the vector extras (uv sync --extra vector) and a Redis with Search.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX_NAME = "firstpass:codes"
EMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


def _load_env() -> str:
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
        sys.exit("REDIS_URL is not set.")
    return url


def main() -> None:
    parser = argparse.ArgumentParser(description="Semantic query over firstpass:codes")
    parser.add_argument("--query", required=True, help="natural-language query")
    parser.add_argument("--slug", help="filter to one city")
    parser.add_argument("--category", help="filter to one code layer")
    parser.add_argument("--applies-to", help="detached_adu | attached_adu")
    parser.add_argument("-k", type=int, default=5, help="results to return")
    parser.add_argument("--json", action="store_true", help="raw JSON output")
    args = parser.parse_args()

    redis_url = _load_env()

    try:
        from redisvl.index import SearchIndex
        from redisvl.query import VectorQuery
        from redisvl.query.filter import Tag
        from redisvl.utils.vectorize import HFTextVectorizer
    except ImportError:
        sys.exit("redisvl not installed. Run: uv sync --extra vector")

    vectorizer = HFTextVectorizer(model=EMBED_MODEL)
    index = SearchIndex.from_existing(INDEX_NAME, redis_url=redis_url)

    # Build the TAG filter (jurisdiction + applicability + code layer).
    filt = None
    for field, value in (("city", args.slug), ("category", args.category), ("applies_to", args.applies_to)):
        if value:
            clause = Tag(field) == value
            filt = clause if filt is None else (filt & clause)

    query = VectorQuery(
        vector=vectorizer.embed(args.query),
        vector_field_name="embedding",
        return_fields=["chunk_id", "city", "category", "section", "source_id", "text"],
        num_results=args.k,
        filter_expression=filt,
    )
    results = index.query(query)

    if args.json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
        return

    if not results:
        print("No results. Is the index built? (scripts/index_codes_redisvl.py)")
        return

    print(f"Top {len(results)} for: {args.query!r}\n")
    for i, r in enumerate(results, 1):
        dist = float(r.get("vector_distance", 0))
        print(f"[{i}] {r.get('section', '(no section)')}  · {r.get('city')} · {r.get('category')}")
        print(f"    id={r.get('chunk_id')}  source={r.get('source_id')}  cos_dist={dist:.4f}")
        print(f"    {r.get('text', '')[:240].strip()}\n")


if __name__ == "__main__":
    main()
