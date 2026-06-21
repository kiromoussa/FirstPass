"""Browserbase web research for design fixes to code violations."""

from __future__ import annotations

import json
import os
import re
from urllib.parse import quote_plus, urljoin, urlparse

from browserbase import Browserbase
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright
from pydantic import BaseModel, Field

from firstpass.browserbase_tool import (
    TEXT_LIMIT,
    _clean_text,
    _host,
    _load_page,
    _normalize_url,
)
from firstpass.code_sources import HCD_ADU_URLS, LA_MUNICIPAL_URLS, OAKLAND_MUNICIPAL_URLS, TRUSTED_HOSTS

SOLUTION_FIX_KEYWORDS: list[str] = [
    "accessory dwelling",
    "adu",
    "setback",
    "variance",
    "exception",
    "comply",
    "compliance",
    "design solution",
    "modify",
    "reduce",
    "relocate",
    "encroach",
    "minimum",
    "feet",
    "height",
    "lot coverage",
    "parking",
    "ministerial",
    "workaround",
    "alternative",
    "remedy",
    "correction",
    "fix",
]

# Broader than code-only hosts — still excludes obvious junk domains
TRUSTED_SOLUTION_HOSTS: tuple[str, ...] = TRUSTED_HOSTS + (
    "wikipedia.org",
    "energy.ca.gov",
    "ca.gov",
    "nolo.com",
    "buildzoom.com",
)


def _is_trusted_solution_url(url: str) -> bool:
    host = _host(url)
    if not host or host.endswith((".ru", ".cn")):
        return False
    if any(trusted in host for trusted in TRUSTED_SOLUTION_HOSTS):
        return True
    # Allow official .gov / .edu result pages from search
    return host.endswith(".gov") or host.endswith(".edu")


def _extract_fix_snippets(text: str, violation_terms: list[str]) -> list[str]:
    """Pull sentences that mention fixes or the violation topic."""
    sentences = re.split(r"(?<=[.!?])\s+", text)
    snippets: list[str] = []
    seen: set[str] = set()
    violation_lower = [t.lower() for t in violation_terms if t]

    for sentence in sentences:
        s = _clean_text(sentence, 280)
        if len(s) < 40:
            continue
        lower = s.lower()
        has_fix = any(kw in lower for kw in SOLUTION_FIX_KEYWORDS)
        has_violation = any(term in lower for term in violation_lower) if violation_lower else True
        if has_fix and has_violation and s not in seen:
            seen.add(s)
            snippets.append(s)
        if len(snippets) >= 8:
            break
    return snippets


def _extract_ddg_result_links(page, limit: int = 6) -> list[str]:
    links: list[str] = []
    seen: set[str] = set()
    for anchor in page.query_selector_all("a.result__a, a.result-link, a[href^='http']"):
        href = anchor.get_attribute("href")
        if not href or href.startswith("mailto:"):
            continue
        absolute = _normalize_url(urljoin(page.url, href))
        if "duckduckgo.com" in absolute:
            continue
        if not _is_trusted_solution_url(absolute):
            continue
        if absolute in seen:
            continue
        seen.add(absolute)
        links.append(absolute)
        if len(links) >= limit:
            break
    return links


def _find_fix_related_links(page, base_url: str, search_query: str | None, limit: int = 6) -> list[str]:
    keywords = list(SOLUTION_FIX_KEYWORDS)
    if search_query:
        keywords.extend(search_query.lower().split())

    start_host = _host(base_url)
    links: list[tuple[int, str]] = []

    for anchor in page.query_selector_all("a[href]"):
        href = anchor.get_attribute("href")
        if not href or href.startswith("#") or href.startswith("mailto:"):
            continue
        absolute = urljoin(base_url, href)
        if not _is_trusted_solution_url(absolute):
            continue
        link_host = _host(absolute)
        text = (anchor.inner_text() or "").lower()
        path = absolute.lower()
        score = sum(1 for kw in keywords if kw in text or kw in path)
        if link_host == start_host:
            score += 2
        if any(h in link_host for h in ("hcd.ca.gov", "lacity.gov", "ladbs", "municode", "oaklandca.gov")):
            score += 2
        if score > 0:
            links.append((score, _normalize_url(absolute)))

    links.sort(key=lambda item: item[0], reverse=True)
    seen: set[str] = set()
    result: list[str] = []
    for _, url in links:
        if url in seen:
            continue
        seen.add(url)
        result.append(url)
        if len(result) >= limit:
            break
    return result


def _jurisdiction_seeds(jurisdiction: str) -> list[str]:
    lower = jurisdiction.lower()
    if "los angeles" in lower or " la " in f" {lower} ":
        return list(LA_MUNICIPAL_URLS[:2]) + [HCD_ADU_URLS[0]]
    if "oakland" in lower:
        return list(OAKLAND_MUNICIPAL_URLS[:2]) + [HCD_ADU_URLS[0]]
    return [HCD_ADU_URLS[0]]


def _build_search_query(
    violation_summary: str,
    code_citation: str,
    jurisdiction: str,
    project_type: str,
    search_query: str | None,
) -> str:
    if search_query:
        return search_query.strip()
    parts = [
        jurisdiction,
        project_type,
        violation_summary,
        code_citation,
        "design fix comply ADU",
    ]
    return " ".join(p for p in parts if p)


def _violation_terms(violation_summary: str, code_citation: str) -> list[str]:
    terms = [code_citation]
    for token in re.findall(r"[a-zA-Z]{4,}", violation_summary):
        terms.append(token)
    return terms[:12]


class SolutionFixResearchInput(BaseModel):
    """Browse the web via Browserbase to find design fixes for a code violation."""

    violation_summary: str = Field(
        ...,
        description=(
            "The compliance gap from plan_vs_code.txt, e.g. "
            "'Rear setback 3 ft vs required 4 ft minimum (FAIL)'"
        ),
    )
    code_citation: str = Field(
        ...,
        description="Governing code section cited in the comparison, e.g. 'LAMC 12.03' or 'Gov Code 65852.2'",
    )
    jurisdiction: str = Field(
        default="Los Angeles, CA",
        description="City and state from the project kickoff",
    )
    project_type: str = Field(default="Detached ADU", description="Project type from kickoff")
    search_query: str | None = Field(
        default=None,
        description="Optional custom web search query; auto-built from violation if omitted",
    )
    max_pages: int = Field(default=4, ge=1, le=6, description="Maximum pages to visit in this session")


def solution_fix_research(input: SolutionFixResearchInput) -> str:
    """Search the web with Browserbase for design fixes to a specific code violation."""
    api_key = os.environ.get("BROWSERBASE_API_KEY")
    if not api_key:
        return json.dumps({"error": "BROWSERBASE_API_KEY is not set"})

    query = _build_search_query(
        input.violation_summary,
        input.code_citation,
        input.jurisdiction,
        input.project_type,
        input.search_query,
    )
    violation_terms = _violation_terms(input.violation_summary, input.code_citation)

    project_id = os.environ.get("BROWSERBASE_PROJECT_ID")
    bb = Browserbase(api_key=api_key)
    create_params: dict = {
        "browser_settings": {
            "blockAds": True,
            "recordSession": True,
            "logSession": True,
            "solveCaptchas": True,
        },
    }
    if project_id:
        create_params["project_id"] = project_id

    session = bb.sessions.create(**create_params)
    session_url = f"https://browserbase.com/sessions/{session.id}"

    pages_visited: list[dict] = []
    errors: list[str] = []
    visited: set[str] = set()
    search_url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"

    urls_to_visit: list[str] = [_jurisdiction_seeds(input.jurisdiction)[0], search_url]
    for seed in _jurisdiction_seeds(input.jurisdiction):
        if seed not in urls_to_visit:
            urls_to_visit.append(seed)

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(session.connect_url)
            page = browser.contexts[0].pages[0]

            for url in urls_to_visit:
                if len(pages_visited) >= input.max_pages:
                    break
                if url in visited:
                    continue
                try:
                    record = _load_page(page, url)
                    if record["url"] in visited:
                        continue
                    visited.add(record["url"])
                    record["fix_snippets"] = _extract_fix_snippets(record["text"], violation_terms)
                    pages_visited.append(record)

                    if "duckduckgo.com" in record["url"]:
                        for link in _extract_ddg_result_links(page):
                            if link not in urls_to_visit:
                                urls_to_visit.append(link)
                    else:
                        for link in _find_fix_related_links(page, page.url, query):
                            if link not in urls_to_visit:
                                urls_to_visit.append(link)
                except PlaywrightTimeoutError:
                    errors.append(f"Timeout loading {url}")
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"Failed to load {url}: {exc}")

            for url in urls_to_visit:
                if len(pages_visited) >= input.max_pages:
                    break
                if url in visited:
                    continue
                try:
                    record = _load_page(page, url)
                    if record["url"] in visited:
                        continue
                    visited.add(record["url"])
                    record["fix_snippets"] = _extract_fix_snippets(record["text"], violation_terms)
                    pages_visited.append(record)
                except PlaywrightTimeoutError:
                    errors.append(f"Timeout loading {url}")
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"Failed to load {url}: {exc}")

            browser.close()
    except Exception as exc:  # noqa: BLE001
        errors.append(f"Browserbase session error: {exc}")

    all_snippets: list[str] = []
    for page_record in pages_visited:
        for snippet in page_record.get("fix_snippets", []):
            if snippet not in all_snippets:
                all_snippets.append(snippet)

    return json.dumps(
        {
            "violation_summary": input.violation_summary,
            "code_citation": input.code_citation,
            "search_query_used": query,
            "session_recording_url": session_url,
            "pages": [
                {
                    "url": p["url"],
                    "title": p.get("title", ""),
                    "fix_snippets": p.get("fix_snippets", []),
                    "text_excerpt": p.get("text", "")[:TEXT_LIMIT],
                }
                for p in pages_visited
            ],
            "aggregated_fix_ideas": all_snippets[:10],
            "errors": errors,
            "instruction": (
                "Use fix_snippets and aggregated_fix_ideas to propose concrete design changes "
                "(dimensions, sheet edits, relocations). Cite page URLs. Include session_recording_url "
                "in solutions_report.txt. Prefer official .gov / HCD / LADBS sources when available."
            ),
        },
        indent=2,
    )


SOLUTION_RESEARCH_TOOLS = [(SolutionFixResearchInput, solution_fix_research)]
