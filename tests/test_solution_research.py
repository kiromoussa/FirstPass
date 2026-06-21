"""Tests for solution fix research helpers."""

from firstpass.solution_research_tool import (
    _build_search_query,
    _extract_fix_snippets,
    _is_trusted_solution_url,
    _violation_terms,
)


def test_build_search_query_auto():
    q = _build_search_query(
        "Rear setback 3 ft vs 4 ft minimum",
        "LAMC 12.03",
        "Los Angeles, CA",
        "Detached ADU",
        None,
    )
    assert "Los Angeles" in q
    assert "LAMC 12.03" in q
    assert "Rear setback" in q


def test_build_search_query_custom():
    q = _build_search_query("gap", "cite", "LA", "ADU", "custom query here")
    assert q == "custom query here"


def test_trusted_solution_url():
    assert _is_trusted_solution_url("https://www.hcd.ca.gov/policy-and-research/accessory-dwelling-units")
    assert _is_trusted_solution_url("https://planning.lacity.gov/project-review/accessory-dwelling-units")
    assert not _is_trusted_solution_url("https://spam.example.ru/page")


def test_extract_fix_snippets():
    text = (
        "The rear setback must be at least 4 feet to comply with LAMC. "
        "Designers may relocate the unit or reduce encroachment to meet the minimum setback. "
        "Weather today is sunny."
    )
    snippets = _extract_fix_snippets(text, _violation_terms("rear setback 3 ft", "LAMC"))
    assert any("setback" in s.lower() for s in snippets)
    assert not any("weather" in s.lower() for s in snippets)
