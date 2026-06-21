"""Curated Internet Archive items, city seeds, and text search helpers."""

from __future__ import annotations

import re
from typing import Literal
from urllib.parse import urlparse

SourceHint = Literal["auto", "municipal", "state", "archive", "icc", "dgs", "hcd"]

# Primary Internet Archive building code items (Public.Resource.Org / CBSC)
ARCHIVE_ITEMS: dict[str, dict[str, str]] = {
    "ca_residential_2025": {
        "id": "gov.ca.bsc.residential.2025",
        "title": "California 2025 Residential Code (Title 24 Part 2.5)",
        "url": "https://archive.org/details/gov.ca.bsc.residential.2025",
    },
    "ca_building_2022": {
        "id": "2022californiabu01unse",
        "title": "2022 California Building Code Volume 2",
        "url": "https://archive.org/details/2022californiabu01unse",
    },
    "ca_green_2022": {
        "id": "2022californiagr00unse",
        "title": "2022 California Green Building Code",
        "url": "https://archive.org/details/2022californiagr00unse",
    },
    "ca_gov_code_adu": {
        "id": "gov.ca.code.gov",
        "title": "California Government Code (ADU sections 65852, 66310+)",
        "url": "https://archive.org/search?query=california+government+code+65852+accessory+dwelling",
    },
}

DEFAULT_ADDRESS = "700 Rosal Ave, Oakland, CA 94610"

OAKLAND_MUNICIPAL_URLS: list[str] = [
    "https://www.oaklandca.gov/My-Household/Building-and-Remodeling/Homeowner-Projects-Permits/Accessory-Dwelling-Units-ADUs/ADU-with-Single-Family-Home",
    "https://www.oaklandca.gov/My-Household/Building-and-Remodeling/Homeowner-Projects-Permits/Accessory-Dwelling-Units-ADUs",
    "https://library.municode.com/ca/oakland/codes/code_of_ordinances?nodeId=TIT17PLCO",
]

LA_MUNICIPAL_URLS: list[str] = [
    "https://planning.lacity.gov/project-review/accessory-dwelling-units",
    "https://ladbs.lacity.gov/services/accessory-dwelling-units-adu",
    "https://library.municode.com/ca/los_angeles/codes/code_of_ordinances?nodeId=TIT12PLCO",
]

HCD_ADU_URLS: list[str] = [
    "https://www.hcd.ca.gov/policy-and-research/accessory-dwelling-units",
    "https://www.hcd.ca.gov/building/homeowners/accessory-dwelling-units",
]

GOV_CODE_SECTION_URLS: list[str] = [
    "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=GOV&sectionNum=65852.2",
    "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=GOV&sectionNum=66314",
    "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=GOV&sectionNum=66313",
    "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=GOV&sectionNum=66315",
]

STATE_ARCHIVE_IDS: list[str] = [
    ARCHIVE_ITEMS["ca_gov_code_adu"]["id"],
    ARCHIVE_ITEMS["ca_residential_2025"]["id"],
]

TRUSTED_HOSTS: tuple[str, ...] = (
    "iccsafe.org",
    "codes.iccsafe.org",
    "dgs.ca.gov",
    "hcd.ca.gov",
    "municode.com",
    "library.municode.com",
    "ecode360.com",
    "lacity.gov",
    "ladbs.lacity.gov",
    "ladbs.org",
    "planning.lacity.gov",
    "oaklandca.gov",
    "leginfo.legislature.ca.gov",
    "archive.org",
)

CODE_LINK_KEYWORDS: list[str] = [
    "accessory dwelling",
    "adu",
    "65852",
    "66313",
    "66310",
    "setback",
    "zoning",
    "planning code",
    "municipal code",
    "ordinance",
    "height",
    "lot coverage",
    "parking",
    "ministerial",
    "residential code",
    "title 24",
]

SEED_URLS: dict[str, list[dict[str, str]]] = {
    "los_angeles": [
        {"url": url, "label": "LA municipal"} for url in LA_MUNICIPAL_URLS
    ],
    "oakland": [
        {"url": url, "label": "Oakland municipal"} for url in OAKLAND_MUNICIPAL_URLS
    ],
    "state": [
        {"url": ARCHIVE_ITEMS["ca_gov_code_adu"]["url"], "label": "Gov Code ADU"},
        {"url": ARCHIVE_ITEMS["ca_residential_2025"]["url"], "label": "CRC 2025"},
        *[{"url": u, "label": "HCD ADU"} for u in HCD_ADU_URLS],
    ],
    "hcd": [{"url": u, "label": "HCD ADU"} for u in HCD_ADU_URLS],
}

ARCHIVE_SEEDS: dict[str, list[dict[str, str]]] = {
    "state": [
        ARCHIVE_ITEMS["ca_gov_code_adu"],
        ARCHIVE_ITEMS["ca_residential_2025"],
    ],
    "municipal": [
        {
            "id": "oakland_search",
            "title": "Oakland planning / ADU code search",
            "url": "https://archive.org/search?query=oakland+planning+code+accessory+dwelling+unit",
        },
    ],
}

# Patterns that indicate irrelevant OCR hits unless ADU anchor also present
EXCLUDE_PATTERNS: list[str] = [
    r"\bbarn\b",
    r"\bagricultural\b",
    r"\bshed\b",
    r"\bchicken coop\b",
    r"adopt entire chapter",
    r"adopting agency",
]

STRONG_ANCHORS: list[str] = [
    "65852",
    "6631",
    "accessory dwelling unit",
    "ministerial",
    "ladbs",
    "lamc",
]

ANCHOR_TERMS: list[str] = STRONG_ANCHORS + [
    "accessory dwelling",
    "adu",
    "66313",
    "66314",
    "66315",
    "66316",
    "66317",
    "66318",
    "66319",
    "66320",
    "66321",
    "66322",
    "66323",
    "66324",
    "66325",
    "66326",
    "66327",
    "66328",
    "66329",
    "66330",
    "66331",
    "66332",
    "66333",
    "66334",
    "66335",
    "66336",
    "66337",
    "66338",
    "66339",
    "66340",
    "66341",
    "66342",
    "setback",
    "zoning",
    "ministerial",
    "municipal code",
    "planning code",
    "ladbs",
    "lamc",
]


def is_trusted_code_url(url: str) -> bool:
    host = urlparse(url).netloc.lower()
    if not host:
        return False
    return any(trusted in host for trusted in TRUSTED_HOSTS)


def seeds_for_hint(hint: SourceHint) -> list[str]:
    if hint == "municipal":
        urls: list[str] = []
        for city_seeds in (SEED_URLS.get("los_angeles", []), SEED_URLS.get("oakland", [])):
            urls.extend(entry["url"] for entry in city_seeds)
        return urls
    if hint in {"state", "hcd"}:
        return [entry["url"] for entry in SEED_URLS.get(hint, SEED_URLS.get("state", []))]
    if hint == "dgs":
        return ["https://www.dgs.ca.gov/BSC"]
    if hint == "icc":
        return ["https://codes.iccsafe.org/codes/california"]
    return []


def _is_toc_noise(text: str) -> bool:
    """Detect table-of-contents / adoption-table noise."""
    lower = text.lower()
    pipe_count = text.count("|") + text.count("x |") + text.count("| x")
    if pipe_count >= 8 and "accessory dwelling" not in lower:
        return True
    if lower.count("appendix") >= 3 and len(text) < 800:
        return True
    return False


def _has_anchor(text: str) -> bool:
    lower = text.lower()
    return any(term in lower for term in ANCHOR_TERMS)


def _is_excluded(text: str) -> bool:
    lower = text.lower()
    for pattern in EXCLUDE_PATTERNS:
        if re.search(pattern, lower, re.I):
            if any(anchor in lower for anchor in STRONG_ANCHORS):
                return False
            return True
    return False


def _normalize_excerpt_key(text: str) -> str:
    collapsed = re.sub(r"\s+", " ", text.lower())
    collapsed = re.sub(r"[^\w\s]", "", collapsed)
    return collapsed[:120]


def _overlap_ratio(a: str, b: str) -> float:
    words_a = set(_normalize_excerpt_key(a).split())
    words_b = set(_normalize_excerpt_key(b).split())
    if not words_a or not words_b:
        return 0.0
    return len(words_a & words_b) / min(len(words_a), len(words_b))


def search_archive_text(
    full_text: str,
    search_terms: str,
    max_excerpts: int = 15,
    context_before: int = 400,
    context_after: int = 600,
) -> list[dict]:
    """Find relevant excerpts in OCR text around search term matches."""
    terms = [t.strip().lower() for t in search_terms.split() if len(t.strip()) > 2]
    if not terms:
        terms = ["accessory dwelling", "adu"]

    excerpts: list[dict] = []
    seen: set[str] = set()
    lower_text = full_text.lower()

    phrases = [
        "accessory dwelling unit",
        "accessory dwelling",
        "junior accessory dwelling",
        "detached adu",
        "government code section 663",
        "65852.2",
        "ministerial approval",
        "four feet",
        "4 feet",
        "4-foot",
    ]
    phrases.extend(terms)

    for phrase in phrases:
        start = 0
        while len(excerpts) < max_excerpts:
            idx = lower_text.find(phrase, start)
            if idx == -1:
                break
            excerpt_start = max(0, idx - context_before)
            excerpt_end = min(len(full_text), idx + context_after)
            chunk = re.sub(r"\s+", " ", full_text[excerpt_start:excerpt_end]).strip()
            if len(chunk) <= 60:
                start = idx + len(phrase)
                continue
            if _is_toc_noise(chunk) or _is_excluded(chunk):
                start = idx + len(phrase)
                continue
            if not _has_anchor(chunk):
                start = idx + len(phrase)
                continue

            key = _normalize_excerpt_key(chunk)
            if key in seen:
                start = idx + len(phrase)
                continue

            # Fuzzy dedup against existing excerpts
            if any(_overlap_ratio(chunk, existing["text"]) > 0.85 for existing in excerpts):
                start = idx + len(phrase)
                continue

            seen.add(key)
            excerpts.append({"match": phrase, "text": chunk})
            start = idx + len(phrase)

    return excerpts


def archive_item_for_role(role: str) -> dict[str, str]:
    if role == "municipal":
        return ARCHIVE_SEEDS["municipal"][0]
    return ARCHIVE_ITEMS["ca_residential_2025"]


def validate_sources(report_type: str, sources_used: list[dict], profile=None) -> list[str]:
    """Return validation warnings; empty list means pass."""
    warnings: list[str] = []
    if not sources_used:
        warnings.append("No sources retrieved.")
        return warnings

    hosts = []
    for src in sources_used:
        url = src.get("url") or src.get("item_id") or ""
        if url:
            hosts.append(urlparse(str(url)).netloc.lower())

    if report_type == "municipal":
        has_official = False
        if profile and profile.supported:
            has_official = any(
                s.get("type") in {"municipal_web", "browserbase_municipal"}
                and _url_matches_profile(str(s.get("url", "")), profile)
                for s in sources_used
            )

        crc_only_sources = sources_used and all(
            "bsc.residential" in str(s.get("item_id", "")).lower()
            or "gov.ca.bsc" in str(s.get("item_id", "")).lower()
            for s in sources_used
            if s.get("type") == "internet_archive_ocr"
        ) and not has_official

        if profile and profile.supported and not has_official:
            warnings.append(
                f"No official municipal source found for {profile.city}. "
                "Expected LADBS, city planning, or Municode URLs."
            )
        if crc_only_sources or (
            not has_official
            and sources_used
            and all(s.get("type") == "internet_archive_ocr" for s in sources_used)
        ):
            warnings.append(
                "JURISDICTION MISMATCH: municipal report uses state building code (CRC) only. "
                "This is not a valid municipal zoning source."
            )

    if report_type == "state":
        has_gov = any(
            "65852" in str(s.get("url", "")).lower()
            or "gov.ca.code" in str(s.get("item_id", "")).lower()
            or "leginfo" in str(s.get("url", "")).lower()
            or s.get("type") == "gov_code_web"
            for s in sources_used
        )
        has_hcd = any("hcd.ca.gov" in str(s.get("url", "")).lower() for s in sources_used)
        has_building = any(
            "bsc.residential" in str(s.get("item_id", "")).lower()
            or "residential" in str(s.get("title", "")).lower()
            for s in sources_used
        )
        if has_building and not has_gov and not has_hcd:
            warnings.append(
                "State report missing Government Code ADU statutes (65852.2, 66310+). "
                "CRC alone does not cover ministerial approval, setbacks, or parking exemptions."
            )

    return warnings


def _url_matches_profile(url: str, profile) -> bool:
    if not url:
        return False
    url_lower = url.lower()
    for domain in profile.official_domains:
        if domain in url_lower:
            return True
    if profile.municode_host and profile.municode_host in url_lower:
        return True
    return False
