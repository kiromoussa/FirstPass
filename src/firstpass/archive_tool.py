"""Scrape building codes from Internet Archive via Browserbase + OCR text files."""

from __future__ import annotations

import asyncio
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote_plus, urlparse

import httpx
from browserbase import Browserbase
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright
from pydantic import BaseModel, Field

from firstpass.code_sources import ARCHIVE_ITEMS, OAKLAND_MUNICIPAL_URLS, search_archive_text
from firstpass.report_tool import MergeResearchReportsInput, WriteTextReportInput, merge_research_reports, write_text_report

TEXT_LIMIT = 20_000
SUMMARY_LIMIT = 1_500
NAV_TIMEOUT_MS = 90_000


class ArchiveCodeScrapeInput(BaseModel):
    """Scrape building code text from Internet Archive (archive.org)."""

    research_goal: str = Field(..., description="What code sections to find (e.g. ADU requirements for Oakland)")
    search_terms: str = Field(
        default="accessory dwelling unit ADU",
        description="Terms to search for within archived code documents",
    )
    archive_item_id: str | None = Field(
        default=None,
        description="Internet Archive identifier, e.g. gov.ca.bsc.residential.2025",
    )
    archive_url: str | None = Field(
        default=None,
        description="Full archive.org URL (details or search page)",
    )
    jurisdiction: str = Field(default="Oakland, CA", description="City/state context for this scrape")
    use_browserbase: bool = Field(
        default=True,
        description="If false, only fetch Internet Archive OCR text (faster, no Browserbase session)",
    )
    auto_write_report: bool = Field(
        default=True,
        description="Write full report to output/ automatically (saves a Claude tool turn)",
    )
    report_filename: str | None = Field(
        default=None,
        description="Output filename when auto_write_report is true, e.g. municipal_codes.txt",
    )
    report_type: str = Field(
        default="research",
        description="Report type for auto-write: municipal, state, or final_summary",
    )
    address: str | None = Field(
        default=None,
        description="Project address (for auto-merge into final_summary.txt)",
    )
    project_type: str = Field(
        default="Detached ADU",
        description="Project type (for auto-merge into final_summary.txt)",
    )


def _extract_identifier(archive_url: str | None, item_id: str | None) -> str | None:
    if item_id:
        return item_id.strip()
    if not archive_url:
        return None
    parsed = urlparse(archive_url)
    path = parsed.path.strip("/")
    parts = path.split("/")
    if "search" in parts:
        return None
    if "details" in parts:
        idx = parts.index("details")
        if idx + 1 < len(parts):
            return parts[idx + 1]
    if "download" in parts:
        idx = parts.index("download")
        if idx + 1 < len(parts):
            return parts[idx + 1]
    return parts[-1] if parts and parts[-1] not in {"search", "details", "download"} else None


def _search_archive_items(query: str, max_results: int = 3) -> list[dict]:
    """Find archive.org items via the public search API."""
    url = "https://archive.org/advancedsearch.php"
    params = {
        "q": query,
        "fl[]": ["identifier", "title"],
        "output": "json",
        "rows": max_results,
    }
    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.get(url, params=params)
            response.raise_for_status()
            docs = response.json().get("response", {}).get("docs", [])
            return [{"id": d["identifier"], "title": d.get("title", d["identifier"])} for d in docs]
    except Exception:  # noqa: BLE001
        return []


def _fetch_web_page_text(url: str) -> str | None:
    """Fetch visible text from a public web page (fallback when IA has no municipal code)."""
    try:
        with httpx.Client(timeout=45.0, follow_redirects=True) as client:
            response = client.get(url, headers={"User-Agent": "FirstPass/0.1 (research bot)"})
            if response.status_code != 200:
                return None
            html = response.text
            text = re.sub(r"(?is)<script.*?>.*?</script>", " ", html)
            text = re.sub(r"(?is)<style.*?>.*?</style>", " ", text)
            text = re.sub(r"<[^>]+>", " ", text)
            text = re.sub(r"\s+", " ", text).strip()
            return text[:TEXT_LIMIT] if len(text) > 200 else None
    except Exception:  # noqa: BLE001
        return None


def _fetch_djvu_text(item_id: str) -> tuple[str | None, str | None]:
    """Download OCR plain text from Internet Archive (fast, no paywall)."""
    url = f"https://archive.org/download/{item_id}/{item_id}_djvu.txt"
    try:
        with httpx.Client(timeout=120.0, follow_redirects=True) as client:
            response = client.get(url)
            if response.status_code == 200 and len(response.text) > 500:
                return response.text, url
    except Exception as exc:  # noqa: BLE001
        return None, f"djvu fetch failed: {exc}"
    return None, None


def _browserbase_archive_context(
    api_key: str,
    project_id: str | None,
    url: str,
    search_terms: str,
) -> tuple[str | None, str, list[str]]:
    """Use Browserbase to open archive.org and capture visible page context."""
    bb = Browserbase(api_key=api_key)
    create_params: dict = {
        "browser_settings": {"blockAds": True, "recordSession": True, "solveCaptchas": True},
    }
    if project_id:
        create_params["project_id"] = project_id

    session = bb.sessions.create(**create_params)
    session_url = f"https://browserbase.com/sessions/{session.id}"
    errors: list[str] = []
    page_text = ""

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(session.connect_url)
            page = browser.contexts[0].pages[0]
            page.goto(url, wait_until="networkidle", timeout=NAV_TIMEOUT_MS)
            page.wait_for_timeout(2000)

            if "details" in url:
                try:
                    read_btn = page.get_by_role("link", name=re.compile("read|borrow|viewer", re.I))
                    if read_btn.count() > 0:
                        read_btn.first.click(timeout=8000)
                        page.wait_for_timeout(4000)
                except Exception:  # noqa: BLE001
                    pass

            search_input = page.query_selector(
                'input[type="search"], input[placeholder*="Search" i], .BRsearch input'
            )
            if search_input and search_terms:
                try:
                    term = search_terms.split()[0]
                    search_input.fill(term)
                    search_input.press("Enter")
                    page.wait_for_timeout(3000)
                except Exception:  # noqa: BLE001
                    pass

            page_text = page.evaluate(
                """() => {
                    const layers = document.querySelectorAll('.BRtextlayer, .BRpagecontainer, main, #maincontent');
                    let best = '';
                    for (const el of layers) {
                        const t = (el.innerText || '').trim();
                        if (t.length > best.length) best = t;
                    }
                    return best || document.body.innerText.trim();
                }"""
            )[:TEXT_LIMIT]
            browser.close()
    except PlaywrightTimeoutError:
        errors.append(f"Timeout loading {url}")
    except Exception as exc:  # noqa: BLE001
        errors.append(f"Browserbase error: {exc}")

    return session_url, page_text, errors


def _run_sync_in_thread(fn, *args, **kwargs):
    """Run sync Playwright safely when Band's asyncio loop is active."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return fn(*args, **kwargs)

    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(fn, *args, **kwargs).result()


def _try_auto_merge(input: ArchiveCodeScrapeInput) -> str | None:
    """Merge municipal + state reports when both files exist."""
    if input.report_type not in {"municipal", "state"}:
        return None
    address = (input.address or "").strip()
    if not address:
        return None
    result = json.loads(
        merge_research_reports(
            MergeResearchReportsInput(address=address, project_type=input.project_type)
        )
    )
    if result.get("status") == "written":
        return result.get("path")
    return None


def archive_code_scrape(input: ArchiveCodeScrapeInput) -> str:
    """Scrape code excerpts from Internet Archive OCR text + Browserbase session."""
    api_key = os.environ.get("BROWSERBASE_API_KEY")
    if input.use_browserbase and not api_key:
        return json.dumps({"error": "BROWSERBASE_API_KEY is not set"})

    project_id = os.environ.get("BROWSERBASE_PROJECT_ID")
    item_id = _extract_identifier(input.archive_url, input.archive_item_id)

    # Default to California Residential Code on archive if nothing specified
    if not item_id and not input.archive_url:
        item_id = ARCHIVE_ITEMS["ca_residential_2025"]["id"]

    sources_used: list[dict] = []
    all_excerpts: list[dict] = []
    errors: list[str] = []
    session_recordings: list[str] = []

    # 1. Fetch full OCR text (primary — reliable, free, no paywall)
    item_ids_to_try: list[str] = []
    if item_id:
        item_ids_to_try.append(item_id)
    elif not input.use_browserbase:
        query = input.research_goal
        if "oakland" in input.jurisdiction.lower():
            query = "oakland planning code accessory dwelling"
        for hit in _search_archive_items(query, max_results=5):
            item_ids_to_try.append(hit["id"])

    for try_id in item_ids_to_try:
        full_text, djvu_url = _fetch_djvu_text(try_id)
        if full_text:
            excerpts = search_archive_text(full_text, input.search_terms, max_excerpts=15)
            sources_used.append(
                {
                    "type": "internet_archive_ocr",
                    "item_id": try_id,
                    "url": djvu_url,
                    "title": try_id,
                    "text_length": len(full_text),
                }
            )
            all_excerpts.extend(excerpts)
            break
    else:
        if item_ids_to_try:
            errors.append(f"Could not fetch OCR text for archive items: {', '.join(item_ids_to_try)}")

    # 1b. Municipal web fallback (Oakland official pages when IA has no local code)
    if not all_excerpts and "oakland" in input.jurisdiction.lower():
        for url in OAKLAND_MUNICIPAL_URLS:
            page_text = _fetch_web_page_text(url)
            if page_text:
                sources_used.append({"type": "municipal_web", "url": url, "text_length": len(page_text)})
                all_excerpts.extend(search_archive_text(page_text, input.search_terms, max_excerpts=10))
                if all_excerpts:
                    break

    # 2. Browserbase session for demo visibility + supplemental page text
    browse_url = input.archive_url or (
        f"https://archive.org/details/{item_id}" if item_id else "https://archive.org/search?query=california+residential+code+ADU"
    )
    if input.use_browserbase:
        session_url, page_text, browse_errors = _run_sync_in_thread(
            _browserbase_archive_context,
            api_key,
            project_id,
            browse_url,
            input.search_terms,
        )
        if session_url:
            session_recordings.append(session_url)
        errors.extend(browse_errors)
        if page_text:
            sources_used.append({"type": "browserbase_page", "url": browse_url, "text_length": len(page_text)})
            all_excerpts.extend(search_archive_text(page_text, input.search_terms, max_excerpts=5))

        # 3. Search archive.org for additional municipal items if jurisdiction mentions Oakland
        if "oakland" in input.jurisdiction.lower():
            search_url = f"https://archive.org/search?query={quote_plus('oakland planning code accessory dwelling')}"
            extra_session, extra_text, extra_errors = _run_sync_in_thread(
                _browserbase_archive_context,
                api_key,
                project_id,
                search_url,
                input.search_terms,
            )
            if extra_session:
                session_recordings.append(extra_session)
            errors.extend(extra_errors)
            if extra_text:
                all_excerpts.extend(search_archive_text(extra_text, input.search_terms, max_excerpts=5))
                sources_used.append({"type": "archive_search", "url": search_url})

    report_body = _format_scrape_report(input, sources_used, all_excerpts, errors, session_recordings)

    report_path: str | None = None
    if input.auto_write_report and input.report_filename:
        write_result = json.loads(
            write_text_report(
                WriteTextReportInput(
                    filename=input.report_filename,
                    content=report_body,
                    report_type=input.report_type,
                )
            )
        )
        report_path = write_result.get("path")

    final_summary_path = _try_auto_merge(input)

    summary = report_body[:SUMMARY_LIMIT]
    primary_session = session_recordings[0] if session_recordings else None
    payload: dict = {
        "session_recording_url": primary_session,
        "session_recording_urls": session_recordings,
        "final_summary_path": final_summary_path,
        "excerpt_count": len(all_excerpts),
        "summary": summary,
        "report_path": report_path,
        "errors": errors[:3] if errors else [],
    }
    if final_summary_path:
        payload["instruction"] = (
            "@mention `@varbtw/code-synthesizer` once: final_summary.txt is ready at "
            f"{final_summary_path}. Ask it to confirm in chat. Do NOT merge yourself."
        )
    elif report_path:
        payload["instruction"] = (
            "@mention `@varbtw/code-synthesizer` with report_path and session_recording_url in max 5 sentences. "
            "Do NOT call WriteTextReportInput again."
        )
    else:
        payload["instruction"] = (
            "Pass summary to WriteTextReportInput once. Post max 5 sentences in chat."
        )

    return json.dumps(payload)


def _format_scrape_report(
    input: ArchiveCodeScrapeInput,
    sources: list[dict],
    excerpts: list[dict],
    errors: list[str],
    session_recordings: list[str] | None = None,
) -> str:
    lines = [
        f"BUILDING CODE RESEARCH — {input.jurisdiction}",
        f"Goal: {input.research_goal}",
        f"Search terms: {input.search_terms}",
    ]
    if session_recordings:
        for i, url in enumerate(session_recordings, 1):
            label = "Browserbase Session" if len(session_recordings) == 1 else f"Browserbase Session {i}"
            lines.append(f"{label}: {url}")
    elif input.use_browserbase:
        lines.append("Browserbase Session: (session failed or unavailable)")
    lines.extend(["", "SOURCES", "-------"])
    for src in sources:
        lines.append(f"- [{src.get('type')}] {src.get('url', src.get('item_id', ''))}")
    lines.extend(["", "CODE EXCERPTS", "-------------"])
    if not excerpts:
        lines.append("(No matching excerpts found — try broader search terms.)")
    for i, ex in enumerate(excerpts[:15], 1):
        lines.append(f"\n--- Excerpt {i} (match: {ex.get('match', '')}) ---")
        lines.append(ex.get("text", ""))
    if errors:
        lines.extend(["", "ERRORS", "------", *errors])
    lines.extend(
        [
            "",
            "DISCLAIMER",
            "----------",
            "Pre-submission research assistant output. Verify against current official codes.",
        ]
    )
    return "\n".join(lines)


ARCHIVE_SCRAPE_TOOLS = [(ArchiveCodeScrapeInput, archive_code_scrape)]
