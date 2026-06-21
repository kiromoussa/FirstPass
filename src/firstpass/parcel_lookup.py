"""Property-level data lookup (ZIMAS for Los Angeles, etc.)."""

from __future__ import annotations

import os
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote_plus

from firstpass.jurisdiction import JurisdictionProfile
from firstpass.models import PropertyCheck

from firstpass.async_utils import run_sync_in_thread


def _parse_zimas_text(text: str) -> dict[str, str | None]:
    """Extract key parcel fields from ZIMAS page text."""
    fields: dict[str, str | None] = {
        "base_zone": None,
        "lot_area": None,
        "overlay_zones": None,
        "general_plan": None,
    }
    zone_match = re.search(
        r"(?:Zone|Zoning)[:\s]+([A-Z][A-Z0-9\-]+(?:\([A-Z0-9]+\))?)",
        text,
        re.I,
    )
    if zone_match:
        fields["base_zone"] = zone_match.group(1).strip()

    lot_match = re.search(
        r"(?:Lot\s+Area|Parcel\s+Area|Square\s+Feet)[:\s]+([\d,]+(?:\.\d+)?\s*(?:sq\.?\s*ft\.?|sf)?)",
        text,
        re.I,
    )
    if lot_match:
        fields["lot_area"] = lot_match.group(1).strip()

    overlay_match = re.search(r"(?:Overlay|Specific\s+Plan|Hillside|Coastal)[:\s]+([^\n]{5,80})", text, re.I)
    if overlay_match:
        fields["overlay_zones"] = overlay_match.group(1).strip()

    gp_match = re.search(r"General\s+Plan[:\s]+([^\n]{3,60})", text, re.I)
    if gp_match:
        fields["general_plan"] = gp_match.group(1).strip()

    return fields


def _browserbase_zimas_lookup(address: str, profile: JurisdictionProfile) -> tuple[str, str, list[str]]:
    """Use Browserbase to search ZIMAS for an address."""
    api_key = os.environ.get("BROWSERBASE_API_KEY")
    if not api_key or not profile.parcel_lookup_url:
        return "", "", ["ZIMAS lookup skipped: no Browserbase key or parcel URL"]

    from browserbase import Browserbase
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
    from playwright.sync_api import sync_playwright

    project_id = os.environ.get("BROWSERBASE_PROJECT_ID")
    bb = Browserbase(api_key=api_key)
    create_params: dict = {"browser_settings": {"blockAds": True, "recordSession": True}}
    if project_id:
        create_params["project_id"] = project_id

    session = bb.sessions.create(**create_params)
    session_url = f"https://browserbase.com/sessions/{session.id}"
    errors: list[str] = []
    page_text = ""

    search_url = profile.parcel_lookup_url
    if "zimas" in search_url:
        search_url = f"{profile.parcel_lookup_url}?search={quote_plus(address)}"

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(session.connect_url)
            page = browser.contexts[0].pages[0]
            page.goto(search_url, wait_until="networkidle", timeout=90000)
            page.wait_for_timeout(3000)

            # Try address search input
            for sel in ['input[type="search"]', 'input[name*="address" i]', 'input[placeholder*="address" i]', "#searchInput"]:
                el = page.query_selector(sel)
                if el:
                    try:
                        el.fill(address)
                        el.press("Enter")
                        page.wait_for_timeout(5000)
                        break
                    except Exception:  # noqa: BLE001
                        continue

            page_text = page.evaluate("() => document.body.innerText.trim()")[:20000]
            browser.close()
    except PlaywrightTimeoutError:
        errors.append(f"Timeout loading {search_url}")
    except Exception as exc:  # noqa: BLE001
        errors.append(f"ZIMAS lookup error: {exc}")

    return session_url, page_text, errors


def lookup_property_checks(
    address: str,
    profile: JurisdictionProfile,
    use_browserbase: bool = True,
) -> tuple[list[PropertyCheck], str | None, list[str]]:
    """Return property checks for the address; ZIMAS for LA."""
    errors: list[str] = []
    session_url: str | None = None
    parsed: dict[str, str | None] = {}

    if profile.slug == "los_angeles" and profile.parcel_lookup_url and use_browserbase:
        session_url, page_text, errors = run_sync_in_thread(
            _browserbase_zimas_lookup, address, profile
        )
        if page_text:
            parsed = _parse_zimas_text(page_text)
        elif not errors:
            errors.append("ZIMAS returned no parseable parcel data")

    checks: list[PropertyCheck] = []
    field_map = [
        ("base_zone", "Base zone"),
        ("lot_area", "Lot area"),
        ("overlay_zones", "Overlay zones"),
        ("general_plan", "General plan"),
    ]
    for key, label in field_map:
        value = parsed.get(key)
        checks.append(
            PropertyCheck(
                field_name=label,
                value=value or "unknown",
                source=profile.parcel_lookup_url or "",
                confirmed=value is not None,
            )
        )

    if profile.slug != "los_angeles":
        checks.append(
            PropertyCheck(
                field_name="Parcel lookup",
                value=f"Not automated for {profile.city}",
                source="",
                confirmed=False,
            )
        )

    return checks, session_url, errors
