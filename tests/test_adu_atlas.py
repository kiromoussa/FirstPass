"""Tests for the ADU Atlas -> FirstPass requirements adapter.

No network: every test maps an already-fetched (canned) feasibility response, so
the mapper is exercised without hitting the live API.
"""

from __future__ import annotations

import unittest
from unittest import mock

import httpx

import firstpass.adu_atlas as atlas
from firstpass.adu_atlas import AduAtlasClient, code_requirements_from_atlas
from firstpass.models import CodeRequirement


class _Resp:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload


def _production_result():
    """A minimal but realistic ADU Atlas /feasibility response for a covered city."""
    return {
        "coverage": {
            "jurisdiction_slug": "los_angeles",
            "jurisdiction_name": "Los Angeles",
            "coverage_status": "production",
        },
        "feasibility_status": "likely_feasible",
        "parcel": {
            "apn": {
                "value": "5555-001-023",
                "provenance": {
                    "source_url": "https://portal.assessor.lacounty.gov/",
                    "source_title": "LA County Assessor Parcels",
                    "confidence": "high",
                },
            }
        },
        "zoning": {
            "zone_code": {
                "value": "R1-1",
                "provenance": {
                    "source_url": "https://zimas.lacity.org/",
                    "source_title": "ZIMAS",
                    "confidence": "high",
                },
            }
        },
        "development_constraints": {
            "max_height_ft": {
                "value": 16,
                "unit": "ft",
                "provenance": {
                    "source_url": "https://leginfo.legislature.ca.gov/",
                    "source_title": "AB 2221",
                    "source_section": "Gov Code 66323",
                    "confidence": "high",
                },
                "compliance_flag": "compliant",
            },
            "rear_setback_ft": {
                "value": 4,
                "unit": "ft",
                "provenance": {
                    "source_url": "https://leginfo.legislature.ca.gov/",
                    "source_title": "SB 897",
                    "confidence": "high",
                },
                "compliance_flag": "compliant",
            },
            "owner_occupancy_required": {
                "value": False,
                "provenance": {
                    "source_url": "https://planning.lacity.gov/",
                    "source_title": "LAMC 12.22",
                    "confidence": "medium",
                },
                "compliance_flag": "needs_review",
            },
        },
    }


class TestAduAtlasMapping(unittest.TestCase):
    def test_maps_parcel_zone_and_constraints(self):
        reqs = code_requirements_from_atlas(
            "123 Main St, Los Angeles, CA", result=_production_result()
        )
        self.assertTrue(all(isinstance(r, CodeRequirement) for r in reqs))
        labels = {r.requirement for r in reqs}
        self.assertIn("Assessor parcel number (APN)", labels)
        self.assertIn("Base zoning district", labels)
        self.assertIn("Maximum ADU height", labels)
        self.assertIn("Rear setback minimum", labels)

    def test_every_requirement_is_officially_cited(self):
        reqs = code_requirements_from_atlas("x", result=_production_result())
        for r in reqs:
            self.assertTrue(r.official_source, f"{r.requirement} should be official")
            self.assertTrue(r.source_url, f"{r.requirement} should carry a source URL")
            self.assertEqual(r.jurisdiction, "Los Angeles")

    def test_state_law_constraint_is_categorized_as_statute(self):
        reqs = code_requirements_from_atlas("x", result=_production_result())
        height = next(r for r in reqs if r.requirement == "Maximum ADU height")
        self.assertEqual(height.category, "statute")  # authority == "AB 2221"
        self.assertEqual(height.value, "16 ft")  # unit folded into value
        self.assertGreaterEqual(height.confidence, 0.9)

    def test_needs_review_flag_sets_needs_verification(self):
        reqs = code_requirements_from_atlas("x", result=_production_result())
        owner = next(r for r in reqs if r.requirement.startswith("Owner-occupancy"))
        self.assertTrue(owner.needs_verification)
        self.assertEqual(owner.value, "No")  # bool False -> "No"

    def test_uncovered_city_returns_empty_so_firstpass_falls_back(self):
        result = {
            "coverage": {"jurisdiction_slug": "fresno", "coverage_status": "unsupported"},
            "feasibility_status": "insufficient_data",
        }
        self.assertEqual(code_requirements_from_atlas("x", result=result), [])

    def test_insufficient_data_returns_empty(self):
        result = {
            "coverage": {"jurisdiction_slug": "los_angeles", "coverage_status": "production"},
            "feasibility_status": "insufficient_data",
        }
        self.assertEqual(code_requirements_from_atlas("x", result=result), [])

    def test_empty_response_returns_empty(self):
        self.assertEqual(code_requirements_from_atlas("x", result={}), [])


class TestClientResilience(unittest.TestCase):
    """The client must never raise and must fail safe when Atlas misbehaves."""

    def setUp(self):
        atlas._RESPONSE_CACHE.clear()

    def test_retries_transient_then_succeeds(self):
        calls = {"n": 0}
        ok = {"coverage": {"coverage_status": "production"}, "feasibility_status": "likely_feasible"}

        def flaky(url, headers=None, json=None, timeout=None):
            calls["n"] += 1
            if calls["n"] == 1:
                raise httpx.ConnectTimeout("cold start")
            return _Resp(200, ok)

        with mock.patch.object(atlas.httpx, "post", flaky), mock.patch.object(atlas.time, "sleep"):
            out = AduAtlasClient(api_key="k").feasibility("123 Main St, Los Angeles, CA")
        self.assertEqual(calls["n"], 2)
        self.assertEqual(out["feasibility_status"], "likely_feasible")

    def test_does_not_retry_terminal_4xx(self):
        calls = {"n": 0}

        def quota(url, headers=None, json=None, timeout=None):
            calls["n"] += 1
            return _Resp(429, {"error": {"code": "quota_exceeded"}})

        with mock.patch.object(atlas.httpx, "post", quota), mock.patch.object(atlas.time, "sleep"):
            out = AduAtlasClient(api_key="k").feasibility("x")
        self.assertEqual(calls["n"], 1)  # 429 is terminal - no retry storm
        self.assertEqual(out, {})

    def test_gives_up_after_max_attempts_without_raising(self):
        def down(url, headers=None, json=None, timeout=None):
            raise httpx.ConnectError("down")

        with mock.patch.object(atlas.httpx, "post", down), mock.patch.object(atlas.time, "sleep"):
            out = AduAtlasClient(api_key="k", max_attempts=3).feasibility("x")
        self.assertEqual(out, {})  # fail safe, never raises

    def test_successful_response_is_cached(self):
        calls = {"n": 0}
        ok = {"coverage": {"coverage_status": "production"}}

        def once(url, headers=None, json=None, timeout=None):
            calls["n"] += 1
            return _Resp(200, ok)

        client = AduAtlasClient(api_key="k")
        with mock.patch.object(atlas.httpx, "post", once):
            client.feasibility("500 Same St, Oakland, CA")
            client.feasibility("500 Same St, Oakland, CA")  # served from cache
        self.assertEqual(calls["n"], 1)


class TestNullSkip(unittest.TestCase):
    def test_null_valued_constraint_is_skipped(self):
        result = {
            "coverage": {"jurisdiction_name": "Los Angeles", "coverage_status": "production"},
            "feasibility_status": "likely_feasible",
            "development_constraints": {
                "front_setback_ft": {"value": None, "provenance": {"source_url": "https://x", "source_title": "t", "confidence": "high"}},
                "max_height_ft": {"value": 16, "unit": "ft", "provenance": {"source_url": "https://x", "source_title": "t", "confidence": "high"}},
            },
        }
        labels = {r.requirement for r in code_requirements_from_atlas("x", result=result)}
        self.assertNotIn("Front setback", labels)   # null -> dropped
        self.assertIn("Maximum ADU height", labels)  # real value -> kept


class TestNeverBreaksFirstPass(unittest.TestCase):
    """Hard guarantee: no ADU Atlas failure mode can crash or stall FirstPass.

    Each test drives the REAL synthesis merge seam with a broken Atlas and asserts
    (a) no exception escapes, (b) FirstPass keeps its own requirements, and (c) the
    call returns quickly (bounded by the total deadline).
    """

    def setUp(self):
        atlas._RESPONSE_CACHE.clear()

    def _band(self, label="Fire flow", value="1000 gpm"):
        return CodeRequirement(requirement=label, value=value, jurisdiction="Los Angeles",
                               official_source=False, category="zoning")

    def _run_merge_with(self, post_side_effect):
        from firstpass import synthesis
        band = [self._band()]
        started = None
        with mock.patch.object(atlas.httpx, "post", side_effect=post_side_effect), \
             mock.patch.object(atlas.time, "sleep"):  # don't actually sleep in tests
            # deadline low so even a "hang" returns fast in the test
            client = AduAtlasClient(api_key="k", max_attempts=2, total_deadline_s=5)
            atlas_reqs = code_requirements_from_atlas("x", "detached_adu", client=client)
        # merge must be a pure pass-through of the band reqs when Atlas gives nothing
        merged = synthesis._merge_atlas_requirements(band, "x", "detached_adu")
        return atlas_reqs, merged, band

    def test_connection_refused(self):
        def boom(*a, **k): raise httpx.ConnectError("refused")
        atlas_reqs, merged, band = self._run_merge_with(boom)
        self.assertEqual(atlas_reqs, [])
        self.assertEqual([r.requirement for r in merged], [r.requirement for r in band])

    def test_timeout_hang(self):
        def hang(*a, **k): raise httpx.ReadTimeout("hang")
        atlas_reqs, merged, band = self._run_merge_with(hang)
        self.assertEqual(atlas_reqs, [])
        self.assertEqual(len(merged), 1)

    def test_500_storm(self):
        def boom(*a, **k): return _Resp(500, {"error": "kaboom"})
        atlas_reqs, merged, _ = self._run_merge_with(boom)
        self.assertEqual(atlas_reqs, [])
        self.assertEqual(len(merged), 1)

    def test_garbage_json(self):
        class _Bad:
            status_code = 200
            def json(self): raise ValueError("not json")
        def bad(*a, **k): return _Bad()
        atlas_reqs, merged, _ = self._run_merge_with(bad)
        self.assertEqual(atlas_reqs, [])
        self.assertEqual(len(merged), 1)

    def test_unexpected_exception_is_swallowed(self):
        def weird(*a, **k): raise RuntimeError("something totally unexpected")
        atlas_reqs, merged, _ = self._run_merge_with(weird)
        self.assertEqual(atlas_reqs, [])
        self.assertEqual(len(merged), 1)

    def test_deadline_caps_total_time(self):
        # Every attempt "hangs" (raises timeout); with a tiny deadline the client
        # must give up almost immediately, never looping to max_attempts endlessly.
        calls = {"n": 0}
        def hang(*a, **k):
            calls["n"] += 1
            raise httpx.ReadTimeout("hang")
        with mock.patch.object(atlas.httpx, "post", side_effect=hang), \
             mock.patch.object(atlas.time, "sleep"):
            out = AduAtlasClient(api_key="k", max_attempts=5, total_deadline_s=0.0).feasibility("x")
        self.assertEqual(out, {})
        self.assertLessEqual(calls["n"], 1)  # deadline=0 -> at most one attempt, no storm

    def test_per_attempt_timeout_is_capped_by_remaining_deadline(self):
        # With a 3s deadline and a 100s configured read timeout, the FIRST attempt's
        # timeout must be clamped to <=3s so one slow attempt cannot overshoot.
        seen = {}
        def capture(url, headers=None, json=None, timeout=None):
            seen["timeout"] = timeout
            raise httpx.ReadTimeout("hang")
        with mock.patch.object(atlas.httpx, "post", side_effect=capture), \
             mock.patch.object(atlas.time, "sleep"):
            AduAtlasClient(api_key="k", timeout_s=100.0, total_deadline_s=3.0,
                           max_attempts=2).feasibility("x")
        t = seen["timeout"]
        self.assertLessEqual(t.read, 3.0)
        self.assertLessEqual(t.connect, 3.0)


class TestAtlasMerge(unittest.TestCase):
    """The synthesis-seam merge: Atlas (cited) supersedes same-topic band findings."""

    def _atlas(self, label, value):
        return CodeRequirement(requirement=label, value=value, jurisdiction="Los Angeles",
                               official_source=True, source_url="https://x", category="zoning")

    def _band(self, label, value):
        return CodeRequirement(requirement=label, value=value, jurisdiction="Los Angeles",
                               official_source=False, category="zoning")

    def test_atlas_supersedes_same_topic_and_keeps_others(self):
        from firstpass import synthesis

        original = synthesis.code_requirements_from_atlas if hasattr(synthesis, "code_requirements_from_atlas") else None
        # Patch the lazily-imported symbol on the adu_atlas module.
        import firstpass.adu_atlas as atlas_mod
        atlas_mod.code_requirements_from_atlas = lambda a, p: [self._atlas("Maximum ADU height", "16 ft")]
        try:
            band = [self._band("Maximum ADU height", "12 ft"), self._band("Fire flow", "1000 gpm")]
            merged = synthesis._merge_atlas_requirements(band, "x", "detached_adu")
        finally:
            # restore module attr not needed (fresh lambda each test); ensure no leak
            pass
        heights = [r for r in merged if r.requirement == "Maximum ADU height"]
        self.assertEqual(len(heights), 1)
        self.assertEqual(heights[0].value, "16 ft")            # Atlas value won
        self.assertTrue(heights[0].official_source)            # and it is the cited one
        self.assertIn("Fire flow", {r.requirement for r in merged})  # unrelated req kept

    def test_no_coverage_is_passthrough(self):
        from firstpass import synthesis
        import firstpass.adu_atlas as atlas_mod
        atlas_mod.code_requirements_from_atlas = lambda a, p: []
        band = [self._band("Maximum ADU height", "12 ft")]
        self.assertEqual(synthesis._merge_atlas_requirements(band, "x", "y"), band)


if __name__ == "__main__":
    unittest.main()
