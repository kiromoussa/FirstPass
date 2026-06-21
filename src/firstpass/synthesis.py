"""Merge structured requirements into permit-ready compliance reports."""

from __future__ import annotations

import json
from pathlib import Path

from firstpass.models import CodeRequirement, ComplianceReport, PropertyCheck
from firstpass.parcel_lookup import lookup_property_checks
from firstpass.requirements import (
    checklist_coverage,
    load_requirements_json,
    parse_excerpts_from_report,
    extract_requirements_from_excerpts,
)

OUTPUT_DIR = Path(__file__).resolve().parents[2] / "output"

# State statute topics that generally preempt stricter local rules
STATE_PREEMPTED = {
    "side_rear_setback",
    "side_setback",
    "rear_setback",
    "parking",
    "parking_exemption",
    "ministerial_approval",
    "min_adu_size",
    "owner_occupancy",
    "max_review_time",
}

LOCAL_CONTROLS = {
    "base_zoning",
    "overlay_zones",
    "max_height",
    "lot_coverage",
    "floor_area_ratio",
    "max_adu_size",
    "front_setback",
    "historic_district",
    "fire_flood_restrictions",
}


def _dedupe_by_requirement(requirements: list[CodeRequirement]) -> list[CodeRequirement]:
    best: dict[str, CodeRequirement] = {}
    for req in requirements:
        if req.value is None:
            continue
        existing = best.get(req.requirement)
        if existing is None or req.confidence > existing.confidence:
            best[req.requirement] = req
    return list(best.values())


def _resolve_conflicts(
    municipal: list[CodeRequirement],
    state: list[CodeRequirement],
) -> tuple[list[CodeRequirement], list[str]]:
    """Pick controlling rule per requirement key."""
    notes: list[str] = []
    merged: dict[str, CodeRequirement] = {}

    for req in state:
        if req.value is not None:
            merged[req.requirement] = req

    for req in municipal:
        if req.value is None:
            continue
        state_req = merged.get(req.requirement)
        if state_req and req.requirement in STATE_PREEMPTED:
            notes.append(
                f"{req.requirement}: state rule ({state_req.authority or state_req.jurisdiction}) "
                f"generally controls over local ({req.authority or req.jurisdiction}). "
                f"State: {state_req.value}; Local: {req.value}."
            )
            if state_req.confidence >= req.confidence:
                merged[req.requirement] = state_req
            else:
                merged[req.requirement] = req
                merged[req.requirement].needs_verification = True
        elif req.requirement in LOCAL_CONTROLS or state_req is None:
            merged[req.requirement] = req
        elif state_req:
            notes.append(
                f"{req.requirement}: both jurisdictions found values — verify controlling rule. "
                f"State: {state_req.value}; Local: {req.value}."
            )
            merged[req.requirement] = state_req if state_req.confidence >= req.confidence else req

    return list(merged.values()), notes


def _top_excerpts(municipal_report: str, state_report: str, limit: int = 5) -> list[dict]:
    excerpts: list[dict] = []
    for label, text in (("municipal", municipal_report), ("state", state_report)):
        for ex in parse_excerpts_from_report(text)[:limit]:
            excerpts.append({"jurisdiction": label, "match": ex.get("match"), "text": ex.get("text", "")[:400]})
    return excerpts


def _format_requirement_line(req: CodeRequirement) -> str:
    auth = f" ({req.authority})" if req.authority else ""
    verify = " [needs verification]" if req.needs_verification else ""
    return f"- {req.requirement.replace('_', ' ').title()}: {req.value}{auth}{verify}"


def build_compliance_report(
    address: str,
    project_type: str,
    municipal_requirements: list[CodeRequirement],
    state_requirements: list[CodeRequirement],
    property_checks: list[PropertyCheck],
    municipal_report: str = "",
    state_report: str = "",
    conflict_notes: list[str] | None = None,
) -> ComplianceReport:
    confirmed, notes = _resolve_conflicts(municipal_requirements, state_requirements)
    if conflict_notes:
        notes.extend(conflict_notes)

    confirmed_with_values = [r for r in confirmed if r.value is not None]
    unresolved = [
        r.requirement.replace("_", " ")
        for r in municipal_requirements + state_requirements
        if r.value is None and r.needs_verification
    ]
    unresolved = list(dict.fromkeys(unresolved))[:15]

    zone_check = next((c for c in property_checks if c.field_name == "Base zone"), None)
    zone_known = zone_check and zone_check.confirmed and zone_check.value != "unknown"

    if confirmed_with_values:
        preliminary = (
            f"Preliminary result: {project_type} appears potentially allowed at this address, "
            f"but {'parcel zoning verified' if zone_known else 'parcel zoning has not been fully verified'}."
        )
    else:
        preliminary = (
            f"Preliminary result: Insufficient confirmed requirements for {project_type}. "
            "Additional municipal and state source research is needed."
        )

    municipal_cov = checklist_coverage(municipal_requirements, "municipal")
    state_cov = checklist_coverage(state_requirements, "state")

    return ComplianceReport(
        address=address,
        project_type=project_type,
        preliminary_result=preliminary,
        confirmed_requirements=sorted(confirmed_with_values, key=lambda r: r.requirement),
        property_checks=property_checks,
        unresolved_items=unresolved,
        conflict_notes=notes,
        supporting_excerpts=_top_excerpts(municipal_report, state_report),
        checklist_coverage={"municipal": municipal_cov["found"], "state": state_cov["found"]},
    )


def format_compliance_text(report: ComplianceReport) -> str:
    lines = [
        f"FINAL CODE SYNTHESIS — {report.project_type}",
        f"Address: {report.address}",
        "",
        report.preliminary_result,
        "",
        "CONFIRMED REQUIREMENTS",
        "---------------------",
    ]
    if report.confirmed_requirements:
        lines.extend(_format_requirement_line(r) for r in report.confirmed_requirements)
    else:
        lines.append("- None confirmed from scraped sources.")

    lines.extend(["", "PROPERTY CHECKS", "---------------"])
    for check in report.property_checks:
        status = "confirmed" if check.confirmed else "unknown"
        lines.append(f"- {check.field_name}: {check.value} ({status})")

    if report.conflict_notes:
        lines.extend(["", "CONFLICT / CONTROL NOTES", "------------------------"])
        lines.extend(f"- {note}" for note in report.conflict_notes)

    if report.unresolved_items:
        lines.extend(["", "UNRESOLVED ITEMS", "----------------"])
        lines.extend(f"- {item}" for item in report.unresolved_items)

    lines.extend(
        [
            "",
            f"Checklist coverage: municipal {report.checklist_coverage.get('municipal', 0)}/"
            f"{len(report.confirmed_requirements)} confirmed; "
            f"state {report.checklist_coverage.get('state', 0)} topics with values.",
            "",
            "SUPPORTING EXCERPTS (abbreviated)",
            "------------------------------",
        ]
    )
    for i, ex in enumerate(report.supporting_excerpts[:8], 1):
        lines.append(f"\n--- {ex['jurisdiction'].title()} excerpt {i} ({ex.get('match', '')}) ---")
        lines.append(ex.get("text", ""))

    lines.extend(
        [
            "",
            "DISCLAIMER",
            "----------",
            "Pre-submission research assistant output. Verify against current official codes "
            "and confirm parcel zoning with the local planning department before submission.",
        ]
    )
    return "\n".join(lines)


def synthesize_from_files(
    address: str,
    project_type: str,
    profile=None,
    use_browserbase: bool = True,
) -> tuple[ComplianceReport, str | None]:
    """Load JSON/txt reports and produce ComplianceReport."""
    from firstpass.jurisdiction import resolve_from_address

    if profile is None:
        profile = resolve_from_address(address)

    municipal_reqs = load_requirements_json("municipal_requirements.json")
    state_reqs = load_requirements_json("state_requirements.json")

    municipal_path = OUTPUT_DIR / "municipal_codes.txt"
    state_path = OUTPUT_DIR / "state_codes.txt"
    municipal_report = municipal_path.read_text(encoding="utf-8") if municipal_path.exists() else ""
    state_report = state_path.read_text(encoding="utf-8") if state_path.exists() else ""

    if not municipal_reqs and municipal_report:
        municipal_reqs = extract_requirements_from_excerpts(
            parse_excerpts_from_report(municipal_report),
            profile.city,
            checklist_type="municipal",
            official_source=True,
        )
    if not state_reqs and state_report:
        state_reqs = extract_requirements_from_excerpts(
            parse_excerpts_from_report(state_report),
            "California",
            checklist_type="state",
        )

    property_checks, zimas_session, _ = lookup_property_checks(address, profile, use_browserbase)

    report = build_compliance_report(
        address=address,
        project_type=project_type,
        municipal_requirements=municipal_reqs,
        state_requirements=state_reqs,
        property_checks=property_checks,
        municipal_report=municipal_report,
        state_report=state_report,
    )

    json_path = OUTPUT_DIR / "compliance_report.json"
    json_path.write_text(report.model_dump_json(indent=2), encoding="utf-8")

    return report, zimas_session


def write_compliance_outputs(
    address: str,
    project_type: str,
    profile=None,
    use_browserbase: bool = True,
) -> dict:
    report, zimas_session = synthesize_from_files(address, project_type, profile, use_browserbase)
    text = format_compliance_text(report)
    if zimas_session:
        text += f"\n\nZIMAS Browserbase Session: {zimas_session}\n"
    return {"report": report, "text": text}
