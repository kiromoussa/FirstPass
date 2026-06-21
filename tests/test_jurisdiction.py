"""Tests for address parsing and jurisdiction resolution."""

from __future__ import annotations

import unittest

from firstpass.jurisdiction import (
    parse_city_from_address,
    parse_state_from_address,
    resolve_from_address,
    resolve_jurisdiction,
    is_official_municipal_source,
)


class TestJurisdiction(unittest.TestCase):
    def test_parse_full_la_address(self):
        self.assertEqual(
            parse_city_from_address("1216 E 92nd St, Los Angeles, CA 90002"),
            "Los Angeles",
        )

    def test_parse_city_state_only(self):
        self.assertEqual(parse_city_from_address("Los Angeles, CA"), "Los Angeles")

    def test_parse_oakland_address(self):
        self.assertEqual(
            parse_city_from_address("700 Rosal Ave, Oakland, CA 94610"),
            "Oakland",
        )

    def test_parse_state(self):
        self.assertEqual(
            parse_state_from_address("1216 E 92nd St, Los Angeles, CA 90002"),
            "CA",
        )

    def test_resolve_los_angeles(self):
        profile = resolve_from_address("1216 E 92nd St, Los Angeles, CA 90002")
        self.assertTrue(profile.supported)
        self.assertEqual(profile.slug, "los_angeles")
        self.assertTrue(any("lacity.gov" in u or "municode.com" in u for u in profile.municipal_seed_urls))
        self.assertEqual(profile.parcel_lookup_url, "https://zimas.lacity.org/")

    def test_resolve_oakland(self):
        profile = resolve_jurisdiction("Oakland", "CA")
        self.assertTrue(profile.supported)
        self.assertEqual(profile.slug, "oakland")

    def test_unsupported_city(self):
        profile = resolve_jurisdiction("Albany", "CA")
        self.assertFalse(profile.supported)
        self.assertIn("not yet configured", profile.unsupported_message or "")

    def test_official_la_source(self):
        profile = resolve_jurisdiction("Los Angeles", "CA")
        self.assertTrue(
            is_official_municipal_source(
                "https://planning.lacity.gov/project-review/accessory-dwelling-units",
                profile,
            )
        )
        self.assertFalse(
            is_official_municipal_source(
                "https://archive.org/details/gov.ca.bsc.residential.2025",
                profile,
            )
        )


if __name__ == "__main__":
    unittest.main()
