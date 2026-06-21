"""Tests for permit package review."""

from __future__ import annotations

import unittest
from pathlib import Path

from firstpass.permit.review import format_permit_package_text, review_permit_package

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "plan_sets"
LA_PARTIAL = FIXTURES / "la_adu_partial"


class TestPermitReview(unittest.TestCase):
    def test_partial_la_package_finds_missing_items(self):
        review = review_permit_package(
            address="1216 E 92nd St, Los Angeles, CA 90002",
            plan_set_path=str(LA_PARTIAL),
            project_type="Detached ADU",
        )

        self.assertEqual(review.city, "Los Angeles")
        self.assertGreater(review.package_completion, 0)
        self.assertLess(review.package_completion, 100)
        self.assertIn("Structural calculations", review.missing_items)
        self.assertIn("Energy compliance form", review.missing_items)

        by_name = {doc.name: doc for doc in review.required_documents}
        self.assertEqual(by_name["Site plan"].status, "found")
        self.assertEqual(by_name["Site plan"].sheet, "A1.0")
        self.assertEqual(by_name["Permit application"].status, "found")
        self.assertEqual(by_name["Structural calculations"].status, "missing")

    def test_submission_portal_present(self):
        review = review_permit_package(
            address="1216 E 92nd St, Los Angeles, CA 90002",
            plan_set_path=str(LA_PARTIAL),
        )
        self.assertIn("LADBS", review.submission_portal)
        self.assertTrue(review.submission_portal_url.startswith("https://"))

    def test_unsupported_city_returns_zero_completion(self):
        review = review_permit_package(
            address="1109 Evelyn Ave, Albany, CA 94706",
            plan_set_path=str(LA_PARTIAL),
        )
        self.assertEqual(review.package_completion, 0)
        self.assertTrue(review.missing_items)

    def test_format_includes_checkmarks(self):
        review = review_permit_package(
            address="1216 E 92nd St, Los Angeles, CA 90002",
            plan_set_path=str(LA_PARTIAL),
        )
        text = format_permit_package_text(review)
        self.assertIn("✓ Site plan", text)
        self.assertIn("✗ Structural calculations", text)
        self.assertIn("MISSING ITEMS", text)

    def test_json_manifest(self):
        manifest = FIXTURES / "manifest_partial.json"
        review = review_permit_package(
            address="1216 E 92nd St, Los Angeles, CA 90002",
            plan_set_path=str(manifest),
        )
        self.assertEqual(review.required_documents[0].name, "Site plan")
        self.assertEqual(review.required_documents[0].status, "found")


if __name__ == "__main__":
    unittest.main()
