#!/usr/bin/env python3
"""Bridge the Band research agents' output into the chunking pipeline.

Your friend's Band agents (on the research engine) scrape building codes and
write plain-text reports to an ``output/`` folder via ``write_text_report`` —
files like ``municipal_codes.txt``, ``state_codes.txt``, ``building_codes.txt``,
``green_codes.txt`` … each beginning with a report header and containing OCR'd
code excerpts (no ``###`` markers).

This script turns ALL of that output into a chunkable city corpus:
  1. read every ``*.txt`` report in the Band output dir
  2. strip the report header, classify the file by code layer (category)
  3. write it to ``data/cities/<slug>/raw/<name>``
  4. build/merge ``meta.json`` (city identity + per-file source)
  5. run the chunker -> ``data/cities/<slug>/chunks.json``

After this, the city works straight from the codebase like any other. The
chunker's scrape mode auto-detects legal headings (SEC./§/4.303.1/R314.1/…), so
messy OCR reports chunk without any hand-marked sections.

Usage:
    python3 scripts/ingest_band_output.py --slug oakland-ca --city Oakland --state CA
    python3 scripts/ingest_band_output.py --slug la-from-band --output-dir /path/to/output
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Reuse the chunker's category detection + chunking so the two stay in lockstep.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import chunk_codes  # noqa: E402

ROOT = chunk_codes.ROOT
DEFAULT_OUTPUT_DIR = ROOT / "output"

# Report header written by the friend's write_text_report ends at a line of '='.
SEP_RE = re.compile(r"^={6,}\s*$")
URL_RE = re.compile(r"https?://[^\s)\]]+")


def strip_report_header(text: str) -> str:
    """Drop the 'FirstPass Code Research Report … ====' preamble if present."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if SEP_RE.match(line.strip()):
            return "\n".join(lines[i + 1 :]).strip()
    return text.strip()


def first_url(text: str) -> str:
    m = URL_RE.search(text)
    return m.group(0) if m else ""


def ingest(slug: str, output_dir: Path, city: str, state: str, include_summary: bool) -> int:
    if not output_dir.is_dir():
        print(f"! Band output dir not found: {output_dir}", file=sys.stderr)
        return 0

    reports = sorted(p for p in output_dir.glob("*.txt"))
    if not include_summary:
        reports = [p for p in reports if "final_summary" not in p.name.lower()]
    if not reports:
        print(f"! no .txt reports in {output_dir}", file=sys.stderr)
        return 0

    city_dir = chunk_codes.CITIES_DIR / slug
    raw_dir = city_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    # Merge into existing meta.json if present.
    meta: dict = {}
    meta_path = city_dir / "meta.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta.setdefault("slug", slug)
    if city:
        meta["city"] = city
    if state:
        meta["state"] = state
    meta.setdefault("city", slug)
    meta.setdefault("state", "")
    meta.setdefault("jurisdictionId", slug)
    raw_sources: dict = dict(meta.get("rawSources") or {})
    sources: list = list(meta.get("sources") or [])
    src_by_id = {s["id"]: s for s in sources}

    for n, report in enumerate(reports, start=1):
        raw_text = report.read_text(encoding="utf-8")
        body = strip_report_header(raw_text)
        category = chunk_codes.detect_category(report.stem)
        # Write the cleaned report into the city's raw corpus.
        (raw_dir / report.name).write_text(body + "\n", encoding="utf-8")
        # Assign a source id for this report (its archive/official URL if found).
        sid = f"B{n}"
        raw_sources[report.name] = sid
        if sid not in src_by_id:
            url = first_url(body) or "https://archive.org/"
            entry = {
                "id": sid,
                "url": url,
                "title": f"{chunk_codes.CATEGORY_LABELS.get(category, 'Code')} — Band research ({report.name})",
            }
            sources.append(entry)
            src_by_id[sid] = entry
        print(f"  ingested {report.name} -> category={category}, source={sid}")

    meta["rawSources"] = raw_sources
    meta["sources"] = sources
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"Chunking {slug} …")
    return chunk_codes.chunk_city(slug)


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest Band research output into a chunkable city corpus")
    parser.add_argument("--slug", required=True, help="target city slug under data/cities")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="Band agents' output/ folder")
    parser.add_argument("--city", default="", help="city display name")
    parser.add_argument("--state", default="", help="state abbreviation, e.g. CA")
    parser.add_argument("--include-summary", action="store_true", help="also ingest final_summary.txt")
    args = parser.parse_args()

    count = ingest(args.slug, Path(args.output_dir), args.city, args.state, args.include_summary)
    if count == 0:
        sys.exit(1)
    print(f"Done. {count} chunk(s) for {args.slug}. Commit data/cities/{args.slug}/ to make it permanent.")


if __name__ == "__main__":
    main()
