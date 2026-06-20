"""Browserbase-powered web research for building codes (ICC, DGS, Municode, .gov)."""

from __future__ import annotations

import json
import os
import re
from typing import Literal
from urllib.parse import urljoin, urlparse

from browserbase import Browserbase
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright
from pydantic import BaseModel, Field

from firstpass.code_sources import (
    CODE_LINK_KEYWORDS,
    SEED_URLS,
    SourceHint,
    is_trusted_code_url,
    seeds_for_hint,
)

SourceHintField = Literal["auto", "municipal", "state", "icc", "dgs", "hcd"]

TEXT_LIMIT = 15_000
NAV_TIMEOUT_MS = 75_000


class BrowserbaseResearchInput(BaseModel):
    """Browse building-code sources via Browserbase (ICC, DGS, Municode, city/state .gov)."""

    research_goal: str = Field(
        ...,
        description="What to find (e.g. ADU setback requirements, CBC section for detached ADU)",
    )
    start_url: str = Field(
        ...,
        description=(
            "URL to begin: ICC Digital Codes (codes.iccsafe.org), DGS BSC (dgs.ca.gov/BSC), "
            "Municode, HCD, or city planning .gov page"
        ),
    )
    search_query: str | None = Field(
        default=None,
        description="Keywords to score follow-up links and on-page search (e.g. 'ADU setback 30-5.18')",
    )
    source_hint: SourceHintField = Field(
        default="auto",
        description="Source type: municipal, state, icc, dgs, hcd, or auto",
    )
    max_pages: int = Field(default=4, ge=1, le=6, description="Maximum pages to visit per session")
    include_seed_urls: bool = Field(
        default=False,
        description="Also visit curated seed URLs for this source type (useful for Alameda/CA demo)",
    )


def _clean_text(text: str, limit: int = TEXT_LIMIT) -> str:
    collapsed = re.sub(r"\s+", " ", text).strip()
    return collapsed[:limit]


def _host(url: str) -> str:
    return urlparse(url).netloc.lower()


def _normalize_url(url: str) -> str:
    parsed = urlparse(url)
    return parsed._replace(fragment="").geturl().rstrip("/")


def _extract_page_text(page) -> str:
    return _clean_text(
        page.evaluate(
            """() => {
                const selectors = [
                    '#codes-content', '#section-detail', '.code-text', '.section-content',
                    '.code-viewer', '[data-testid="code-content"]', '.MuiContainer-root main',
                    'main', 'article', '#content', '.content', '#main-content', '.page-content',
                    'body'
                ];
                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (el && el.innerText && el.innerText.trim().length > 200) {
                        return el.innerText.trim();
                    }
                }
                return document.body.innerText.trim();
            }"""
        )
    )


def _extract_code_snippets(text: str) -> list[str]:
    patterns = [
        r"(?:§|Section|SEC\.?)\s*[\d]+(?:[.\-]\d+)+[^\n.]{0,200}",
        r"\b(?:GOV|HSC|CBC|CRC|CCR)\s*(?:§|Section)?\s*[\d.]+[^\n.]{0,150}",
        r"\b\d{1,2}-\d+\.\d+[^\n.]{0,150}",
        r"\b65852(?:\.\d+)?[^\n.]{0,150}",
        r"(?:accessory dwelling unit|ADU)[^.]{0,180}\.",
    ]
    snippets: list[str] = []
    seen: set[str] = set()
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            snippet = _clean_text(match.group(), 220)
            if snippet not in seen and len(snippet) > 20:
                seen.add(snippet)
                snippets.append(snippet)
            if len(snippets) >= 12:
                return snippets
    return snippets


def _page_is_stale_redirect(title: str, text: str) -> bool:
    combined = f"{title} {text[:500]}".lower()
    return "has moved" in combined or "page not found" in combined or "404" in title.lower()


def _find_relevant_links(page, base_url: str, search_query: str | None, limit: int = 8) -> list[str]:
    keywords = list(CODE_LINK_KEYWORDS)
    if search_query:
        keywords.extend(search_query.lower().split())

    start_host = _host(base_url)
    links: list[tuple[int, str]] = []

    for anchor in page.query_selector_all("a[href]"):
        href = anchor.get_attribute("href")
        if not href or href.startswith("#") or href.startswith("mailto:"):
            continue
        absolute = urljoin(base_url, href)
        if not is_trusted_code_url(absolute):
            continue
        link_host = _host(absolute)
        text = (anchor.inner_text() or "").lower()
        path = absolute.lower()
        score = sum(1 for kw in keywords if kw in text or kw in path)
        # Prefer same-site and code-heavy hosts
        if link_host == start_host:
            score += 2
        if any(h in link_host for h in ("iccsafe", "municode", "dgs.ca.gov", "hcd.ca.gov")):
            score += 1
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


def _try_site_search(page, search_query: str | None) -> None:
    """Attempt on-page search boxes (ICC, Municode, DGS)."""
    if not search_query:
        return
    selectors = [
        'input[type="search"]',
        'input[placeholder*="Search" i]',
        'input[name*="search" i]',
        "#search-input",
        'input[aria-label*="search" i]',
    ]
    for sel in selectors:
        el = page.query_selector(sel)
        if not el:
            continue
        try:
            el.fill(search_query.split()[0] if search_query else "")
            el.press("Enter")
            page.wait_for_timeout(3000)
            return
        except Exception:  # noqa: BLE001
            continue


def _load_page(page, url: str) -> dict:
    page.goto(url, wait_until="networkidle", timeout=NAV_TIMEOUT_MS)
    # Municode and ICC are JS-heavy — allow extra render time
    if "municode" in url or "iccsafe" in url:
        page.wait_for_timeout(4000)
    else:
        page.wait_for_timeout(1500)

    if "municode" in url:
        try:
            page.wait_for_selector(
                "#codesContent, .codes-content, .docViewer, .Section, [class*='code']",
                timeout=10000,
            )
        except PlaywrightTimeoutError:
            pass

    page.evaluate("window.scrollTo(0, document.body.scrollHeight / 3)")
    page.wait_for_timeout(800)
    page.evaluate("window.scrollTo(0, document.body.scrollHeight * 0.66)")
    page.wait_for_timeout(800)

    title = page.title()
    text = _extract_page_text(page)
    final_url = _normalize_url(page.url)

    return {
        "url": final_url,
        "title": title,
        "text": text,
        "code_snippets": _extract_code_snippets(text),
        "stale_redirect": _page_is_stale_redirect(title, text),
    }


def _build_url_queue(input: BrowserbaseResearchInput) -> list[str]:
    queue: list[str] = [_normalize_url(input.start_url)]

    if input.include_seed_urls:
        for seed in seeds_for_hint(input.source_hint):  # type: ignore[arg-type]
            normalized = _normalize_url(seed)
            if normalized not in queue:
                queue.append(normalized)

    # Suggest known seeds when start URL looks like a generic/stale path
    if "Planning-Building" in input.start_url and "Transportation" not in input.start_url:
        for entry in SEED_URLS.get("alameda", []):
            url = _normalize_url(entry["url"])
            if url not in queue:
                queue.append(url)

    return queue


def browserbase_research(input: BrowserbaseResearchInput) -> str:
    """Create a Browserbase session, scrape code sources, return structured findings."""
    api_key = os.environ.get("BROWSERBASE_API_KEY")
    if not api_key:
        return json.dumps({"error": "BROWSERBASE_API_KEY is not set"})

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

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(session.connect_url)
            page = browser.contexts[0].pages[0]

            urls_to_visit = _build_url_queue(input)

            # Load first page and discover links
            if urls_to_visit:
                first = urls_to_visit[0]
                try:
                    record = _load_page(page, first)
                    visited.add(record["url"])
                    pages_visited.append(record)

                    if record.get("stale_redirect"):
                        errors.append(f"Start URL appears stale/moved: {first}")

                    if input.search_query and "iccsafe" in record["url"]:
                        _try_site_search(page, input.search_query)
                        search_record = _load_page(page, page.url)
                        if search_record["url"] not in visited:
                            visited.add(search_record["url"])
                            pages_visited.append(search_record)

                    related = _find_relevant_links(page, page.url, input.search_query)
                    for link in related:
                        if link not in urls_to_visit:
                            urls_to_visit.append(link)
                except PlaywrightTimeoutError:
                    errors.append(f"Timeout loading {first}")
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"Failed to load {first}: {exc}")

            for url in urls_to_visit[1:]:
                if len(pages_visited) >= input.max_pages:
                    break
                if url in visited:
                    continue
                try:
                    record = _load_page(page, url)
                    if record["url"] in visited:
                        continue
                    visited.add(record["url"])
                    pages_visited.append(record)
                except PlaywrightTimeoutError:
                    errors.append(f"Timeout loading {url}")
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"Failed to load {url}: {exc}")

            browser.close()
    except Exception as exc:  # noqa: BLE001
        errors.append(f"Browserbase session error: {exc}")

    source_labels = {
        "icc": "ICC Digital Codes (California Title 24 / I-Codes)",
        "dgs": "California DGS Building Standards Commission",
        "hcd": "California HCD ADU guidance",
        "municipal": "Municipal ordinance / city permit sources",
        "state": "State building standards and ADU law",
    }

    return json.dumps(
        {
            "research_goal": input.research_goal,
            "source_hint": input.source_hint,
            "session_recording_url": session_url,
            "pages": pages_visited,
            "errors": errors,
            "trusted_sources_note": (
                "Cite URLs from pages visited. Accept ICC Digital Codes, DGS BSC, HCD, Municode, "
                "and official .gov sources as authoritative for building code research."
            ),
            "recommended_sources": source_labels,
            "instruction": (
                "Extract code section numbers, ordinance IDs, and excerpts from page text and "
                "code_snippets. For ICC/DGS cite Title 24 part and section. For municipal cite "
                "Municode section (e.g. 30-5.18). Note if ICC content appears paywalled/truncated."
            ),
        },
        indent=2,
    )


BROWSERBASE_TOOLS = [(BrowserbaseResearchInput, browserbase_research)]
