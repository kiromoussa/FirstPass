#!/usr/bin/env python3
"""Chunk a city's raw building-code research into retrievable units.

This is the script the Code Synthesizer step runs once a city's code has been
researched (by the Band agents or the Browserbase scraper) and stored under
``data/cities/<slug>/raw/*.txt``. It splits that raw text into small,
topic-tagged chunks and writes ``data/cities/<slug>/chunks.json``.

Why chunk at all: the compliance checks should retrieve only the one code chunk
that governs a given rule, never the whole code book. Pre-chunking here — and
committing the result to the repo — means an already-researched city is instant
and token-cheap at request time: the app just loads ``chunks.json`` and queries
it. No model, no embeddings, no network — fully deterministic and reproducible.

Raw format (per .txt file): sections delimited by a ``### `` header line whose
text is the section label and which carries the source id in brackets, e.g.

    ### AMC §30-5.21(b) — Unit Size [S1]
    The maximum floor area of a detached ADU shall not exceed 1,200 sq ft ...

Output: a JSON array of chunks matching the CodeChunk interface in
``src/lib/code-db.ts``:  {id, section, topics, text, sourceId}.

Usage:
    python3 scripts/chunk_codes.py <slug>      # one city, e.g. alameda-ca
    python3 scripts/chunk_codes.py --all       # every city under data/cities
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Repo root = parent of this scripts/ directory.
ROOT = Path(__file__).resolve().parent.parent
CITIES_DIR = ROOT / "data" / "cities"

# Target chunk size. A code section is the natural retrieval unit, so we keep a
# whole section together and only split when it exceeds this. ~1100 chars ≈ 275
# tokens — within the "a few hundred tokens" sweet spot for retrieval (see
# docs/CHUNKING.md). When a split is unavoidable we carry OVERLAP_CHARS of the
# previous piece into the next so a provision isn't severed from its context.
MAX_CHARS = 1100
OVERLAP_CHARS = 120

# Rule-key topics inferred from a chunk's header + body. Keys mirror the rule
# keys used by the compliance engine (src/lib/types.ts Rule.key) so a chunk can
# be retrieved by the rule it governs. Order is stable for deterministic output.
RULE_KEYWORDS: list[tuple[str, list[str]]] = [
    ("maxSize", ["unit size", "floor area", "square feet", "square foot", "conditioned space"]),
    ("unitSize", ["unit size", "floor area", "conditioned space"]),
    ("height", ["height", "feet in height", "roof pitch"]),
    ("setbackSide", ["side setback"]),
    ("setbackRear", ["rear setback"]),
    ("requiredDocs", ["site plan", "floor plan", "elevation", "title-24", "submittal", "checklist", "document"]),
]

HEADER_RE = re.compile(r"^#{2,4}\s+(.*?)\s*$")
SOURCE_RE = re.compile(r"\[([A-Za-z0-9_-]+)\]\s*$")


def slugify(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


def _match(text: str) -> list[str]:
    text = text.lower()
    return [key for key, keywords in RULE_KEYWORDS if any(kw in text for kw in keywords)]


def infer_topics(section: str, body: str) -> list[str]:
    """Topic keys a chunk governs. Code-section headers are reliably topical
    ("Unit Size", "Rear Setback", "Height"), so match the header first and only
    fall back to the body when the header names no rule — that keeps incidental
    body mentions (e.g. "floor area" inside a setback clause) from mis-tagging."""
    topics = _match(section) or _match(f"{section}\n{body}")
    # An attached-unit chunk is disambiguated from the detached one at retrieval
    # time via an explicit "attached" topic (see retrieveCode()).
    if "height" in topics and "attached" in f"{section}\n{body}".lower():
        topics.append("attached")
    return topics


def split_body(body: str) -> list[str]:
    """Split an over-long section into <=MAX_CHARS chunks on paragraph, then
    sentence, boundaries. Short sections pass through as a single chunk."""
    body = body.strip()
    if len(body) <= MAX_CHARS:
        return [body] if body else []

    # Prefer paragraph boundaries.
    units = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
    # Any paragraph still too long is further split into sentences.
    pieces: list[str] = []
    for unit in units:
        if len(unit) <= MAX_CHARS:
            pieces.append(unit)
            continue
        sentences = re.split(r"(?<=[.;])\s+", unit)
        pieces.extend(s.strip() for s in sentences if s.strip())

    # Greedily pack pieces back up to MAX_CHARS so we don't over-fragment.
    chunks: list[str] = []
    current = ""
    for piece in pieces:
        if not current:
            current = piece
        elif len(current) + 1 + len(piece) <= MAX_CHARS:
            current = f"{current} {piece}"
        else:
            chunks.append(current)
            # Start the next chunk with a tail of this one (overlap) so a
            # provision split across the boundary keeps its lead-in context.
            tail = current[-OVERLAP_CHARS:].lstrip()
            current = f"{tail} {piece}" if tail else piece
    if current:
        chunks.append(current)
    return chunks


def parse_sections(text: str) -> list[tuple[str, str, str]]:
    """Return (section_label, source_id, body) for each ### section in a file."""
    sections: list[tuple[str, str, str]] = []
    current_header: str | None = None
    current_source = ""
    buffer: list[str] = []

    def flush() -> None:
        if current_header is not None:
            sections.append((current_header, current_source, "\n".join(buffer).strip()))

    for line in text.splitlines():
        m = HEADER_RE.match(line)
        if m:
            flush()
            header = m.group(1)
            sm = SOURCE_RE.search(header)
            current_source = sm.group(1) if sm else ""
            current_header = SOURCE_RE.sub("", header).strip()
            buffer = []
        elif current_header is not None:
            buffer.append(line)
        # Lines before the first header (file preamble) are ignored.
    flush()
    return sections


def doc_label(stem: str) -> str:
    """Human label for a raw file, used in the contextual header."""
    s = stem.lower()
    if "municipal" in s or "local" in s or "zoning" in s:
        return "Municipal code"
    if "state" in s:
        return "State code"
    return stem.replace("_", " ").strip().capitalize() or "Code"


def chunk_city(slug: str) -> int:
    city_dir = CITIES_DIR / slug
    raw_dir = city_dir / "raw"
    if not raw_dir.is_dir():
        print(f"  ! no raw/ directory for '{slug}' — skipping", file=sys.stderr)
        return 0

    # meta.json situates every chunk (jurisdiction) for contextual retrieval.
    meta = {}
    meta_path = city_dir / "meta.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    place = ", ".join(p for p in [meta.get("city"), meta.get("state")] if p) or slug

    chunks: list[dict] = []
    for txt in sorted(raw_dir.glob("*.txt")):
        text = txt.read_text(encoding="utf-8")
        label = doc_label(txt.stem)
        for section, source_id, body in parse_sections(text):
            parts = split_body(body)
            base = slugify(section) or txt.stem
            topics = infer_topics(section, body)
            # Contextual header (Anthropic "contextual retrieval"): a 1-line
            # situating prefix indexed with the chunk so it retrieves even when
            # the query terms aren't in the body. Built deterministically from
            # structure — no LLM call needed.
            context = f"{place} · {label} · {section}"
            for i, part in enumerate(parts):
                cid = f"{slug}-{base}" if len(parts) == 1 else f"{slug}-{base}-{i}"
                chunks.append(
                    {
                        "id": cid,
                        "section": section,
                        "topics": topics,
                        "text": part,
                        "sourceId": source_id,
                        "citation": section,
                        "context": context,
                        "tokensEst": max(1, len(part) // 4),
                    }
                )

    out = city_dir / "chunks.json"
    out.write_text(json.dumps(chunks, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    untagged = [c["id"] for c in chunks if not c["topics"]]
    print(f"  {slug}: {len(chunks)} chunks -> {out.relative_to(ROOT)}")
    if untagged:
        print(f"    note: {len(untagged)} chunk(s) matched no rule topic: {untagged}")
    return len(chunks)


def main() -> None:
    parser = argparse.ArgumentParser(description="Chunk a city's raw building-code research")
    parser.add_argument("slug", nargs="?", help="city slug under data/cities (e.g. alameda-ca)")
    parser.add_argument("--all", action="store_true", help="chunk every city under data/cities")
    args = parser.parse_args()

    if args.all:
        slugs = sorted(p.name for p in CITIES_DIR.iterdir() if p.is_dir())
    elif args.slug:
        slugs = [args.slug]
    else:
        parser.error("provide a city slug or --all")

    if not slugs:
        print("No cities found.", file=sys.stderr)
        sys.exit(1)

    total = 0
    for slug in slugs:
        total += chunk_city(slug)
    print(f"Done. {total} chunk(s) across {len(slugs)} city/cities.")


if __name__ == "__main__":
    main()
