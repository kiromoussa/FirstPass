"""Browserbase research for municipal permit submission portals and checklists."""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote_plus, urljoin, urlparse

from browserbase import Browserbase
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright
from pydantic import BaseModel, Field

from firstpass.browserbase_tool import TEXT_LIMIT, _clean_text, _host, _load_page, _normalize_url
from firstpass.jurisdiction import resolve_from_address
from firstpass.permit.checklists import get_checklist_for_address

OUTPUT_DIR = Path(__file__).resolve().parents[2] / "output"

PERMIT_LINK_KEYWORDS: list[str] = [
    "permit",
    "submittal",
    "submit",
    "checklist",
    "application",
    "eplan",
    "accela",
    "portal",
    "building",
    "plan check",
    "adu",
    "accessory dwelling",
    "required document",
    "upload",
    "fee",
    "instructions",
]

PERMIT_CHECKLIST_LINE_PATTERNS: tuple[str, ...] = (
    r"^(?:\d+[\.)]\s+|\*\s+|[-•]\s+)(.{10,120})$",
    r"^(?:required|must include|submit|provide)[:\s]+(.{10,120})$",
)

FEE_PATTERN = re.compile(
    r"(?:permit|plan check|building|application)\s+fee[s]?(?:[^$\n]{0,40})?\$\s*[\d,]+(?:\.\d{2})?",
    re.IGNORECASE,
)


def _is_trusted_permit_url(url: str, official_domains: list[str]) -> bool:
    host = _host(url)
    if not host or host.endswith((".ru", ".cn")):
        return False
    if any(domain in host for domain in official_domains):
        return True
    trusted = (
        "lacity.gov",
        "ladbs",
        "oaklandca.gov",
        "hcd.ca.gov",
        "ca.gov",
        "accela",
        "eplan",
    )
    return any(token in host for token in trusted) or host.endswith(".gov")


def _permit_seed_urls(address: str) -> list[str]:
    checklist, profile = get_checklist_for_address(address)
    seeds: list[str] = []

    if checklist:
        for url in (
            checklist.checklist_source,
            checklist.submission_portal_url,
        ):
            if url and url not in seeds:
                seeds.append(url)

    for url in profile.municipal_seed_urls:
        if url not in seeds:
            seeds.append(url)

    if profile.parcel_lookup_url and profile.parcel_lookup_url not in seeds:
        seeds.append(profile.parcel_lookup_url)

    return seeds[:6]


def _build_search_query(
    address: str,
    project_type: str,
    jurisdiction: str | None,
    search_query: str | None,
) -> str:
    if search_query:
        return search_query.strip()
    profile = resolve_from_address(address)
    city = jurisdiction or profile.city or "California"
    return f"{city} {project_type} permit submittal checklist required documents portal"


def _extract_checklist_items(text: str) -> list[str]:
    items: list[str] = []
    seen: set[str] = set()
    for line in text.splitlines():
        stripped = line.strip()
        if len(stripped) < 10:
            continue
        lower = stripped.lower()
        if not any(
            kw in lower
            for kw in (
                "plan",
                "application",
                "calculation",
                "form",
                "elevation",
                "section",
                "site",
                "energy",
                "structural",
                "title 24",
                "cf1r",
                "checklist",
                "required",
                "submit",
            )
        ):
            continue
        for pattern in PERMIT_CHECKLIST_LINE_PATTERNS:
            match = re.match(pattern, stripped, re.IGNORECASE)
            candidate = match.group(1).strip() if match else stripped
            candidate = _clean_text(candidate, 140)
            if candidate not in seen and len(candidate) >= 10:
                seen.add(candidate)
                items.append(candidate)
            if len(items) >= 20:
                return items
    return items


def _extract_filing_info(text: str, page_url: str) -> dict:
    portal_url = page_url
    portal_name = ""
    submission_steps: list[str] = []
    fees: list[str] = []

    for match in FEE_PATTERN.finditer(text):
        fee = _clean_text(match.group(), 120)
        if fee not in fees:
            fees.append(fee)

    for line in text.splitlines():
        stripped = _clean_text(line, 160)
        lower = stripped.lower()
        if not portal_name and any(k in lower for k in ("eplan", "accela", "permit center", "online portal")):
            portal_name = stripped
        if re.match(r"^(?:step\s+\d+|^\d+[\.)])\s+", stripped, re.IGNORECASE):
            submission_steps.append(stripped)
        if any(k in lower for k in ("apply online", "create account", "log in", "register", "upload")):
            if stripped not in submission_steps:
                submission_steps.append(stripped)

    return {
        "portal_url": portal_url,
        "portal_name": portal_name,
        "submission_steps": submission_steps[:12],
        "fees_mentioned": fees[:6],
    }


def _extract_portal_links(page, base_url: str, official_domains: list[str], limit: int = 8) -> list[str]:
    keywords = list(PERMIT_LINK_KEYWORDS)
    links: list[tuple[int, str]] = []

    for anchor in page.query_selector_all("a[href]"):
        href = anchor.get_attribute("href")
        if not href or href.startswith("#") or href.startswith("mailto:"):
            continue
        absolute = _normalize_url(urljoin(base_url, href))
        if not _is_trusted_permit_url(absolute, official_domains):
            continue
        text = (anchor.inner_text() or "").lower()
        path = absolute.lower()
        score = sum(1 for kw in keywords if kw in text or kw in path)
        if any(token in path for token in ("permit", "eplan", "accela", "submittal", "application", "adu")):
            score += 2
        if score > 0:
            links.append((score, absolute))

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


def _extract_ddg_result_links(page, official_domains: list[str], limit: int = 5) -> list[str]:
    links: list[str] = []
    seen: set[str] = set()
    for anchor in page.query_selector_all("a.result__a, a.result-link, a[href^='http']"):
        href = anchor.get_attribute("href")
        if not href or href.startswith("mailto:"):
            continue
        absolute = _normalize_url(urljoin(page.url, href))
        if "duckduckgo.com" in absolute:
            continue
        if not _is_trusted_permit_url(absolute, official_domains):
            continue
        if absolute in seen:
            continue
        seen.add(absolute)
        links.append(absolute)
        if len(links) >= limit:
            break
    return links


def _detect_automation_notes(page) -> dict:
    """Capture what can and cannot be automated on the current permit page."""
    notes: list[str] = []
    login_required = False
    upload_fields: list[str] = []
    apply_links: list[str] = []

    for anchor in page.query_selector_all("a[href]"):
        text = (anchor.inner_text() or "").strip()
        href = anchor.get_attribute("href") or ""
        lower = text.lower()
        if any(k in lower for k in ("apply", "start application", "submit", "eplan")):
            apply_links.append(_clean_text(f"{text} → {urljoin(page.url, href)}", 160))
        if any(k in lower for k in ("log in", "sign in", "register", "create account")):
            login_required = True
            notes.append(f"Login/registration likely required: {text}")

    for inp in page.query_selector_all("input[type='file']"):
        label = inp.get_attribute("aria-label") or inp.get_attribute("name") or "file upload"
        upload_fields.append(label)

    body_text = page.evaluate("() => document.body.innerText").lower()
    if "captcha" in body_text:
        notes.append("CAPTCHA detected — manual completion required.")
    if upload_fields:
        notes.append(f"Found {len(upload_fields)} file upload control(s) on page.")
    if apply_links:
        notes.append("Apply/submit links found — human should complete authenticated submission.")

    return {
        "login_required": login_required,
        "upload_fields": upload_fields[:8],
        "apply_links": apply_links[:6],
        "automation_notes": notes[:10],
        "can_auto_submit": False,
    }


class PermitProcessResearchInput(BaseModel):
    """Browse the city's permit portal via Browserbase to gather submittal requirements."""

    address: str = Field(..., description="Project address — resolves city permit portal seeds")
    project_type: str = Field(default="Detached ADU", description="Project type from kickoff")
    search_query: str | None = Field(
        default=None,
        description="Optional custom search, e.g. 'Los Angeles ADU ePlanLA submittal checklist'",
    )
    max_pages: int = Field(default=5, ge=1, le=8, description="Maximum pages to visit in this session")
    auto_write_report: bool = Field(
        default=True,
        description="Write output/permit_research.json and output/permit_research.txt",
    )


def permit_process_research(input: PermitProcessResearchInput) -> str:
    """Research permit filing location, checklist, and automation limits via Browserbase."""
    api_key = os.environ.get("BROWSERBASE_API_KEY")
    if not api_key:
        return json.dumps({"error": "BROWSERBASE_API_KEY is not set"})

    profile = resolve_from_address(input.address)
    checklist, _ = get_checklist_for_address(input.address)
    query = _build_search_query(input.address, input.project_type, profile.city, input.search_query)
    search_url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"

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
    all_checklist_items: list[str] = []
    filing_infos: list[dict] = []
    automation_summary: dict = {
        "login_required": False,
        "upload_fields": [],
        "apply_links": [],
        "automation_notes": [],
        "can_auto_submit": False,
    }

    urls_to_visit: list[str] = []
    for seed in _permit_seed_urls(input.address):
        if seed not in urls_to_visit:
            urls_to_visit.append(seed)
    urls_to_visit.append(search_url)

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(session.connect_url)
            page = browser.contexts[0].pages[0]

            for url in list(urls_to_visit):
                if len(pages_visited) >= input.max_pages:
                    break
                if url in visited:
                    continue
                try:
                    record = _load_page(page, url)
                    if record["url"] in visited:
                        continue
                    visited.add(record["url"])

                    checklist_items = _extract_checklist_items(record["text"])
                    filing_info = _extract_filing_info(record["text"], record["url"])
                    automation = _detect_automation_notes(page)

                    record["checklist_items"] = checklist_items
                    record["filing_info"] = filing_info
                    record["automation"] = automation
                    pages_visited.append(record)

                    for item in checklist_items:
                        if item not in all_checklist_items:
                            all_checklist_items.append(item)
                    filing_infos.append(filing_info)

                    if automation["login_required"]:
                        automation_summary["login_required"] = True
                    automation_summary["upload_fields"].extend(
                        f for f in automation["upload_fields"] if f not in automation_summary["upload_fields"]
                    )
                    automation_summary["apply_links"].extend(
                        link for link in automation["apply_links"] if link not in automation_summary["apply_links"]
                    )
                    for note in automation["automation_notes"]:
                        if note not in automation_summary["automation_notes"]:
                            automation_summary["automation_notes"].append(note)

                    if "duckduckgo.com" in record["url"]:
                        for link in _extract_ddg_result_links(page, profile.official_domains):
                            if link not in urls_to_visit:
                                urls_to_visit.append(link)
                    else:
                        for link in _extract_portal_links(page, page.url, profile.official_domains):
                            if link not in urls_to_visit:
                                urls_to_visit.append(link)
                except PlaywrightTimeoutError:
                    errors.append(f"Timeout loading {url}")
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"Failed to load {url}: {exc}")

            browser.close()
    except Exception as exc:  # noqa: BLE001
        errors.append(f"Browserbase session error: {exc}")

    static_checklist = [item.name for item in checklist.items] if checklist else []
    merged_checklist = list(dict.fromkeys(all_checklist_items + static_checklist))

    primary_portal = ""
    primary_portal_url = ""
    if checklist:
        primary_portal = checklist.submission_portal
        primary_portal_url = checklist.submission_portal_url
    for info in filing_infos:
        if info.get("portal_name") and not primary_portal:
            primary_portal = info["portal_name"]
        if info.get("portal_url") and not primary_portal_url:
            primary_portal_url = info["portal_url"]

    payload: dict = {
        "address": input.address,
        "city": profile.city,
        "project_type": input.project_type,
        "search_query_used": query,
        "session_recording_url": session_url,
        "submission_portal": primary_portal,
        "submission_portal_url": primary_portal_url,
        "checklist_source": checklist.checklist_source if checklist else None,
        "required_documents": merged_checklist,
        "web_discovered_items": all_checklist_items,
        "static_checklist_items": static_checklist,
        "filing_details": filing_infos,
        "automation": automation_summary,
        "pages": [
            {
                "url": p["url"],
                "title": p.get("title", ""),
                "checklist_items": p.get("checklist_items", []),
                "filing_info": p.get("filing_info", {}),
                "automation": p.get("automation", {}),
                "text_excerpt": p.get("text", "")[:TEXT_LIMIT],
            }
            for p in pages_visited
        ],
        "errors": errors,
        "instruction": (
            "Use required_documents, submission_portal_url, and automation notes to draft the permit "
            "closeout report. Include session_recording_url. Do NOT claim the permit was submitted — "
            "note login-required steps for the applicant. Then run ReviewPermitPackageInput against plans/."
        ),
    }

    if input.auto_write_report:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        json_path = OUTPUT_DIR / "permit_research.json"
        txt_path = OUTPUT_DIR / "permit_research.txt"
        json_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

        lines = [
            f"PERMIT PROCESS RESEARCH — {profile.city}",
            f"Address: {input.address}",
            f"Project type: {input.project_type}",
            f"Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
            "",
            f"Where to file: {primary_portal or 'See portal URL'}",
            f"Portal URL: {primary_portal_url or 'Not found — verify on city site'}",
            "",
            "REQUIRED DOCUMENTS / CHECKLIST",
            "------------------------------",
        ]
        for item in merged_checklist:
            lines.append(f"- {item}")
        if automation_summary["automation_notes"]:
            lines.extend(["", "AUTOMATION NOTES", "----------------"])
            lines.extend(f"- {note}" for note in automation_summary["automation_notes"])
        lines.extend(["", f"Browserbase Session: {session_url}"])
        txt_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

        payload["json_path"] = str(json_path)
        payload["txt_path"] = str(txt_path)

    return json.dumps(payload, indent=2)


PERMIT_RESEARCH_TOOLS = [(PermitProcessResearchInput, permit_process_research)]
