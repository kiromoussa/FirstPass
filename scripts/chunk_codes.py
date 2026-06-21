#!/usr/bin/env python3
"""Chunk a city's raw building-code research into retrievable units.

This is the script the Code Synthesizer step runs once a city's code has been
researched (by the Band agents or the Browserbase scraper) and stored under
``data/cities/<slug>/raw/*.txt``. It splits that raw text into small,
topic-tagged, category-tagged chunks and writes ``data/cities/<slug>/chunks.json``.

Why chunk at all: real codes run to hundreds of pages across many layers (city
zoning, county, state, building, residential, plumbing, green/energy). You never
feed those to a model — you chunk once, commit the chunks, and at request time
retrieve only the handful of provisions relevant to a check. An already-
researched city is then instant and token-cheap: load ``chunks.json`` and query.
Deterministic, no model, no embeddings, no network.

Two input modes per .txt file:
  * Curated  — sections delimited by an explicit ``### `` header carrying the
    source id in brackets:  ``### LAMC §12.22 A.33(c) — Unit Size [S1]``
  * Scraped  — no ``###`` at all: real code dumps. We auto-detect legal headings
    (SEC./SECTION/ARTICLE/CHAPTER, ``§ 65852.2``, ``4.303.1``, ``R314.1``,
    ``12.22 A.33``, ALL-CAPS titles) and split on them. Source id then comes from
    meta.json ``rawSources`` (filename -> id) or the first declared source.

Category (green/plumbing/building/residential/county/state/city/...) is derived
from the file name so retrieval can scope to a code layer.

Output: a JSON array matching the CodeChunk interface in ``src/lib/code-db.ts``.

Usage:
    python3 scripts/chunk_codes.py <slug>      # one city, e.g. los-angeles-ca
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

# Topics inferred from a chunk's header + body. The first six mirror the rule
# keys the compliance engine checks (src/lib/types.ts Rule.key); the rest give
# multi-domain provisions a handle so they're retrievable across code layers.
# Order is stable for deterministic output.
RULE_KEYWORDS: list[tuple[str, list[str]]] = [
    ("maxSize", ["unit size", "floor area", "square feet", "square foot", "conditioned space"]),
    ("unitSize", ["unit size", "floor area", "conditioned space"]),
    ("height", ["height", "feet in height", "roof pitch"]),
    ("setbackSide", ["side setback", "side yard"]),
    ("setbackRear", ["rear setback", "rear yard"]),
    ("requiredDocs", ["site plan", "plot plan", "floor plan", "elevation", "title-24", "submittal", "checklist", "application"]),
    # broader code domains
    ("waterEfficiency", ["water closet", "gallons per", "gpf", "gpm", "water conserving", "flow rate", "lavatory"]),
    ("smokeAlarm", ["smoke alarm", "carbon monoxide"]),
    ("egress", ["egress", "emergency escape", "exit discharge", "means of egress"]),
    ("fireProtection", ["sprinkler", "fire-resistance", "fire resistance", "fire separation"]),
    ("ventilation", ["ventilation", "mechanical ventilation", "exhaust"]),
    ("evCharging", ["electric vehicle", "ev charging", "ev capable", "ev ready"]),
    ("solar", ["photovoltaic", "solar"]),
    ("occupancy", ["occupancy", "occupant load", "occupant-load"]),
    ("foundation", ["foundation", "footing", "slab"]),
]

# Code layer (category) derived from the raw filename. First match wins.
CATEGORY_RULES: list[tuple[str, list[str]]] = [
    ("green", ["green", "calgreen"]),
    ("energy", ["energy", "title24", "title-24"]),
    ("plumbing", ["plumb", "cpc"]),
    ("mechanical", ["mechanical", "cmc"]),
    ("electrical", ["electrical", "cec"]),
    ("fire", ["fire", "cfc"]),
    ("residential", ["residential", "crc"]),
    ("building", ["building", "cbc"]),
    ("county", ["county"]),
    ("state", ["state", "hcd"]),
    ("city", ["city", "municipal", "zoning", "lamc", "local"]),
]

CATEGORY_LABELS = {
    "green": "Green building standards (CALGreen)",
    "energy": "Energy code (Title 24)",
    "plumbing": "Plumbing code (CPC)",
    "mechanical": "Mechanical code (CMC)",
    "electrical": "Electrical code (CEC)",
    "fire": "Fire code (CFC)",
    "residential": "Residential code (CRC)",
    "building": "Building code (CBC)",
    "county": "County code",
    "state": "State code",
    "city": "City / municipal code",
    "general": "Code",
}

# --- heading detection -------------------------------------------------------
MD_HEAD = re.compile(r"^#{2,4}\s+(.*?)\s*$")
SOURCE_RE = re.compile(r"\[([A-Za-z0-9_-]+)\]\s*$")
KEYWORD_HEAD = re.compile(
    r"^\s*(SEC\.|SECTION|ARTICLE|CHAPTER|DIVISION|TITLE|APPENDIX|PART)\b", re.I
)
# A structured section number (must contain a separator . - ( so a bare "18" in
# "18 feet in height" is NOT mistaken for a heading) followed by a title.
NUM_HEAD = re.compile(r"^\s*§?\s*[A-Z]?\d+[\w()-]*[.\-(][\w.\-()]*(\s+[A-Z]\.\d[\w.\-()]*)?\s+\S")
ALLCAPS_HEAD = re.compile(r"^[A-Z0-9][A-Z0-9 ,.&/()\-§'’]{6,}$")


def slugify(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


def detect_category(stem: str) -> str:
    s = stem.lower()
    for category, keywords in CATEGORY_RULES:
        if any(kw in s for kw in keywords):
            return category
    return "general"


def is_legal_heading(line: str) -> bool:
    """Heuristic: does this line start a new code section (scrape mode)?"""
    s = line.strip()
    if not s or len(s) > 100:
        return False
    if KEYWORD_HEAD.match(s) or NUM_HEAD.match(s):
        return True
    if ALLCAPS_HEAD.match(s) and any(ch.isalpha() for ch in s):
        return True
    return False


def _match(text: str) -> list[str]:
    text = text.lower()
    return [key for key, keywords in RULE_KEYWORDS if any(kw in text for kw in keywords)]


def infer_topics(section: str, body: str) -> list[str]:
    """Topic keys a chunk governs. Code-section headers are reliably topical, so
    match the header first and fall back to the body only when the header names
    no rule — that keeps incidental body mentions from mis-tagging."""
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

    units = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
    pieces: list[str] = []
    for unit in units:
        if len(unit) <= MAX_CHARS:
            pieces.append(unit)
            continue
        sentences = re.split(r"(?<=[.;])\s+", unit)
        pieces.extend(s.strip() for s in sentences if s.strip())

    chunks: list[str] = []
    current = ""
    for piece in pieces:
        if not current:
            current = piece
        elif len(current) + 1 + len(piece) <= MAX_CHARS:
            current = f"{current} {piece}"
        else:
            chunks.append(current)
            # Overlap: carry a tail of the previous chunk so a provision split
            # across the boundary keeps its lead-in context.
            tail = current[-OVERLAP_CHARS:].lstrip()
            current = f"{tail} {piece}" if tail else piece
    if current:
        chunks.append(current)
    return chunks


def parse_sections(text: str, default_source: str) -> list[tuple[str, str, str]]:
    """Return (section_label, source_id, body) for each section in a file.

    Curated files (any ``### `` header present) are split on those headers only.
    Scraped files (no ``###``) are split on auto-detected legal headings, with
    the source id defaulting to default_source."""
    curated = any(MD_HEAD.match(ln) for ln in text.splitlines())
    sections: list[tuple[str, str, str]] = []
    current_header: str | None = None
    current_source = ""
    buffer: list[str] = []

    def flush() -> None:
        if current_header is not None:
            sections.append((current_header, current_source, "\n".join(buffer).strip()))

    def open_section(header: str) -> None:
        nonlocal current_header, current_source, buffer
        sm = SOURCE_RE.search(header)
        current_source = sm.group(1) if sm else default_source
        current_header = SOURCE_RE.sub("", header).strip()
        buffer = []

    for line in text.splitlines():
        md = MD_HEAD.match(line)
        is_head = bool(md) if curated else is_legal_heading(line)
        if is_head:
            flush()
            open_section(md.group(1) if md else line.strip())
        elif current_header is not None:
            buffer.append(line)
        # Lines before the first header (file preamble) are ignored.
    flush()
    return sections


def chunk_city(slug: str) -> int:
    city_dir = CITIES_DIR / slug
    raw_dir = city_dir / "raw"
    if not raw_dir.is_dir():
        print(f"  ! no raw/ directory for '{slug}' — skipping", file=sys.stderr)
        return 0

    # meta.json situates every chunk (jurisdiction) and maps untagged scrapes to
    # their source id via an optional rawSources {filename: sourceId} table.
    meta: dict = {}
    meta_path = city_dir / "meta.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    place = ", ".join(p for p in [meta.get("city"), meta.get("state")] if p) or slug
    raw_sources = meta.get("rawSources") or {}
    first_source = (meta.get("sources") or [{}])[0].get("id", "")

    chunks: list[dict] = []
    by_category: dict[str, int] = {}
    for txt in sorted(raw_dir.glob("*.txt")):
        text = txt.read_text(encoding="utf-8")
        category = detect_category(txt.stem)
        label = CATEGORY_LABELS.get(category, "Code")
        default_source = raw_sources.get(txt.name, first_source)
        for section, source_id, body in parse_sections(text, default_source):
            parts = split_body(body)
            base = slugify(section) or txt.stem
            topics = infer_topics(section, body)
            # Contextual header (Anthropic "contextual retrieval"): a 1-line
            # situating prefix indexed with the chunk so it retrieves even when
            # the query terms aren't in the body. Built from structure — no LLM.
            context = f"{place} · {label} · {section}"
            for i, part in enumerate(parts):
                cid = f"{slug}-{category}-{base}"
                if len(parts) > 1:
                    cid = f"{cid}-{i}"
                chunks.append(
                    {
                        "id": cid,
                        "category": category,
                        "section": section,
                        "topics": topics,
                        "text": part,
                        "sourceId": source_id,
                        "citation": section,
                        "context": context,
                        "tokensEst": max(1, len(part) // 4),
                    }
                )
                by_category[category] = by_category.get(category, 0) + 1

    out = city_dir / "chunks.json"
    out.write_text(json.dumps(chunks, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    cats = ", ".join(f"{k}:{v}" for k, v in sorted(by_category.items()))
    print(f"  {slug}: {len(chunks)} chunks ({cats}) -> {out.relative_to(ROOT)}")
    untagged = [c["id"] for c in chunks if not c["topics"]]
    if untagged:
        print(f"    note: {len(untagged)} chunk(s) matched no rule topic (still retrievable by category/text)")
    return len(chunks)


def main() -> None:
    parser = argparse.ArgumentParser(description="Chunk a city's raw building-code research")
    parser.add_argument("slug", nargs="?", help="city slug under data/cities (e.g. los-angeles-ca)")
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
