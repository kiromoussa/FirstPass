"""Compare uploaded plan sets against city permit checklists."""

from __future__ import annotations

import re

from firstpass.permit.checklists import ChecklistItem, PermitChecklist, get_checklist_for_address
from firstpass.permit.models import PermitDocument, PermitPackageReview, SeparateApproval
from firstpass.permit.plan_index import PlanEntry, load_plan_entries


def _normalize_match_text(text: str) -> str:
    return re.sub(r"[_\-]+", " ", text.lower())


def _entry_text(entry: PlanEntry) -> str:
    parts = [entry.label, entry.source]
    if entry.sheet:
        parts.append(entry.sheet)
    return _normalize_match_text(" ".join(parts))


def _matches_keywords(entry: PlanEntry, keywords: tuple[str, ...]) -> bool:
    text = _entry_text(entry)
    return any(_normalize_match_text(keyword) in text for keyword in keywords)


def _matches_sheet_prefix(entry: PlanEntry, prefixes: tuple[str, ...]) -> bool:
    if not entry.sheet or not prefixes:
        return False
    sheet = entry.sheet.upper()
    return any(sheet.startswith(prefix.upper()) for prefix in prefixes)


def _find_match(item: ChecklistItem, entries: list[PlanEntry]) -> PlanEntry | None:
    keyword_matches = [entry for entry in entries if _matches_keywords(entry, item.keywords)]
    if keyword_matches:
        return keyword_matches[0]

    if item.sheet_prefixes:
        prefix_matches = [entry for entry in entries if _matches_sheet_prefix(entry, item.sheet_prefixes)]
        if len(prefix_matches) == 1:
            return prefix_matches[0]

    return None


def _completion_percent(documents: list[PermitDocument]) -> int:
    required = [doc for doc in documents if doc.status != "optional"]
    if not required:
        return 100
    found = sum(1 for doc in required if doc.status == "found")
    return round(found / len(required) * 100)


def review_permit_package(
    address: str,
    plan_set_path: str,
    project_type: str = "Detached ADU",
) -> PermitPackageReview:
    """Compare a plan set against the official permit checklist for the address."""
    checklist, profile = get_checklist_for_address(address)
    entries = load_plan_entries(plan_set_path)

    if checklist is None:
        return PermitPackageReview(
            address=address,
            city=profile.city,
            project_type=project_type,
            permit_application="Unknown — city not configured",
            required_documents=[],
            submission_portal="Contact local building department",
            missing_items=[
                profile.unsupported_message
                or f"No permit checklist configured for {profile.city}."
            ],
            package_completion=0,
            checklist_source="",
        )

    documents: list[PermitDocument] = []
    missing_items: list[str] = []

    for item in checklist.items:
        match = _find_match(item, entries)
        if match:
            documents.append(
                PermitDocument(
                    name=item.name,
                    status="found",
                    sheet=match.sheet,
                    source=match.source or match.label,
                    category=item.category,
                )
            )
        else:
            status = "missing" if item.required else "optional"
            documents.append(
                PermitDocument(
                    name=item.name,
                    status=status,
                    category=item.category,
                )
            )
            if item.required:
                missing_items.append(item.name)

    return PermitPackageReview(
        address=address,
        city=checklist.city,
        project_type=project_type,
        permit_application=checklist.permit_application,
        required_documents=documents,
        submission_portal=checklist.submission_portal,
        submission_portal_url=checklist.submission_portal_url,
        file_naming_rules=list(checklist.file_naming_rules),
        separate_approvals=[
            SeparateApproval(agency=agency, required=required, notes=notes)
            for agency, required, notes in checklist.separate_approvals
        ],
        missing_items=missing_items,
        resubmission_instructions=list(checklist.resubmission_instructions),
        package_completion=_completion_percent(documents),
        checklist_source=checklist.checklist_source,
    )


def format_permit_package_text(review: PermitPackageReview) -> str:
    """Human-readable permit package summary for output/permit_package.txt."""
    lines = [
        f"PERMIT PACKAGE REVIEW — {review.project_type}",
        f"Address: {review.address}",
        f"City: {review.city}",
        f"Permit application: {review.permit_application}",
        f"Package completion: {review.package_completion}%",
        "",
        "REQUIRED PACKAGE",
        "---------------",
    ]

    for doc in review.required_documents:
        mark = "✓" if doc.status == "found" else "✗"
        detail = doc.name
        if doc.sheet:
            detail += f" ({doc.sheet})"
        if doc.source and doc.status == "found":
            detail += f" — {doc.source}"
        lines.append(f"{mark} {detail}")

    lines.extend(
        [
            "",
            "MISSING ITEMS",
            "-------------",
        ]
    )
    if review.missing_items:
        lines.extend(f"- {item}" for item in review.missing_items)
    else:
        lines.append("- None — required documents appear present.")

    lines.extend(
        [
            "",
            "SUBMISSION",
            "----------",
            f"Portal: {review.submission_portal}",
        ]
    )
    if review.submission_portal_url:
        lines.append(f"URL: {review.submission_portal_url}")

    if review.separate_approvals:
        lines.extend(["", "SEPARATE APPROVALS", "------------------"])
        for approval in review.separate_approvals:
            flag = "Required" if approval.required else "Conditional"
            lines.append(f"- {approval.agency}: {flag}")
            if approval.notes:
                lines.append(f"  {approval.notes}")

    if review.file_naming_rules:
        lines.extend(["", "FILE NAMING RULES", "-----------------"])
        lines.extend(f"- {rule}" for rule in review.file_naming_rules)

    if review.resubmission_instructions:
        lines.extend(["", "RESUBMISSION", "------------"])
        lines.extend(f"- {step}" for step in review.resubmission_instructions)

    if review.checklist_source:
        lines.extend(["", f"Checklist source: {review.checklist_source}"])

    return "\n".join(lines) + "\n"
