"""Deterministic extraction of structured ADU requirements from scrape excerpts."""

from __future__ import annotations

import json
import re
from pathlib import Path

from firstpass.models import ADU_CHECKLIST, CodeRequirement

OUTPUT_DIR = Path(__file__).resolve().parents[2] / "output"

# Regex patterns mapping to requirement keys
REQUIREMENT_PATTERNS: list[tuple[str, str, str, float]] = [
    # (requirement_key, regex, category, confidence)
    (r"ministerial", r"ministerial(?:ly)?\s+(?:review|approval|permit)", "statute", 0.9),
    (r"side_rear_setback", r"(?:side\s+and\s+rear\s+)?setbacks?\s+shall\s+be\s+no\s+more\s+than\s+four\s+feet", "statute", 0.93),
    (r"side_rear_setback", r"setback[s]?\s+(?:of\s+)?(?:four|4)\s+(?:feet|foot|ft)", "statute", 0.88),
    (r"rear_setback", r"rear\s+setback[s]?\s+(?:of\s+)?(\d[\d\s\-/]*(?:feet|foot|ft|'))", "zoning", 0.85),
    (r"side_setback", r"side\s+setback[s]?\s+(?:of\s+)?(\d[\d\s\-/]*(?:feet|foot|ft|'))", "zoning", 0.85),
    (r"front_setback", r"front\s+setback[s]?\s+(?:of\s+)?(\d[\d\s\-/]*(?:feet|foot|ft|'))", "zoning", 0.85),
    (r"max_height", r"(?:maximum|max\.?)\s+height[\s:of]*\s*(\d[\d\s\-/]*(?:feet|foot|ft|'))", "zoning", 0.85),
    (r"max_height", r"height\s+(?:not\s+(?:to\s+)?)?exceed[s]?\s+(\d[\d\s\-/]*(?:feet|foot|ft|'))", "zoning", 0.8),
    (r"lot_coverage", r"lot\s+coverage[\s:of]*\s*(\d[\d.]+%?)", "zoning", 0.85),
    (r"max_adu_size", r"(?:maximum|max\.?)\s+(?:size|floor\s+area)[\s:of]*\s*(\d[\d,]*\s*(?:square\s+feet|sq\.?\s*ft\.?|sf))", "zoning", 0.8),
    (r"parking", r"parking\s+(?:shall|must|is\s+not\s+required|not\s+required|exempt)", "statute", 0.85),
    (r"parking_exemption", r"(?:no\s+parking|parking\s+(?:is\s+)?not\s+required|parking\s+exempt)", "statute", 0.88),
    (r"owner_occupancy", r"owner[\s-]*occup", "statute", 0.85),
    (r"impact_fees", r"impact\s+fee", "statute", 0.8),
    (r"utility_connection", r"utility\s+connection", "statute", 0.75),
    (r"replacement_parking", r"replacement\s+parking", "statute", 0.85),
    (r"multifamily_adu", r"multifamily.*accessory\s+dwelling|adu.*multifamily", "statute", 0.8),
    (r"local_preemption", r"(?:shall\s+not|may\s+not)\s+(?:deny|prohibit|impose).*adu|preempt", "statute", 0.85),
    (r"adu_definition", r"accessory\s+dwelling\s+unit.*(?:attached|detached|independent\s+living)", "building", 0.9),
    (r"sprinkler_exception", r"sprinkler.*accessory\s+dwelling|accessory\s+dwelling.*sprinkler|R309\.2", "building", 0.92),
    (r"ministerial_approval", r"65852\.2|66352", "statute", 0.9),
    (r"max_review_time", r"(?:60|sixty)\s+(?:day|calendar\s+day)", "statute", 0.85),
    (r"min_adu_size", r"(?:minimum|min\.?)\s+(?:size|floor\s+area)[\s:of]*\s*(\d[\d,]*\s*(?:square\s+feet|sq\.?\s*ft\.?|sf))", "statute", 0.85),
    (r"height_protection", r"height.*(?:shall\s+not|may\s+not)\s+(?:require|impose)", "statute", 0.8),
    (r"coastal_fire_exceptions", r"(?:coastal|fire\s+hazard|very\s+high\s+fire)", "statute", 0.75),
    (r"ladbs_requirements", r"ladbs|department\s+of\s+building\s+and\s+safety", "zoning", 0.7),
    (r"base_zoning", r"(?:base\s+)?(?:zone|zoning)[\s:of]*\s*([A-Z][A-Z0-9\-]+)", "zoning", 0.7),
    (r"overlay_zones", r"overlay\s+(?:zone|district)", "zoning", 0.75),
    (r"historic_district", r"historic\s+(?:district|preservation|resource)", "zoning", 0.8),
    (r"fire_flood_restrictions", r"(?:flood|fire\s+hazard|special\s+district)", "zoning", 0.75),
]

GOV_CODE_SECTION = re.compile(r"(?:gov(?:ernment)?\.?\s*code|§)\s*(65852(?:\.\d+)?|663(?:1\d|2\d|3\d|4[0-2]))", re.I)
CRC_SECTION = re.compile(r"\bR\d{3}(?:\.\d+)?\b")
LAMC_SECTION = re.compile(r"(?:LAMC|§)\s*(\d{1,2}\.\d{2}\.\d{2}[A-Z]?|\d{1,2}-\d+\.\d+)", re.I)


def _extract_authority(text: str) -> str:
    gov = GOV_CODE_SECTION.search(text)
    if gov:
        return f"Gov Code § {gov.group(1)}"
    lamc = LAMC_SECTION.search(text)
    if lamc:
        return f"LAMC § {lamc.group(1)}"
    crc = CRC_SECTION.search(text)
    if crc:
        return f"CRC {crc.group()}"
    return ""


def _extract_value(text: str, requirement: str) -> str | None:
    lower = text.lower()
    if requirement == "sprinkler_exception":
        size = re.search(r"(\d[\d,]*)\s*(?:square\s+feet|sq\.?\s*ft\.?|sf)", lower)
        if size and "1200" in size.group(1).replace(",", ""):
            return "Sprinklers not required if detached ADU ≤1,200 sq ft and primary has no sprinklers (CRC R309.2 exception — not a general size limit)"
        return "Sprinkler exception may apply (see CRC R309.2)"
    if requirement == "side_rear_setback":
        return "4 feet (state statute floor for side and rear setbacks)"
    if requirement == "adu_definition":
        return "Attached or detached independent living unit on same lot as primary residence"
    if requirement == "ministerial_approval" or requirement == "ministerial":
        return "Ministerial approval required for qualifying ADUs (Gov Code 65852.2 / 66352)"
    if requirement == "parking_exemption":
        if "not required" in lower or "no parking" in lower or "exempt" in lower:
            return "Parking not required (state protection may apply)"
    for _, pattern, _, _ in REQUIREMENT_PATTERNS:
        if _ != requirement:
            continue
        match = re.search(pattern, text, re.I)
        if match:
            if match.groups():
                return match.group(1).strip()
            return match.group(0).strip()[:120]
    return None


def _normalize_key(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower())[:200]


def _dedupe_requirements(requirements: list[CodeRequirement]) -> list[CodeRequirement]:
    seen: dict[str, CodeRequirement] = {}
    for req in requirements:
        key = f"{req.requirement}:{req.jurisdiction}:{_normalize_key(req.quoted_text[:80])}"
        existing = seen.get(req.requirement)
        if existing is None or req.confidence > existing.confidence:
            seen[req.requirement] = req
    return list(seen.values())


def extract_requirements_from_excerpts(
    excerpts: list[dict],
    jurisdiction: str,
    source_url: str = "",
    official_source: bool = False,
    checklist_type: str = "state",
) -> list[CodeRequirement]:
    """Map excerpt text to structured requirements."""
    requirements: list[CodeRequirement] = []

    for ex in excerpts:
        text = ex.get("text", "")
        if not text:
            continue
        lower = text.lower()

        for req_key, pattern, category, confidence in REQUIREMENT_PATTERNS:
            if not re.search(pattern, text, re.I):
                continue

            # Interpretation guard: 1200 sq ft in R309.2 is sprinkler exception, not max size
            if req_key == "max_adu_size" and ("r309" in lower or "sprinkler" in lower):
                req_key = "sprinkler_exception"
                category = "building"
                confidence = 0.92

            value = _extract_value(text, req_key)
            authority = _extract_authority(text)

            requirements.append(
                CodeRequirement(
                    requirement=req_key,
                    value=value,
                    jurisdiction=jurisdiction,
                    authority=authority,
                    source_url=source_url or ex.get("source_url", ""),
                    official_source=official_source,
                    applies_to_project=True,
                    applicability_reason=f"Matched in excerpt: {ex.get('match', '')}",
                    confidence=confidence,
                    quoted_text=text[:500],
                    needs_verification=confidence < 0.85,
                    category=category,
                )
            )

    return _dedupe_requirements(requirements)


def fill_checklist_gaps(
    requirements: list[CodeRequirement],
    checklist_type: str,
    jurisdiction: str,
) -> list[CodeRequirement]:
    """Add placeholder entries for missing checklist items."""
    found = {r.requirement for r in requirements}
    checklist = ADU_CHECKLIST.get(checklist_type, [])
    result = list(requirements)
    for key in checklist:
        if key not in found:
            result.append(
                CodeRequirement(
                    requirement=key,
                    value=None,
                    jurisdiction=jurisdiction,
                    authority="",
                    source_url="",
                    official_source=False,
                    applies_to_project=True,
                    applicability_reason="Not found in scraped sources",
                    confidence=0.0,
                    quoted_text="",
                    needs_verification=True,
                    category="unknown",
                )
            )
    return result


def checklist_coverage(requirements: list[CodeRequirement], checklist_type: str) -> dict[str, int]:
    checklist = ADU_CHECKLIST.get(checklist_type, [])
    found = sum(1 for r in requirements if r.requirement in checklist and r.value is not None)
    unknown = sum(1 for r in requirements if r.requirement in checklist and r.value is None)
    return {"found": found, "unknown": unknown, "total": len(checklist)}


def write_requirements_json(
    requirements: list[CodeRequirement],
    filename: str,
    metadata: dict | None = None,
) -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / filename
    payload = {
        "requirements": [r.model_dump() for r in requirements],
        "metadata": metadata or {},
        "coverage": {},
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return path


def load_requirements_json(filename: str) -> list[CodeRequirement]:
    path = OUTPUT_DIR / filename
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    return [CodeRequirement(**r) for r in data.get("requirements", [])]


def parse_excerpts_from_report(report_text: str) -> list[dict]:
    """Fallback: parse CODE EXCERPTS section from a .txt report."""
    excerpts: list[dict] = []
    if "CODE EXCERPTS" not in report_text:
        return excerpts
    section = report_text.split("CODE EXCERPTS", 1)[1]
    if "DISCLAIMER" in section:
        section = section.split("DISCLAIMER", 1)[0]
    blocks = re.split(r"--- Excerpt \d+ \(match: ([^)]+)\) ---", section)
    for i in range(1, len(blocks), 2):
        match = blocks[i].strip()
        text = blocks[i + 1].strip() if i + 1 < len(blocks) else ""
        if text:
            excerpts.append({"match": match, "text": text})
    return excerpts
