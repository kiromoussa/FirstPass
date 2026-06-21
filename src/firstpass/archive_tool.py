"""Scrape building codes from Internet Archive via Browserbase + OCR text files."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse

import httpx
from browserbase import Browserbase
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright
from pydantic import BaseModel, Field

from firstpass.async_utils import run_sync_in_thread
from firstpass.browserbase_tool import scrape_municipal_web
from firstpass.code_sources import (
    ARCHIVE_ITEMS,
    GOV_CODE_SECTION_URLS,
    HCD_ADU_URLS,
    STATE_ARCHIVE_IDS,
    search_archive_text,
    validate_sources,
)
from firstpass.jurisdiction import is_official_municipal_source, resolve_from_address, resolve_jurisdiction
from firstpass.requirements import (
    checklist_coverage,
    extract_requirements_from_excerpts,
    fill_checklist_gaps,
    write_requirements_json,
)
from firstpass.report_tool import MergeResearchReportsInput, WriteTextReportInput, merge_research_reports, write_text_report

TEXT_LIMIT = 20_000
SUMMARY_LIMIT = 1_500
NAV_TIMEOUT_MS = 90_000
BROWSERBASE_TIMEOUT_SEC = 90
MUNICIPAL_BROWSERBASE_MAX_PAGES = 2
STATE_BROWSERBASE_MAX_URLS = 1


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
    """Fetch visible text from a public web page."""
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
            return text[:TEXT_LIMIT] if len(text) > 80 else None
    except Exception:  # noqa: BLE001
        return None


def _fetch_djvu_text(item_id: str) -> tuple[str | None, str | None]:
    """Download OCR plain text from Internet Archive."""
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
    """Use Browserbase to open a URL and capture visible page context."""
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


def _scrape_archive_item(
    item_id: str,
    search_terms: str,
    sources_used: list[dict],
    all_excerpts: list[dict],
    max_excerpts: int = 15,
) -> bool:
    full_text, djvu_url = _fetch_djvu_text(item_id)
    if not full_text:
        return False
    excerpts = search_archive_text(full_text, search_terms, max_excerpts=max_excerpts)
    sources_used.append(
        {
            "type": "internet_archive_ocr",
            "item_id": item_id,
            "url": djvu_url,
            "title": item_id,
            "text_length": len(full_text),
        }
    )
    all_excerpts.extend(excerpts)
    return True


def _has_official_municipal_httpx(sources_used: list[dict], profile) -> bool:
    return any(
        s.get("type") == "municipal_web"
        and is_official_municipal_source(str(s.get("url", "")), profile)
        for s in sources_used
    )


def _has_sufficient_state_httpx(sources_used: list[dict], all_excerpts: list[dict]) -> bool:
    has_gov = any(s.get("type") == "gov_code_web" for s in sources_used)
    has_crc = any("bsc.residential" in str(s.get("item_id", "")).lower() for s in sources_used)
    return has_gov and has_crc and len(all_excerpts) >= 3


def _run_browserbase_safe(label: str, fn, *args, errors: list[str], timeout: int = BROWSERBASE_TIMEOUT_SEC):
    """Run Browserbase work with a hard timeout so Band agents do not hang."""
    try:
        return run_sync_in_thread(fn, *args, timeout_seconds=timeout)
    except TimeoutError:
        errors.append(f"{label} timed out after {timeout}s — skipped remaining Browserbase steps.")
        return None
    except Exception as exc:  # noqa: BLE001
        errors.append(f"{label} failed: {exc}")
        return None


def _scrape_municipal(
    input: ArchiveCodeScrapeInput,
    profile,
    api_key: str | None,
    project_id: str | None,
) -> tuple[list[dict], list[dict], list[str], list[str]]:
    sources_used: list[dict] = []
    all_excerpts: list[dict] = []
    errors: list[str] = []
    session_recordings: list[str] = []

    if not profile.supported:
        errors.append(profile.unsupported_message or f"City '{profile.city}' not supported.")
        return sources_used, all_excerpts, errors, session_recordings

    # 1. Official municipal web pages (httpx — fast)
    for url in profile.municipal_seed_urls:
        page_text = _fetch_web_page_text(url)
        if page_text:
            sources_used.append({"type": "municipal_web", "url": url, "text_length": len(page_text)})
            for ex in search_archive_text(page_text, input.search_terms, max_excerpts=8):
                ex["source_url"] = url
                all_excerpts.append(ex)

    # 2. Browserbase municipal browsing (Municode, LADBS) — skip if httpx already sufficient
    skip_browserbase = _has_official_municipal_httpx(sources_used, profile) and len(all_excerpts) >= 2
    if skip_browserbase:
        errors.append("Skipped Browserbase municipal browse (official httpx sources already retrieved).")
    elif input.use_browserbase and api_key:
        result = _run_browserbase_safe(
            "Municipal Browserbase browse",
            scrape_municipal_web,
            profile,
            input.search_terms,
            MUNICIPAL_BROWSERBASE_MAX_PAGES,
            errors=errors,
        )
        if result:
            pages, browse_errors, sessions = result
            session_recordings.extend(sessions)
            errors.extend(browse_errors)
            for page in pages:
                url = page.get("url", "")
                text = page.get("text", "")
                if not text:
                    continue
                sources_used.append(
                    {
                        "type": "browserbase_municipal",
                        "url": url,
                        "text_length": len(text),
                        "title": page.get("title"),
                    }
                )
                for ex in search_archive_text(text, input.search_terms, max_excerpts=6):
                    ex["source_url"] = url
                    all_excerpts.append(ex)
                for snippet in page.get("code_snippets", [])[:5]:
                    all_excerpts.append({"match": "code_snippet", "text": snippet, "source_url": url})

    # 3. City-specific archive search (not CRC)
    city_query = f"{profile.slug.replace('_', ' ')} planning code accessory dwelling unit"
    for hit in _search_archive_items(city_query, max_results=3):
        if "bsc.residential" in hit["id"] or "gov.ca.bsc" in hit["id"]:
            continue
        if _scrape_archive_item(hit["id"], input.search_terms, sources_used, all_excerpts, max_excerpts=8):
            break

    return sources_used, all_excerpts, errors, session_recordings


def _scrape_state(
    input: ArchiveCodeScrapeInput,
    api_key: str | None,
    project_id: str | None,
) -> tuple[list[dict], list[dict], list[str], list[str]]:
    sources_used: list[dict] = []
    all_excerpts: list[dict] = []
    errors: list[str] = []
    session_recordings: list[str] = []

    gov_terms = input.search_terms + " 65852.2 66310 66313 ministerial setback parking"
    crc_terms = input.search_terms + " R309.2 R202 accessory dwelling sprinkler"

    # 1. Government Code ADU statutes (priority)
    for item_id in STATE_ARCHIVE_IDS:
        if item_id == ARCHIVE_ITEMS["ca_residential_2025"]["id"]:
            continue
        if not _scrape_archive_item(item_id, gov_terms, sources_used, all_excerpts, max_excerpts=12):
            errors.append(f"Could not fetch Gov Code archive item: {item_id}")

    # Also search archive for gov code ADU
    for hit in _search_archive_items("california government code 65852 accessory dwelling", max_results=3):
        if hit["id"] not in {s.get("item_id") for s in sources_used}:
            _scrape_archive_item(hit["id"], gov_terms, sources_used, all_excerpts, max_excerpts=10)

    # 2. California Residential Code (building standards)
    item_id = _extract_identifier(input.archive_url, input.archive_item_id)
    if not item_id:
        item_id = ARCHIVE_ITEMS["ca_residential_2025"]["id"]
    if not _scrape_archive_item(item_id, crc_terms, sources_used, all_excerpts, max_excerpts=10):
        errors.append(f"Could not fetch CRC archive item: {item_id}")

    # 3. HCD ADU guidance + leginfo Gov Code sections (web)
    for url in HCD_ADU_URLS + GOV_CODE_SECTION_URLS:
        page_text = _fetch_web_page_text(url)
        if page_text:
            source_type = "gov_code_web" if "leginfo" in url else "hcd_web"
            sources_used.append({"type": source_type, "url": url, "text_length": len(page_text)})
            terms = gov_terms if "leginfo" in url else gov_terms
            for ex in search_archive_text(page_text, terms, max_excerpts=8):
                ex["source_url"] = url
                all_excerpts.append(ex)

    # 4. Browserbase supplemental — skip when httpx leginfo + CRC already sufficient
    skip_browserbase = _has_sufficient_state_httpx(sources_used, all_excerpts)
    if skip_browserbase:
        errors.append("Skipped Browserbase state browse (Gov Code + CRC httpx sources already retrieved).")
    elif input.use_browserbase and api_key:
        browse_urls = [HCD_ADU_URLS[0]][:STATE_BROWSERBASE_MAX_URLS]
        for browse_url in browse_urls:
            result = _run_browserbase_safe(
                f"State Browserbase browse ({browse_url})",
                _browserbase_archive_context,
                api_key,
                project_id,
                browse_url,
                gov_terms,
                errors=errors,
            )
            if not result:
                continue
            session_url, page_text, browse_errors = result
            if session_url:
                session_recordings.append(session_url)
            errors.extend(browse_errors)
            if page_text:
                sources_used.append(
                    {"type": "browserbase_page", "url": browse_url, "text_length": len(page_text)}
                )
                all_excerpts.extend(search_archive_text(page_text, gov_terms, max_excerpts=5))

    return sources_used, all_excerpts, errors, session_recordings


def _try_auto_merge(input: ArchiveCodeScrapeInput) -> str | None:
    """Synthesize compliance report when both researcher reports exist."""
    if input.report_type not in {"municipal", "state"}:
        return None
    address = (input.address or "").strip()
    if not address:
        return None
    result = json.loads(
        merge_research_reports(
            MergeResearchReportsInput(
                address=address,
                project_type=input.project_type,
                use_browserbase=False,
            )
        )
    )
    if result.get("status") == "written":
        return result.get("path")
    return None


def _write_requirements_sidecar(
    input: ArchiveCodeScrapeInput,
    all_excerpts: list[dict],
    sources_used: list[dict],
    profile,
) -> str | None:
    if input.report_type == "municipal":
        jurisdiction = profile.city if profile else input.jurisdiction
        checklist_type = "municipal"
        filename = "municipal_requirements.json"
        official = any(s.get("type") in {"municipal_web", "browserbase_municipal"} for s in sources_used)
    elif input.report_type == "state":
        jurisdiction = "California"
        checklist_type = "state"
        filename = "state_requirements.json"
        official = any(s.get("type") in {"hcd_web", "internet_archive_ocr"} for s in sources_used)
    else:
        return None

    source_url = next((s.get("url", "") for s in sources_used if s.get("url")), "")
    requirements = extract_requirements_from_excerpts(
        all_excerpts,
        jurisdiction=jurisdiction,
        source_url=source_url,
        official_source=official,
        checklist_type=checklist_type,
    )
    requirements = fill_checklist_gaps(requirements, checklist_type, jurisdiction)
    coverage = checklist_coverage(requirements, checklist_type)
    path = write_requirements_json(
        requirements,
        filename,
        metadata={
            "address": input.address,
            "project_type": input.project_type,
            "jurisdiction": jurisdiction,
            "coverage": coverage,
        },
    )
    return str(path)


def archive_code_scrape(input: ArchiveCodeScrapeInput) -> str:
    """Scrape code excerpts with jurisdiction-aware source routing."""
    api_key = os.environ.get("BROWSERBASE_API_KEY")
    if input.use_browserbase and not api_key:
        return json.dumps({"error": "BROWSERBASE_API_KEY is not set"})

    project_id = os.environ.get("BROWSERBASE_PROJECT_ID")
    address = (input.address or input.jurisdiction or "").strip()
    profile = resolve_from_address(address) if address else resolve_jurisdiction("Oakland", "CA")

    if input.report_type == "municipal":
        sources_used, all_excerpts, errors, session_recordings = _scrape_municipal(
            input, profile, api_key, project_id
        )
    elif input.report_type == "state":
        sources_used, all_excerpts, errors, session_recordings = _scrape_state(
            input, api_key, project_id
        )
    else:
        # Generic/research fallback — state-like behavior
        sources_used, all_excerpts, errors, session_recordings = _scrape_state(
            input, api_key, project_id
        )

    validation_warnings = validate_sources(input.report_type, sources_used, profile)
    jurisdiction_mismatch = any("JURISDICTION MISMATCH" in w for w in validation_warnings)
    official_municipal = not any(
        "No official municipal source" in w or "JURISDICTION MISMATCH" in w for w in validation_warnings
    ) and input.report_type == "municipal"

    report_body = _format_scrape_report(
        input, sources_used, all_excerpts, errors, session_recordings, validation_warnings
    )

    report_path: str | None = None
    requirements_path: str | None = None

    if input.auto_write_report and input.report_filename:
        no_sources = not sources_used and not all_excerpts
        if input.report_type == "municipal" and (jurisdiction_mismatch or (profile.supported and no_sources)):
            errors.append(
                "Report blocked: municipal scrape lacks official city sources or returned no data."
            )
        else:
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
            if report_path and not write_result.get("skipped"):
                requirements_path = _write_requirements_sidecar(input, all_excerpts, sources_used, profile)

    final_summary_path = _try_auto_merge(input) if report_path else None

    summary = report_body[:SUMMARY_LIMIT]
    primary_session = session_recordings[0] if session_recordings else None
    payload: dict = {
        "session_recording_url": primary_session,
        "session_recording_urls": session_recordings,
        "final_summary_path": final_summary_path,
        "requirements_path": requirements_path,
        "excerpt_count": len(all_excerpts),
        "validation_warnings": validation_warnings,
        "official_municipal_source": official_municipal if input.report_type == "municipal" else None,
        "jurisdiction_mismatch": jurisdiction_mismatch,
        "checklist_coverage": {},
        "summary": summary,
        "report_path": report_path,
        "errors": errors[:5] if errors else [],
    }

    if requirements_path:
        req_data = json.loads(Path(requirements_path).read_text(encoding="utf-8"))
        payload["checklist_coverage"] = req_data.get("metadata", {}).get("coverage", {})

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
            "Review validation_warnings. Fix sources or pass summary to WriteTextReportInput once."
        )

    return json.dumps(payload)


def _format_scrape_report(
    input: ArchiveCodeScrapeInput,
    sources: list[dict],
    excerpts: list[dict],
    errors: list[str],
    session_recordings: list[str] | None = None,
    validation_warnings: list[str] | None = None,
) -> str:
    lines = [
        f"BUILDING CODE RESEARCH — {input.jurisdiction}",
        f"Goal: {input.research_goal}",
        f"Search terms: {input.search_terms}",
    ]
    if input.address:
        lines.append(f"Address: {input.address}")
    if input.project_type:
        lines.append(f"Project type: {input.project_type}")

    if validation_warnings:
        lines.extend(["", "VALIDATION WARNINGS", "------------------"])
        lines.extend(f"- {w}" for w in validation_warnings)

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
