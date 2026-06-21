"""Tests for requirement extraction, dedup, and synthesis."""

from __future__ import annotations

import unittest

from firstpass.code_sources import search_archive_text, validate_sources
from firstpass.jurisdiction import resolve_jurisdiction
from firstpass.models import CodeRequirement
from firstpass.requirements import (
    extract_requirements_from_excerpts,
    fill_checklist_gaps,
    checklist_coverage,
)
from firstpass.synthesis import build_compliance_report, _resolve_conflicts


SPRINKLER_EXCERPT = {
    "match": "accessory dwelling unit",
    "text": (
        "R309.2 One- and two-family dwellings automatic sprinkler systems. "
        "Exceptions: 2. Accessory Dwelling Unit, provided that all of the following are met: "
        "2.1. The unit meets the definition of an Accessory Dwelling Unit as defined in "
        "Government Code Section 66313. 2.2. The existing primary residence does not have "
        "automatic fire sprinklers. 2.3. The accessory detached dwelling unit does not exceed "
        "1,200 square feet in size."
    ),
}

GOV_CODE_EXCERPT = {
    "match": "65852.2",
    "text": (
        "Government Code Section 65852.2. A local agency shall ministerially approve an "
        "application for an accessory dwelling unit if the unit meets the requirements. "
        "Side and rear setbacks shall be no more than four feet."
    ),
}

BARN_NOISE = {
    "match": "accessory",
    "text": "Agricultural barn and shed structures accessory to farming operations on rural parcels.",
}


class TestRequirements(unittest.TestCase):
    def test_search_archive_filters_barn_noise(self):
        barn_excerpts = search_archive_text(BARN_NOISE["text"], "accessory dwelling ADU 65852 setback")
        self.assertEqual(len(barn_excerpts), 0)

        gov_excerpts = search_archive_text(GOV_CODE_EXCERPT["text"], "accessory dwelling ADU 65852 setback")
        self.assertGreater(len(gov_excerpts), 0)
        self.assertIn("65852", gov_excerpts[0]["text"])

    def test_sprinkler_exception_not_max_size(self):
        reqs = extract_requirements_from_excerpts(
            [SPRINKLER_EXCERPT],
            jurisdiction="California",
            checklist_type="state",
        )
        keys = {r.requirement for r in reqs}
        self.assertIn("sprinkler_exception", keys)
        self.assertNotIn("max_adu_size", keys)
        sprinkler = next(r for r in reqs if r.requirement == "sprinkler_exception")
        self.assertIn("1,200", sprinkler.value or "")

    def test_gov_code_setback_extraction(self):
        reqs = extract_requirements_from_excerpts(
            [GOV_CODE_EXCERPT],
            jurisdiction="California",
            checklist_type="state",
        )
        setback = next((r for r in reqs if r.requirement == "side_rear_setback"), None)
        self.assertIsNotNone(setback)
        self.assertIn("4", setback.value or "")

    def test_checklist_gaps(self):
        reqs = extract_requirements_from_excerpts([GOV_CODE_EXCERPT], "California")
        filled = fill_checklist_gaps(reqs, "state", "California")
        cov = checklist_coverage(filled, "state")
        self.assertGreater(cov["total"], 10)
        self.assertGreaterEqual(cov["found"], 1)

    def test_validate_municipal_crc_mismatch(self):
        profile = resolve_jurisdiction("Los Angeles", "CA")
        sources = [
            {
                "type": "internet_archive_ocr",
                "item_id": "gov.ca.bsc.residential.2025",
                "url": "https://archive.org/download/gov.ca.bsc.residential.2025/gov.ca.bsc.residential.2025_djvu.txt",
            }
        ]
        warnings = validate_sources("municipal", sources, profile)
        self.assertTrue(any("JURISDICTION MISMATCH" in w for w in warnings))

    def test_validate_municipal_official_pass(self):
        profile = resolve_jurisdiction("Los Angeles", "CA")
        sources = [
            {
                "type": "municipal_web",
                "url": "https://planning.lacity.gov/project-review/accessory-dwelling-units",
            }
        ]
        warnings = validate_sources("municipal", sources, profile)
        self.assertFalse(any("JURISDICTION MISMATCH" in w for w in warnings))

    def test_conflict_resolution_state_setback(self):
        municipal = [
            CodeRequirement(
                requirement="rear_setback",
                value="5 feet",
                jurisdiction="Los Angeles",
                confidence=0.8,
            )
        ]
        state = [
            CodeRequirement(
                requirement="rear_setback",
                value="4 feet (state statute floor)",
                jurisdiction="California",
                authority="Gov Code § 65852.2",
                confidence=0.92,
            )
        ]
        merged, notes = _resolve_conflicts(municipal, state)
        rear = next(r for r in merged if r.requirement == "rear_setback")
        self.assertIn("4", rear.value or "")
        self.assertTrue(notes)

    def test_compliance_report_structure(self):
        report = build_compliance_report(
            address="1216 E 92nd St, Los Angeles, CA 90002",
            project_type="Detached ADU",
            municipal_requirements=[],
            state_requirements=extract_requirements_from_excerpts([GOV_CODE_EXCERPT], "California"),
            property_checks=[],
        )
        self.assertIn("Preliminary result", report.preliminary_result)
        self.assertTrue(report.confirmed_requirements or report.unresolved_items)


if __name__ == "__main__":
    unittest.main()
