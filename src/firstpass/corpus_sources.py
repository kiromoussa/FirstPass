"""Declarative registry of sources for the AUTOMATED corpus refresh
(scripts/refresh_corpus.py) — distinct from code_sources.py's conversational
research seeds used by the live chat agents.

Every source here was checked against its site's robots.txt before inclusion:
  - law.justia.com          -> Allow: / (crawl-friendly mirror of current CA
                                codified statute text, incl. amendment citations)
  - codelibrary.amlegal.com -> Allow: / for User-agent: *, Content-Signal
                                ai-train=no / use=reference (fits: we cite it
                                back to a human, we don't train on it)
  - www.hcd.ca.gov           -> no restriction on content pages
  - www.dgs.ca.gov           -> no robots.txt found (no restriction)
  - archive.org              -> no restriction on /details/ pages

Deliberately EXCLUDED:
  - up.codes                 -> robots.txt disallows AI/bot crawlers from all
                                code-content paths; only /free-law, /blog etc.
                                are open to bots. Do not scrape.
  - leginfo.legislature.ca.gov -> robots.txt blankets Disallow: / with a 10s
                                crawl-delay (i.e. "please don't crawl us,
                                but throttle hard if you must"). We still use
                                leginfo URLs as CITATION links shown to a
                                human (linking isn't crawling) — we just never
                                fetch them ourselves.

Both law.justia.com and codelibrary.amlegal.com sit behind an active
Cloudflare/WAF challenge (confirmed: plain HTTP GET returns 403 "Just a
moment..." even with a browser User-Agent) despite the permissive robots.txt,
so they need FETCH_METHOD "browser" (Browserbase + Playwright, which this
project already licenses for exactly this — solving the JS challenge the same
way a real visitor's browser would). HCD/DGS/Internet Archive have no such
protection and use a plain "httpx" GET.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

FetchMethod = Literal["httpx", "browser"]
SourceKind = Literal["html", "pdf"]


@dataclass(frozen=True)
class RefreshSource:
    key: str  # stable id -> raw filename stem (data/cities/<slug>/raw/<key>.txt)
    slug: str  # target city corpus ("california" = folded into every CA city)
    category: str  # chunk_codes.py CATEGORY_LABELS bucket (state/city/building/...)
    title: str
    fetch_url: str
    fetch_method: FetchMethod
    citation_url: str
    # First regex match against the fetched text becomes this source's
    # "recency marker" — compared run-to-run to tell a real change in the LAW
    # from cosmetic page changes (whitespace, ads, unrelated edits).
    recency_pattern: str
    kind: SourceKind = "html"
    # For "browser" sources: if the landing page doesn't already contain one
    # of these keywords, try the on-page search box / best-scoring link once
    # before extracting (mirrors firstpass.browserbase_tool's navigation).
    search_terms: str | None = None
    # For a Justia CHAPTER INDEX page (fetch_url), which article numbers to
    # expand into individual section pages and concatenate — the index page
    # itself only lists article/section ranges, not statute text.
    enumerate_articles: tuple[int, ...] | None = None


# Shared across every California city — state law preempts local ADU limits.
STATE_SOURCES: list[RefreshSource] = [
    RefreshSource(
        key="gov-code-adu-ch13",
        slug="california",
        category="state",
        title="California Government Code — Accessory Dwelling Units (Title 7, Div. 1, Ch. 13)",
        fetch_url="https://law.justia.com/codes/california/code-gov/title-7/division-1/chapter-13/",
        fetch_method="browser",
        citation_url="https://leginfo.legislature.ca.gov/faces/codesTOCSelected.xhtml?tocCode=GOV",
        recency_pattern=r"Amended by Stats\.\s*\d{4},\s*Ch\.\s*\d+[^)]{0,120}\)",
        search_terms="accessory dwelling unit",
        # Article 1 (General Provisions) + Article 2 (ADU Approvals) — the two
        # articles with the actual ministerial-approval dimensional standards
        # (size/height/setback/parking). Article 3 (JADU) and 4 (ADU sales)
        # aren't modeled by FirstPass's rule keys, so they're skipped.
        enumerate_articles=(1, 2),
    ),
    RefreshSource(
        key="hcd-adu-handbook",
        slug="california",
        category="state",
        title="California HCD Accessory Dwelling Unit Handbook",
        fetch_url="https://www.hcd.ca.gov/sites/default/files/docs/policy-and-research/adu-handbook-update.pdf",
        fetch_method="httpx",
        kind="pdf",
        citation_url="https://www.hcd.ca.gov/policy-and-research/accessory-dwelling-units",
        recency_pattern=r"HANDBOOK\s+([A-Za-z]+\s+20\d{2})",
    ),
    RefreshSource(
        key="dgs-bsc-codes",
        slug="california",
        category="building",
        title="California Building Standards Commission — Codes, Errata & Supplements",
        fetch_url="https://www.dgs.ca.gov/BSC/Codes",
        fetch_method="httpx",
        citation_url="https://www.dgs.ca.gov/BSC/Codes",
        recency_pattern=r"\d{4}\s+Triennial Edition of Title 24",
    ),
    # Energy Code (Title 24 Part 6) is the one code body not covered by the
    # CADAI import (no 2025-edition Internet Archive scan exists — only a
    # 2007 historical one — and ICC's digital text is subscription-gated).
    # The CEC's own "Restructured 2025 Energy Code" PDF is the real full
    # section-by-section text (656 pages) — not the 3-page marketing summary.
    # NOTE on provenance: the CEC labels this document "FOR INFORMATION ONLY"
    # — it's the CEC's own reformatting of the adopted regulations into the
    # same SECTION-numbering style as the rest of Title 24, done for
    # readability, NOT itself the certified regulatory publication. The CEC
    # states its content reflects "the adopted 2025 Energy Code regulations,"
    # so it's accurate for citing substantive requirements, but cite it as a
    # CEC restructuring/reference document, not the official adopted text.
    RefreshSource(
        key="cec-energy-code-full",
        slug="california",
        category="energy",
        title="CEC — Restructured 2025 Energy Code, Title 24 Part 6 (full text; CEC reformatting of the adopted regulations, \"for information only\")",
        fetch_url="https://www.energy.ca.gov/sites/default/files/2025-11/Restructured_2025_Energy_Code_-_California_Code_of_Regulations_-_Title_24_Part_6_(For_Information_Only)_ada.pdf",
        fetch_method="httpx",
        kind="pdf",
        citation_url="https://www.energy.ca.gov/publications/2025/2025-building-energy-efficiency-standards-residential-and-nonresidential",
        recency_pattern=r"RESTRUCTURED\s+20\d{2}\s+ENERGY\s+CODE",
    ),
]

# Per-city municipal sources. Add a new city by adding a slug key here.
MUNICIPAL_SOURCES: dict[str, list[RefreshSource]] = {
    "los-angeles-ca": [
        RefreshSource(
            key="lamc-adu",
            slug="los-angeles-ca",
            category="city",
            title="Los Angeles Municipal Code — Accessory Dwelling Units (LAMC §12.22 A.33)",
            fetch_url="https://codelibrary.amlegal.com/codes/los_angeles/latest/lamc/0-0-0-1",
            fetch_method="browser",
            citation_url="https://codelibrary.amlegal.com/codes/los_angeles/latest/lamc/0-0-0-1",
            recency_pattern=r"(?i:current|codified) through[^<\n]{0,100}",
            search_terms="accessory dwelling unit 12.22",
        ),
    ],
    "alameda-ca": [
        RefreshSource(
            key="amc-adu",
            slug="alameda-ca",
            category="city",
            title="Alameda Municipal Code — Accessory Dwelling Units (AMC §30-5.21)",
            fetch_url="https://library.municode.com/ca/alameda/codes/code_of_ordinances",
            fetch_method="browser",
            citation_url="https://library.municode.com/ca/alameda/codes/code_of_ordinances",
            recency_pattern=r"(?i:current|codified) through[^<\n]{0,100}",
            search_terms="accessory dwelling unit 30-5.21",
        ),
    ],
    # Full municipal code bulk-imported from CADAI's chunked corpus (scripts/
    # import_cadai_corpus.py) — this recurring source just tracks the ADU
    # provisions specifically + the "current through" recency footer, same
    # role as amc-adu/lamc-adu above.
    "santa-ana-ca": [
        RefreshSource(
            key="sac-adu",
            slug="santa-ana-ca",
            category="city",
            title="Santa Ana Municipal Code — Accessory Dwelling Units",
            fetch_url="https://library.municode.com/ca/santa_ana/codes/code_of_ordinances",
            fetch_method="browser",
            citation_url="https://library.municode.com/ca/santa_ana/codes/code_of_ordinances",
            recency_pattern=r"(?i:current|codified) through[^<\n]{0,100}",
            search_terms="accessory dwelling unit",
        ),
    ],
}


def sources_for_city(slug: str) -> list[RefreshSource]:
    """Every source that feeds this city's corpus: shared state sources first,
    then the city's own municipal sources."""
    return [*STATE_SOURCES, *MUNICIPAL_SOURCES.get(slug, [])]


def all_city_slugs() -> list[str]:
    return sorted(MUNICIPAL_SOURCES.keys())
