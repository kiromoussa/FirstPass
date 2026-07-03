#!/usr/bin/env python3
"""Automated corpus refresh — fetch current official/legal text, detect real
changes, regenerate chunks.json, and (for high-confidence numeric threshold
changes) update rules.json directly.

This replaces the manual "research -> ingest_band_output.py -> chunk_codes.py"
loop for staying current: run this on a schedule and each city's corpus stays
synced to the actual current law/code instead of a one-time snapshot.

Pipeline per source (see firstpass.corpus_sources for the registry + the
robots.txt audit behind each site):
  1. FETCH   plain httpx for open sites (HCD, DGS, Internet Archive); a real
             Browserbase + Playwright browser session for sites behind an
             active Cloudflare/WAF challenge (Justia, amlegal, Municode) —
             same mechanism firstpass.browserbase_tool already uses.
  2. EXTRACT clean text (bs4 for HTML, pypdf for PDF) + a "recency marker"
             regex match (an amendment citation, a "current through" footer,
             an edition/effective-date line) that lets a re-fetch tell a real
             legal change from a cosmetic page edit.
  3. WRITE   data/cities/<slug>/raw/<key>.txt, with the recency marker + fetch
             timestamp in a header comment.
  4. DIFF    against the last git-committed version of that file. Unchanged
             files skip steps 5-6 (no wasted chunking/LLM calls).
  5. CHUNK   re-run chunk_codes.chunk_city(slug) — same deterministic chunker
             the manual path already uses, so retrieval is unaffected.
  6. PROPOSE for changed sources whose category matches a known numeric rule
             key, ask the model for candidate threshold updates with a
             citation + verbatim quote + confidence. >=CONFIDENCE_AUTO_APPLY
             writes straight to rules.json (git history is the safety net);
             anything less goes to pending-rule-changes.json for review.
  7. LOG     append a dated entry to data/cities/<slug>/CHANGELOG.md.

Usage:
    uv run python scripts/refresh_corpus.py --all
    uv run python scripts/refresh_corpus.py --slug los-angeles-ca
    uv run python scripts/refresh_corpus.py --slug alameda-ca --dry-run
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import chunk_codes  # noqa: E402 — reuse the exact chunker the manual path uses

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from firstpass.corpus_sources import RefreshSource, sources_for_city  # noqa: E402

ROOT = chunk_codes.ROOT
CITIES_DIR = chunk_codes.CITIES_DIR

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("refresh_corpus")

# A threshold-relevant rule candidate at or above this confidence writes
# straight to rules.json. Below it, we don't trust a single model read enough
# to change what PASS/FAIL means on a real permit — it goes to
# pending-rule-changes.json for a human to confirm instead.
CONFIDENCE_AUTO_APPLY = 0.8

KNOWN_RULE_KEYS = [
    "maxSize", "height", "setbackFront", "setbackRear", "setbackSide",
    "lotCoverage", "far", "parking", "requiredDocs",
]
KNOWN_UNITS = ["ft", "sqft", "pct", "far", "spaces", "units", "docs"]
# Mirrors src/lib/code-db.ts RULE_TERMS (numeric keys only) — used to decide
# whether a changed source is even worth an LLM extraction pass.
RULE_TERMS: dict[str, list[str]] = {
    "maxSize": ["floor area", "square feet", "square foot", "maximum", "exceed", "size"],
    "height": ["height", "feet in height", "roof pitch", "stories", "story"],
    "setbackSide": ["side setback", "side yard"],
    "setbackRear": ["rear setback", "rear yard"],
    "setbackFront": ["front setback", "front yard", "prevailing setback"],
    "lotCoverage": ["lot coverage", "buildable area", "percent of the lot"],
    "far": ["floor area ratio", "residential floor area"],
    "parking": ["parking", "off-street", "covered parking", "spaces per unit"],
}


def _load_env() -> None:
    try:
        from dotenv import load_dotenv  # type: ignore

        for name in (".env.local", ".env"):
            p = ROOT / name
            if p.exists():
                load_dotenv(p)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Fetch + extract
# ---------------------------------------------------------------------------


def _bs4_text(html: str) -> str:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "header", "footer", "aside", "noscript"]):
        tag.decompose()
    # Prefer a plausible main-content container; fall back to the largest
    # remaining text block (a simple boilerplate-removal heuristic that works
    # across the plain server-rendered gov/legal sites this script targets).
    for sel in ["main", "article", "#content", ".content", "#main-content", ".page-content"]:
        el = soup.select_one(sel)
        if el and len(el.get_text(strip=True)) > 400:
            return re.sub(r"\n{3,}", "\n\n", el.get_text("\n", strip=True))
    candidates = soup.find_all(["div", "section"])
    best = max(candidates, key=lambda c: len(c.get_text(strip=True)), default=None)
    text = best.get_text("\n", strip=True) if best is not None else soup.get_text("\n", strip=True)
    return re.sub(r"\n{3,}", "\n\n", text)


def _pdf_text(data: bytes) -> str:
    from io import BytesIO

    from pypdf import PdfReader

    reader = PdfReader(BytesIO(data))
    return "\n\n".join((page.extract_text() or "") for page in reader.pages)


def fetch_httpx(source: RefreshSource) -> str:
    import httpx

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
    }
    r = httpx.get(source.fetch_url, headers=headers, timeout=30, follow_redirects=True)
    r.raise_for_status()
    if source.kind == "pdf":
        return _pdf_text(r.content)
    return _bs4_text(r.text)


class ChallengeNotCleared(Exception):
    """The site's Cloudflare/WAF JS challenge never resolved within the wait budget."""


# Justia's bot-check is intermittent: sometimes a fast auto-passing check,
# sometimes a slower Turnstile-style challenge that needs real wall-clock time
# (or a fresh session/IP) to clear. Retry a bounded number of times with a
# fresh session and a longer wait before giving up — the caller (fetch_source)
# treats a final failure as non-fatal (logs it, keeps the previous raw text).
_CHALLENGE_RETRY_TIMEOUTS_MS = [45_000, 90_000]


def fetch_browser(source: RefreshSource) -> str:
    """Fetch via a real Browserbase + Playwright session — needed for sites
    behind an active Cloudflare/WAF challenge that a plain GET can't pass."""
    last_error: Exception | None = None
    for timeout_ms in _CHALLENGE_RETRY_TIMEOUTS_MS:
        try:
            return _fetch_browser_once(source, timeout_ms)
        except ChallengeNotCleared as e:
            last_error = e
            logger.warning(f"    [{source.key}] challenge didn't clear within {timeout_ms}ms, retrying with a fresh session…")
    raise last_error or ChallengeNotCleared("unknown failure")


def _fetch_browser_once(source: RefreshSource, timeout_ms: int) -> str:
    from browserbase import Browserbase
    from playwright.sync_api import sync_playwright

    api_key = os.environ["BROWSERBASE_API_KEY"]
    project_id = os.environ["BROWSERBASE_PROJECT_ID"]
    bb = Browserbase(api_key=api_key)
    session = bb.sessions.create(
        project_id=project_id,
        browser_settings={"blockAds": True, "recordSession": True, "solveCaptchas": True},
    )
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(session.connect_url)
            try:
                context = browser.contexts[0] if browser.contexts else browser.new_context()
                page = context.pages[0] if context.pages else context.new_page()
                _goto_past_challenge(page, source.fetch_url, timeout_ms=timeout_ms)
                text = _page_text(page)

                if source.enumerate_articles:
                    return _fetch_justia_chapter_sections(page, source.fetch_url, text, source.enumerate_articles)

                if source.search_terms and not _looks_relevant(text, source.search_terms):
                    if _try_search(page, source.search_terms):
                        text = _page_text(page)
                    else:
                        link = _best_link(page, source.fetch_url, source.search_terms)
                        if link:
                            _goto_past_challenge(page, link, timeout_ms=timeout_ms)
                            text = _page_text(page)
                return text
            finally:
                browser.close()
    finally:
        try:
            bb.sessions.update(session.id, status="REQUEST_RELEASE", project_id=project_id)
        except Exception:
            pass


def _fetch_justia_chapter_sections(page, chapter_url: str, index_text: str, articles: tuple[int, ...]) -> str:
    """The Justia chapter INDEX page only lists article/section ranges, not
    statute text (e.g. 'ARTICLE 1 - General Provisions 66310-66313.5'). Parse
    the ranges for the requested articles, visit each section page in turn,
    and concatenate their real text (each with its own amendment citation)."""
    section_refs = _parse_justia_section_ranges(index_text, articles)
    logger.info(f"    justia: enumerating {len(section_refs)} section(s) from articles {articles}: {section_refs}")

    parts: list[str] = []
    for article_no, num in section_refs:
        url = _justia_section_url(chapter_url, article_no, num)
        try:
            # Individual sections are much shorter than the chapter index —
            # a lower real-content threshold avoids waiting out the full
            # budget on every short (but genuinely fully-loaded) section.
            _goto_past_challenge(page, url, timeout_ms=30_000, min_content_chars=300)
            section_text = _page_text(page)
            if "page could not be found" in section_text.lower():
                continue  # gap in the numbering (e.g. a repealed section) — not an error
            parts.append(f"--- Government Code § {num} ---\n{section_text}")
        except Exception as e:
            logger.warning(f"    justia section {num} failed: {e}")
    return "\n\n".join(parts)


def _parse_justia_section_ranges(index_text: str, articles: tuple[int, ...]) -> list[tuple[int, str]]:
    """Extract every (article_no, section_num) inside the given article
    numbers' ranges, from lines like
    'ARTICLE 2 - Accessory Dwelling Unit Approvals 66314-66331'."""
    refs: list[tuple[int, str]] = []
    for m in re.finditer(r"ARTICLE\s+(\d+)[^\n]*?(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)", index_text):
        article_no, start_s, end_s = int(m.group(1)), m.group(2), m.group(3)
        if article_no not in articles:
            continue
        start, end = int(float(start_s)), int(float(end_s))
        refs.extend((article_no, str(n)) for n in range(start, end + 1))
        if "." in end_s and (article_no, end_s) not in refs:
            refs.append((article_no, end_s))  # the trailing .5 section itself (e.g. 66313.5)
    return refs


def _justia_section_url(chapter_url: str, article_no: int, section_num: str) -> str:
    # e.g. .../chapter-13/ -> .../chapter-13/article-1/section-66310/
    base = chapter_url.rstrip("/")
    return f"{base}/article-{article_no}/section-{section_num}/"


MIN_REAL_CONTENT_CHARS = 800


def _goto_past_challenge(page, url: str, timeout_ms: int = 60_000, min_content_chars: int = MIN_REAL_CONTENT_CHARS) -> None:
    """Navigate, then wait out a Cloudflare/WAF JS challenge ("Just a moment...")
    instead of waiting for networkidle — challenge pages keep background
    network activity alive and networkidle never fires while they're up.
    Raises ChallengeNotCleared if the challenge is still up (or the body never
    grows past a real-content-sized threshold) when the wait budget runs out —
    callers must not silently treat a stub "verifying you are human" page as
    real content."""
    page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
    deadline = timeout_ms
    step = 1_500
    while deadline > 0:
        title = (page.title() or "").lower()
        title_cleared = "just a moment" not in title and "checking your browser" not in title
        if title_cleared:
            try:
                body_len = page.evaluate("document.body ? document.body.innerText.length : 0")
            except Exception:
                body_len = 0
            if body_len >= min_content_chars:
                return
        page.wait_for_timeout(step)
        deadline -= step
    raise ChallengeNotCleared(f"{url}: still blocked after {timeout_ms}ms")


def _page_text(page) -> str:
    return page.evaluate(
        """() => {
            const selectors = [
                '#codes-content', '.code-text', '.section-content', '.code-viewer',
                'main', 'article', '#content', '.content', '#main-content', 'body'
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && el.innerText && el.innerText.trim().length > 400) {
                    return el.innerText.trim();
                }
            }
            return document.body.innerText.trim();
        }"""
    )


def _looks_relevant(text: str, search_terms: str) -> bool:
    hay = text.lower()
    return any(term in hay for term in search_terms.lower().split())


def _try_search(page, search_terms: str) -> bool:
    for sel in ['input[type="search"]', 'input[placeholder*="Search" i]', 'input[name*="search" i]']:
        box = page.query_selector(sel)
        if box:
            try:
                box.fill(search_terms)
                box.press("Enter")
                page.wait_for_load_state("networkidle", timeout=15_000)
                return True
            except Exception:
                continue
    return False


def _best_link(page, base_url: str, search_terms: str) -> str | None:
    from urllib.parse import urljoin

    keywords = search_terms.lower().split()
    best_score, best_url = 0, None
    for anchor in page.query_selector_all("a[href]"):
        href = anchor.get_attribute("href")
        if not href or href.startswith("#") or href.startswith("mailto:"):
            continue
        text = (anchor.inner_text() or "").lower()
        score = sum(1 for kw in keywords if kw in text)
        if score > best_score:
            best_score, best_url = score, urljoin(base_url, href)
    return best_url


def fetch_source(source: RefreshSource) -> str:
    raw = fetch_browser(source) if source.fetch_method == "browser" else fetch_httpx(source)
    text = re.sub(r"[ \t]+", " ", raw).strip()
    if len(text) < 200:
        raise ValueError(f"fetched text too short ({len(text)} chars) — likely blocked or empty page")
    return text


def extract_recency(source: RefreshSource, text: str) -> str | None:
    m = re.search(source.recency_pattern, text)
    return re.sub(r"\s+", " ", m.group(0)).strip() if m else None


# ---------------------------------------------------------------------------
# Write + diff
# ---------------------------------------------------------------------------


def raw_path(slug: str, key: str) -> Path:
    return CITIES_DIR / slug / "raw" / f"{key}.txt"


def git_show_head(path: Path) -> str | None:
    try:
        rel = path.relative_to(ROOT)
    except ValueError:
        return None
    result = subprocess.run(
        ["git", "show", f"HEAD:{rel.as_posix()}"], cwd=ROOT, capture_output=True, text=True
    )
    return result.stdout if result.returncode == 0 else None


def strip_header(text: str) -> str:
    """Drop our own '# fetched ... / # recency: ...' header before diffing content."""
    lines = text.splitlines()
    i = 0
    while i < len(lines) and lines[i].startswith("#"):
        i += 1
    return "\n".join(lines[i:]).strip()


def write_raw(city_slug: str, source: RefreshSource, text: str, recency: str | None) -> bool:
    """Write the raw file under the TARGET city (source.slug is just the
    registry grouping — "california" state sources get duplicated into every
    city that shares them, same convention already used by the hand-curated
    corpora, e.g. LA's meta.json listing state_adu_hcd.txt as a per-city raw
    file). Returns True if the CONTENT (not just the header) changed since the
    last committed version."""
    path = raw_path(city_slug, source.key)
    path.parent.mkdir(parents=True, exist_ok=True)

    previous = git_show_head(path)
    changed = previous is None or strip_header(previous) != text.strip()

    fetched_at = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    header = [
        f"# source: {source.title}",
        f"# citation: {source.citation_url}",
        f"# fetched: {fetched_at}",
    ]
    if recency:
        header.append(f"# recency: {recency}")
    path.write_text("\n".join(header) + "\n\n" + text.strip() + "\n", encoding="utf-8")
    return changed


# ---------------------------------------------------------------------------
# meta.json
# ---------------------------------------------------------------------------


def load_meta(slug: str) -> dict[str, Any]:
    path = CITIES_DIR / slug / "meta.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"slug": slug, "sources": [], "rawSources": {}}


def save_meta(slug: str, meta: dict[str, Any]) -> None:
    path = CITIES_DIR / slug / "meta.json"
    path.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def ensure_source_id(meta: dict[str, Any], source: RefreshSource) -> str:
    """Reuse the sourceId already mapped to this raw filename, else mint the
    next S{n}."""
    filename = f"{source.key}.txt"
    raw_sources: dict[str, str] = meta.setdefault("rawSources", {})
    if filename in raw_sources:
        return raw_sources[filename]

    existing_ids = {s["id"] for s in meta.get("sources", [])}
    n = 1
    while f"S{n}" in existing_ids:
        n += 1
    new_id = f"S{n}"
    raw_sources[filename] = new_id
    meta.setdefault("sources", []).append(
        {"id": new_id, "url": source.citation_url, "title": source.title}
    )
    return new_id


# ---------------------------------------------------------------------------
# Rule-candidate extraction (OpenAI)
# ---------------------------------------------------------------------------


def relevant_rule_keys(text: str) -> list[str]:
    hay = text.lower()
    return [key for key, terms in RULE_TERMS.items() if any(t in hay for t in terms)]


def load_rules(slug: str) -> list[dict[str, Any]]:
    path = CITIES_DIR / slug / "rules.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    # Alameda has no rules.json of its own yet — it runs on the TS built-in
    # fallback (src/lib/fixtures.ts RULES). Seed it from that same fixture so
    # automated refreshes have a real per-city file to update going forward.
    if slug == "alameda-ca":
        return _seed_alameda_rules()
    return []


def _seed_alameda_rules() -> list[dict[str, Any]]:
    return [
        {"key": "maxSize", "label": "Maximum unit size", "appliesTo": "detached_adu", "operator": "<=", "threshold": 1200, "unit": "sqft", "sourceId": "S1", "description": "Detached ADU conditioned floor area must not exceed 1,200 sq ft."},
        {"key": "height", "label": "Height limit (attached ADU)", "appliesTo": "attached_adu", "operator": "<=", "threshold": 16, "unit": "ft", "sourceId": "S2", "description": "Attached ADU height limited to 16 ft to match the primary dwelling."},
        {"key": "height", "label": "Height limit (detached ADU)", "appliesTo": "detached_adu", "operator": "<=", "threshold": 18, "unit": "ft", "sourceId": "S2", "description": "Detached ADU may be up to 18 ft in height."},
        {"key": "setbackRear", "label": "Rear setback", "appliesTo": "any", "operator": ">=", "threshold": 4, "unit": "ft", "sourceId": "S3", "description": "Minimum 4 ft rear setback for an ADU."},
        {"key": "setbackSide", "label": "Side setback", "appliesTo": "any", "operator": ">=", "threshold": 4, "unit": "ft", "sourceId": "S3", "description": "Minimum 4 ft side setback for an ADU."},
    ]


def save_rules(slug: str, rules: list[dict[str, Any]]) -> None:
    path = CITIES_DIR / slug / "rules.json"
    path.write_text(json.dumps(rules, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


RULE_CANDIDATE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "candidates": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "key": {"type": "string", "enum": KNOWN_RULE_KEYS},
                    "appliesTo": {"type": "string"},
                    "operator": {"type": "string", "enum": ["<=", ">=", "present"]},
                    "threshold": {"type": ["number", "null"]},
                    "unit": {"type": "string", "enum": KNOWN_UNITS},
                    "description": {"type": "string"},
                    "quote": {"type": "string"},
                    "confidence": {"type": "number"},
                    "changed": {"type": "boolean"},
                },
                "required": ["key", "appliesTo", "operator", "threshold", "unit", "description", "quote", "confidence", "changed"],
            },
        }
    },
    "required": ["candidates"],
}


def propose_rule_candidates(text: str, existing_rules: list[dict[str, Any]], project_types: list[str]) -> list[dict[str, Any]]:
    from openai import OpenAI

    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    model = os.getenv("OPENAI_MODEL", "gpt-5-mini")
    existing_summary = "\n".join(
        f"- {r['key']} ({r.get('appliesTo')}): {r['operator']} {r['threshold']}{r.get('unit') or ''} — {r.get('description','')}"
        for r in existing_rules
    ) or "(none on file yet)"

    prompt = (
        "You are a municipal code analyst. Below is freshly fetched official code/statute text, "
        f"and the compliance rules currently on file for project types {project_types}. "
        "For each NUMERIC threshold this text states for maxSize/height/setbackFront/setbackRear/"
        "setbackSide/lotCoverage/far/parking, emit a candidate. Set changed=true ONLY if it "
        "contradicts an existing rule below (different threshold/operator/unit) — set changed=false "
        "if it just confirms an existing rule or states a brand-new one not yet on file. "
        "Quote the EXACT source sentence in `quote`. Set confidence 0..1 honestly: 1.0 only for an "
        "unambiguous, explicitly stated numeric limit; lower for anything inferred, conditional, or "
        "ambiguous between project types. Never invent a threshold that isn't stated. "
        f"appliesTo must be one of: detached_adu, attached_adu, single_family, multi_family, any.\n\n"
        f"EXISTING RULES:\n{existing_summary}\n\n"
        f"FETCHED TEXT:\n{text[:24000]}"
    )

    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        max_completion_tokens=4000,
        response_format={"type": "json_schema", "json_schema": {"name": "candidates", "strict": True, "schema": RULE_CANDIDATE_SCHEMA}},
    )
    text_out = resp.choices[0].message.content
    if not text_out:
        return []
    return json.loads(text_out).get("candidates", [])


def apply_rule_candidates(slug: str, source: RefreshSource, source_id: str, candidates: list[dict[str, Any]]) -> tuple[int, int]:
    """Return (auto_applied, pending)."""
    changed = [c for c in candidates if c.get("changed")]
    if not changed:
        return 0, 0

    rules = load_rules(slug)
    auto, pending = [], []
    for c in changed:
        (auto if c["confidence"] >= CONFIDENCE_AUTO_APPLY else pending).append(c)

    for c in auto:
        rules = [r for r in rules if not (r["key"] == c["key"] and r.get("appliesTo") == c["appliesTo"])]
        rules.append(
            {
                "key": c["key"],
                "label": c["description"][:60],
                "appliesTo": c["appliesTo"],
                "operator": c["operator"],
                "threshold": c["threshold"],
                "unit": c["unit"],
                "sourceId": source_id,
                "description": c["description"],
            }
        )
    if auto:
        save_rules(slug, rules)

    if pending:
        pending_path = CITIES_DIR / slug / "pending-rule-changes.json"
        existing_pending = json.loads(pending_path.read_text(encoding="utf-8")) if pending_path.exists() else []
        for c in pending:
            existing_pending.append({**c, "sourceId": source_id, "sourceTitle": source.title, "detectedAt": datetime.now(timezone.utc).strftime("%Y-%m-%d")})
        pending_path.write_text(json.dumps(existing_pending, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    return len(auto), len(pending)


# ---------------------------------------------------------------------------
# Changelog
# ---------------------------------------------------------------------------


def append_changelog(slug: str, entries: list[str]) -> None:
    if not entries:
        return
    path = CITIES_DIR / slug / "CHANGELOG.md"
    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    block = f"## {date}\n\n" + "\n".join(f"- {e}" for e in entries) + "\n\n"
    prior = path.read_text(encoding="utf-8") if path.exists() else "# Corpus refresh changelog\n\n"
    path.write_text(prior + block, encoding="utf-8")


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def refresh_city(slug: str, dry_run: bool = False) -> None:
    logger.info(f"=== {slug} ===")
    meta = load_meta(slug)
    changelog: list[str] = []
    any_changed = False

    for source in sources_for_city(slug):
        try:
            text = fetch_source(source)
        except Exception as e:
            logger.warning(f"  [{source.key}] FETCH FAILED: {e}")
            changelog.append(f"**{source.title}**: fetch failed ({e}) — kept previous text")
            continue

        recency = extract_recency(source, text)
        source_id = ensure_source_id(meta, source)

        if dry_run:
            changed = git_show_head(raw_path(slug, source.key)) is None or strip_header(
                git_show_head(raw_path(slug, source.key)) or ""
            ) != text
            logger.info(f"  [{source.key}] dry-run: would {'CHANGE' if changed else 'leave unchanged'} (recency: {recency})")
            continue

        changed = write_raw(slug, source, text, recency)
        logger.info(f"  [{source.key}] fetched {len(text)} chars via {source.fetch_method}, recency={recency!r}, changed={changed}")

        if not changed:
            continue
        any_changed = True
        changelog.append(f"**{source.title}** — recency marker now: {recency or '(none detected)'}")

        keys = relevant_rule_keys(text)
        if keys and os.getenv("OPENAI_API_KEY"):
            try:
                existing = [r for r in load_rules(slug) if r["key"] in keys]
                candidates = propose_rule_candidates(text, existing, meta.get("projectTypes", ["detached_adu"]))
                auto_n, pending_n = apply_rule_candidates(slug, source, source_id, candidates)
                if auto_n:
                    changelog.append(f"  -> auto-applied {auto_n} rule change(s) to rules.json (confidence >= {CONFIDENCE_AUTO_APPLY})")
                if pending_n:
                    changelog.append(f"  -> {pending_n} lower-confidence rule change(s) written to pending-rule-changes.json for review")
            except Exception as e:
                logger.warning(f"  [{source.key}] rule-candidate extraction failed: {e}")
                changelog.append(f"  -> rule-candidate extraction failed: {e}")

    if dry_run:
        return

    save_meta(slug, meta)

    if any_changed:
        n = chunk_codes.chunk_city(slug)
        changelog.append(f"Regenerated chunks.json ({n} chunks).")
    else:
        logger.info("  no source changed — chunks.json left as-is")

    append_changelog(slug, changelog)
    logger.info(f"  done. {len(changelog)} changelog entrie(s).")


def main() -> None:
    parser = argparse.ArgumentParser(description="Refresh a city's code corpus from live official sources")
    parser.add_argument("--slug", help="one city slug (e.g. los-angeles-ca)")
    parser.add_argument("--all", action="store_true", help="refresh every registered city")
    parser.add_argument("--dry-run", action="store_true", help="fetch + report changes without writing")
    args = parser.parse_args()

    _load_env()
    if not os.getenv("BROWSERBASE_API_KEY") or not os.getenv("BROWSERBASE_PROJECT_ID"):
        parser.error("BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID must be set (needed for WAF-protected sources)")

    from firstpass.corpus_sources import all_city_slugs

    if args.all:
        slugs = all_city_slugs()
    elif args.slug:
        slugs = [args.slug]
    else:
        parser.error("pass --slug <city> or --all")

    for slug in slugs:
        refresh_city(slug, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
