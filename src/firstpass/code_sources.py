"""Curated Internet Archive items and text search helpers."""

from __future__ import annotations

import re
from typing import Literal

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
        "title": "California Government Code (search for 65852 ADU sections)",
        "url": "https://archive.org/search?query=california+government+code+65852+accessory+dwelling",
    },
}

DEFAULT_ADDRESS = "700 Rosal Ave, Oakland, CA 94610"

OAKLAND_MUNICIPAL_URLS: list[str] = [
    "https://www.oaklandca.gov/My-Household/Building-and-Remodeling/Homeowner-Projects-Permits/Accessory-Dwelling-Units-ADUs/ADU-with-Single-Family-Home",
    "https://www.oaklandca.gov/My-Household/Building-and-Remodeling/Homeowner-Projects-Permits/Accessory-Dwelling-Units-ADUs",
    "https://library.municode.com/ca/oakland/codes/code_of_ordinances?nodeId=TIT17PLCO",
]

ARCHIVE_SEEDS: dict[str, list[dict[str, str]]] = {
    "state": [
        ARCHIVE_ITEMS["ca_residential_2025"],
        ARCHIVE_ITEMS["ca_building_2022"],
    ],
    "municipal": [
        {
            "id": "oakland_search",
            "title": "Oakland planning / ADU code search",
            "url": "https://archive.org/search?query=oakland+planning+code+accessory+dwelling+unit",
        },
    ],
}


def search_archive_text(full_text: str, search_terms: str, max_excerpts: int = 15) -> list[dict]:
    """Find excerpts in OCR text around search term matches."""
    terms = [t.strip().lower() for t in search_terms.split() if len(t.strip()) > 2]
    if not terms:
        terms = ["accessory dwelling", "adu"]

    excerpts: list[dict] = []
    seen: set[str] = set()
    lower_text = full_text.lower()

    # Multi-word phrases first
    phrases = [
        "accessory dwelling unit",
        "accessory dwelling",
        "junior accessory dwelling",
        "detached adu",
    ]
    phrases.extend(terms)

    for phrase in phrases:
        start = 0
        while len(excerpts) < max_excerpts:
            idx = lower_text.find(phrase, start)
            if idx == -1:
                break
            excerpt_start = max(0, idx - 400)
            excerpt_end = min(len(full_text), idx + 600)
            chunk = re.sub(r"\s+", " ", full_text[excerpt_start:excerpt_end]).strip()
            key = chunk[:80]
            if key not in seen and len(chunk) > 60:
                seen.add(key)
                excerpts.append({"match": phrase, "text": chunk})
            start = idx + len(phrase)

    return excerpts


def archive_item_for_role(role: str) -> dict[str, str]:
    if role == "municipal":
        return ARCHIVE_SEEDS["municipal"][0]
    return ARCHIVE_ITEMS["ca_residential_2025"]
