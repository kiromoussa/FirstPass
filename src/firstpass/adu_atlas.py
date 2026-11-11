"""ADU Atlas integration - deterministic, source-cited zoning/ADU requirements.

ADU Atlas (https://adu-atlas-api.onrender.com) is a California parcel-feasibility
API: send an address + project type, get back parcel + zoning context and the
ADU / JADU / SB 9 development standards (height, setbacks, size, parking,
owner-occupancy, permit timeline, fire-sprinkler trigger), each carrying an
official source citation and a state-baseline compliance flag. It is deterministic
(no LLM on its request path) and covers 8 CA cities (Los Angeles, San Diego, San
Jose, San Francisco, Sacramento, Long Beach, Irvine, Oakland).

For FirstPass this is a fast, cited SOURCE for the objective site/zoning standards
its jurisdiction + requirements stage needs, instead of re-deriving them with the
band research agents. Use it as the first pass on the requirements pass:

    from firstpass.adu_atlas import code_requirements_from_atlas
    reqs = code_requirements_from_atlas(address, project_type="detached_adu")
    # merge `reqs` (official_source=True) ahead of the band-agent findings.

When ADU Atlas has no coverage for the address (a city it does not serve, or an
address it cannot resolve) the mapper returns an empty list, so FirstPass simply
falls back to its existing research pipeline. It never fabricates a requirement.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Optional

import httpx

from firstpass.models import CodeRequirement

logger = logging.getLogger("firstpass.adu_atlas")


def _env_float(name: str, default: float) -> float:
    """Read a float from the environment, falling back to default on any error."""
    try:
        raw = os.environ.get(name)
        return float(raw) if raw is not None else default
    except (TypeError, ValueError):
        return default

# Process-wide cache of feasibility responses, keyed by (base_url, address,
# project_type). ADU Atlas responses are deterministic, so within a run the same
# address never needs a second network call. Empty {} results are NOT cached, so a
# transient failure does not get stuck.
_RESPONSE_CACHE: dict[tuple[str, str, str], dict[str, Any]] = {}

# ADU Atlas project types (mirror the API enum). FirstPass "ADU" projects map to
# detached_adu by default; callers may pass a more specific type.
ATLAS_PROJECT_TYPES = {
    "detached_adu", "attached_adu", "garage_conversion",
    "jadu", "sb9_duplex", "sb9_urban_lot_split",
}

_CONFIDENCE_TO_FLOAT = {"high": 0.9, "medium": 0.7, "low": 0.5}

# Human-readable labels for the ADU Atlas development-constraint field keys.
_CONSTRAINT_LABELS = {
    "max_height_ft": "Maximum ADU height",
    "max_height_detached_standard_ft": "Maximum detached ADU height",
    "max_height_attached_ft": "Maximum attached ADU height",
    "max_size_sqft": "Maximum ADU size",
    "max_size_sqft_general_cap": "Maximum ADU size (general cap)",
    "side_setback_ft": "Side setback minimum",
    "rear_setback_ft": "Rear setback minimum",
    "side_rear_setback_ft": "Side/rear setback minimum",
    "side_rear_setback_min_ft": "Side/rear setback minimum",
    "front_setback_ft": "Front setback",
    "parking_required": "Parking required for ADU",
    "owner_occupancy_required": "Owner-occupancy required (ADU)",
    "owner_occupancy_required_adu": "Owner-occupancy required (ADU)",
    "permit_review_days": "Permit review time limit (days)",
    "impact_fee_exempt_sqft_threshold": "Impact-fee exemption size threshold",
    "fire_sprinkler_required": "Fire sprinkler trigger",
    "fire_sprinkler_trigger": "Fire sprinkler trigger",
}


class AduAtlasClient:
    """Thin httpx client for the ADU Atlas API (direct key or RapidAPI gateway)."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        rapidapi_host: Optional[str] = None,
        timeout_s: float = 12.0,
        connect_timeout_s: float = 5.0,
        max_attempts: int = 2,
        total_deadline_s: float = 15.0,
        use_cache: bool = True,
    ) -> None:
        self.base_url = (base_url or os.environ.get(
            "ADU_ATLAS_BASE_URL", "https://adu-atlas-api.onrender.com/v1"
        )).rstrip("/")
        self.api_key = api_key or os.environ.get("ADU_ATLAS_API_KEY") or os.environ.get("RAPIDAPI_KEY")
        self.rapidapi_host = rapidapi_host or os.environ.get("ADU_ATLAS_RAPIDAPI_HOST")
        # Per-request read/connect timeout (env-overridable for slow networks).
        timeout_s = _env_float("ADU_ATLAS_TIMEOUT_S", timeout_s)
        self.timeout = httpx.Timeout(timeout_s, connect=connect_timeout_s)
        self.max_attempts = max(1, max_attempts)
        # HARD ceiling on total wall-clock across all attempts. This is the
        # guarantee that ADU Atlas can never stall FirstPass: once this many
        # seconds have elapsed we stop retrying and return {} so FirstPass
        # proceeds with its own pipeline. Env-overridable via ADU_ATLAS_DEADLINE_S.
        self.total_deadline_s = _env_float("ADU_ATLAS_DEADLINE_S", total_deadline_s)
        self.use_cache = use_cache

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.rapidapi_host and self.api_key:
            h["X-RapidAPI-Key"] = self.api_key
            h["X-RapidAPI-Host"] = self.rapidapi_host
        elif self.api_key:
            h["X-API-Key"] = self.api_key
        return h

    def feasibility(self, address: str, project_type: str = "detached_adu") -> dict[str, Any]:
        """POST /feasibility, resiliently. Returns parsed JSON, or {} on any failure.

        Never raises: FirstPass must not break when Atlas is cold, slow, rate-
        limited, or down. Retries transient failures (cold-start timeout, connect
        error, 5xx) with backoff; does NOT retry 4xx (bad request / auth / quota),
        which are terminal. Successful responses are cached per process.
        """
        if project_type not in ATLAS_PROJECT_TYPES:
            project_type = "detached_adu"
        cache_key = (self.base_url, address.strip().lower(), project_type)
        if self.use_cache and cache_key in _RESPONSE_CACHE:
            return _RESPONSE_CACHE[cache_key]

        url = f"{self.base_url}/feasibility"
        payload = {"address": address, "project_type": project_type}
        last_err = ""
        started = time.monotonic()
        for attempt in range(self.max_attempts):
            # Enforce the hard total deadline before spending another attempt, and
            # cap THIS attempt's timeout to the remaining budget so a single slow
            # attempt cannot overshoot the ceiling. This is what makes
            # total_deadline_s a true wall-clock guarantee for FirstPass.
            remaining = self.total_deadline_s - (time.monotonic() - started)
            if remaining <= 0:
                last_err = "deadline_exceeded"
                break
            attempt_timeout = httpx.Timeout(
                min(self.timeout.read or remaining, remaining),
                connect=min(self.timeout.connect or remaining, remaining),
            )
            try:
                resp = httpx.post(url, headers=self._headers(), json=payload, timeout=attempt_timeout)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_err = f"{type(exc).__name__}"  # transient -> retry
            except Exception as exc:  # absolutely never propagate to FirstPass
                logger.warning("ADU Atlas unexpected error for %s: %s", address, type(exc).__name__)
                return {}
            else:
                if resp.status_code < 400:
                    try:
                        data = resp.json()
                    except Exception:  # malformed body -> treat as no data
                        return {}
                    if self.use_cache:
                        _RESPONSE_CACHE[cache_key] = data
                    return data
                if resp.status_code < 500:
                    # 400/401/403/404/422/429 are terminal; do not retry or spin.
                    logger.warning("ADU Atlas %s for %s (no retry)", resp.status_code, address)
                    return {}
                last_err = f"HTTP {resp.status_code}"  # 5xx -> retry
            # Back off before the next attempt, but never past the deadline.
            if attempt < self.max_attempts - 1:
                backoff = 0.5 * (2 ** attempt)
                remaining = self.total_deadline_s - (time.monotonic() - started)
                if remaining <= 0:
                    break
                time.sleep(min(backoff, remaining))
        logger.warning("ADU Atlas unreachable for %s after %d attempts (%s)",
                       address, self.max_attempts, last_err)
        return {}


def _unwrap(field: Any) -> tuple[Any, dict[str, Any]]:
    """ADU Atlas fields are {value, provenance, compliance_flag, ...}; return (value, meta)."""
    if isinstance(field, dict) and ("value" in field or "provenance" in field):
        return field.get("value"), field
    return field, {}


def _format_value(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, bool):
        return "Yes" if value else "No"
    return str(value)


def _requirement_from_field(key: str, field: Any, jurisdiction: str) -> Optional[CodeRequirement]:
    value, meta = _unwrap(field)
    # A field with no usable value is noise for FirstPass (e.g. "Front setback = None").
    if value is None:
        return None
    prov = meta.get("provenance") or {}
    authority = prov.get("source_title") or ""
    is_statute = any(t in authority for t in ("AB ", "SB ", "Gov", "Gov."))
    flag = meta.get("compliance_flag")
    formatted = _format_value(value)
    unit = meta.get("unit")
    if formatted is not None and unit and not isinstance(value, bool):
        formatted = f"{formatted} {unit}"
    return CodeRequirement(
        requirement=_CONSTRAINT_LABELS.get(key, key.replace("_", " ").strip().capitalize()),
        value=formatted,
        jurisdiction=jurisdiction,
        authority=authority,
        source_url=prov.get("source_url", "") or "",
        official_source=bool(prov.get("source_url")),
        applies_to_project=True,
        applicability_reason="Resolved from the parcel's zoning via ADU Atlas.",
        confidence=_CONFIDENCE_TO_FLOAT.get((prov.get("confidence") or "medium"), 0.7),
        quoted_text=(prov.get("source_section") or meta.get("note") or "") or "",
        needs_verification=flag in ("needs_review", "possibly_more_restrictive_than_state_baseline"),
        category="statute" if is_statute else "zoning",
    )


def code_requirements_from_atlas(
    address: str,
    project_type: str = "detached_adu",
    client: Optional[AduAtlasClient] = None,
    result: Optional[dict[str, Any]] = None,
) -> list[CodeRequirement]:
    """Map an ADU Atlas feasibility result into FirstPass CodeRequirements.

    Pass ``result`` to map an already-fetched response (used in tests); otherwise a
    live call is made via ``client`` (or a default client). Returns [] when ADU
    Atlas has no coverage / cannot resolve the address, so FirstPass falls back to
    its own research pipeline. Never fabricates a requirement.
    """
    if result is None:
        client = client or AduAtlasClient()
        result = client.feasibility(address, project_type)
    if not result:
        return []

    coverage = result.get("coverage") or {}
    jurisdiction = coverage.get("jurisdiction_name") or coverage.get("jurisdiction_slug") or ""
    # Only trust results from a covered/production jurisdiction with a real parcel.
    if coverage.get("coverage_status") != "production":
        return []
    if result.get("feasibility_status") == "insufficient_data":
        return []

    reqs: list[CodeRequirement] = []

    # Parcel + zoning facts (category: parcel / zoning).
    parcel = result.get("parcel") or {}
    apn, apn_meta = _unwrap(parcel.get("apn"))
    if apn:
        prov = (apn_meta.get("provenance") or {})
        reqs.append(CodeRequirement(
            requirement="Assessor parcel number (APN)", value=str(apn),
            jurisdiction=jurisdiction, authority=prov.get("source_title", ""),
            source_url=prov.get("source_url", "") or "", official_source=bool(prov.get("source_url")),
            confidence=0.95, category="parcel",
            applicability_reason="Parcel matched by geocoded point via ADU Atlas.",
        ))
    zoning = result.get("zoning") or {}
    zone, zmeta = _unwrap(zoning.get("zone_code"))
    if zone:
        prov = (zmeta.get("provenance") or {})
        reqs.append(CodeRequirement(
            requirement="Base zoning district", value=str(zone),
            jurisdiction=jurisdiction, authority=prov.get("source_title", ""),
            source_url=prov.get("source_url", "") or "", official_source=bool(prov.get("source_url")),
            confidence=0.9, category="zoning",
            applicability_reason="Zoning district resolved by spatial join via ADU Atlas.",
        ))

    # Development constraints -> requirements.
    for key, field in (result.get("development_constraints") or {}).items():
        req = _requirement_from_field(key, field, jurisdiction)
        if req is not None:
            reqs.append(req)

    return reqs
