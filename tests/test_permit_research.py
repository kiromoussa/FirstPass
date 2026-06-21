"""Tests for permit process research helpers."""

from firstpass.permit_research_tool import (
    _build_search_query,
    _extract_checklist_items,
    _extract_filing_info,
    _is_trusted_permit_url,
    _permit_seed_urls,
)


def test_build_search_query_auto():
    q = _build_search_query(
        "1216 E 92nd St, Los Angeles, CA 90002",
        "Detached ADU",
        None,
        None,
    )
    assert "Los Angeles" in q
    assert "permit" in q.lower()
    assert "checklist" in q.lower()


def test_build_search_query_custom():
    q = _build_search_query("addr", "ADU", "LA", "custom permit portal query")
    assert q == "custom permit portal query"


def test_trusted_permit_url():
    assert _is_trusted_permit_url(
        "https://ladbs.lacity.gov/services/accessory-dwelling-units-adu",
        ["lacity.gov", "ladbs.lacity.gov"],
    )
    assert not _is_trusted_permit_url("https://spam.example.ru/permit", ["lacity.gov"])


def test_extract_checklist_items():
    text = """
    Required submittals:
    - Site plan showing setbacks
    - Floor plan with dimensions
    - Structural calculations signed by engineer
    Weather is nice today.
    """
    items = _extract_checklist_items(text)
    assert any("site plan" in i.lower() for i in items)
    assert not any("weather" in i.lower() for i in items)


def test_extract_filing_info():
    text = (
        "Submit through LADBS ePlanLA online portal. "
        "Step 1: Create an account. Step 2: Upload plan PDFs. "
        "Building permit fee $1,234.00."
    )
    info = _extract_filing_info(text, "https://ladbs.lacity.gov/services/eplanla")
    assert info["portal_url"].startswith("https://")
    assert info["fees_mentioned"]
    assert any("step" in s.lower() for s in info["submission_steps"])


def test_permit_seed_urls_la():
    seeds = _permit_seed_urls("1216 E 92nd St, Los Angeles, CA 90002")
    assert seeds
    assert any("ladbs" in url.lower() or "lacity" in url.lower() for url in seeds)
