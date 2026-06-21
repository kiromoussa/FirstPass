"""City-specific ADU permit submission checklists."""

from __future__ import annotations

from dataclasses import dataclass, field

from firstpass.jurisdiction import JurisdictionProfile, resolve_from_address


@dataclass(frozen=True)
class ChecklistItem:
    name: str
    category: str
    keywords: tuple[str, ...]
    sheet_prefixes: tuple[str, ...] = ()
    required: bool = True


@dataclass(frozen=True)
class PermitChecklist:
    city: str
    permit_application: str
    submission_portal: str
    submission_portal_url: str
    checklist_source: str
    items: tuple[ChecklistItem, ...]
    file_naming_rules: tuple[str, ...] = ()
    separate_approvals: tuple[tuple[str, bool, str], ...] = ()
    resubmission_instructions: tuple[str, ...] = ()


def _la_adu_checklist() -> PermitChecklist:
    return PermitChecklist(
        city="Los Angeles",
        permit_application="LADBS Plan Check Application — Accessory Dwelling Unit",
        submission_portal="LADBS ePlanLA / Los Angeles City Building & Safety portal",
        submission_portal_url="https://ladbs.lacity.gov/services/eplanla",
        checklist_source="https://ladbs.lacity.gov/services/accessory-dwelling-units-adu",
        file_naming_rules=(
            "Use sheet numbers on plan sheets (A1.0, S1.0, etc.) in the title block.",
            "PDF filenames should include sheet number and description, e.g. A1.0_Site_Plan.pdf.",
            "Upload one PDF per sheet or a single combined set with a sheet index.",
            "Supporting documents (calculations, forms) use descriptive filenames without sheet numbers.",
        ),
        separate_approvals=(
            ("Planning / Zoning", True, "Required when ADU exceeds size limits or is in a hillside/coastal zone."),
            ("Building / LADBS", True, "Primary plan check and permit issuance."),
            ("Fire", False, "Required when sprinkler system or fire-rated assembly is proposed."),
            ("Utility", False, "Separate utility service or meter upgrade may need LADWP coordination."),
        ),
        resubmission_instructions=(
            "Address every correction notice item before resubmitting.",
            "Highlight changes on revised sheets with clouded revisions.",
            "Include a response letter listing each correction and where it was addressed.",
            "Resubmit through the same ePlanLA project; do not create a duplicate application.",
        ),
        items=(
            ChecklistItem("Site plan", "plan_sheet", ("site plan", "site", "plot plan"), ("A", "C")),
            ChecklistItem("Floor plan", "plan_sheet", ("floor plan", "floor", "layout"), ("A",)),
            ChecklistItem("Elevations", "plan_sheet", ("elevation", "elevations"), ("A",)),
            ChecklistItem("Sections and details", "plan_sheet", ("section", "sections", "detail", "details"), ("A",)),
            ChecklistItem("Structural calculations", "supporting_document", ("structural calc", "structural calculation", "structural calcs", "seismic"), ("S",)),
            ChecklistItem("Energy compliance form", "supporting_document", ("cf1r", "energy compliance", "title 24", "energy calc", "compliance form")),
            ChecklistItem("Permit application", "application", ("permit application", "plan check application", "application form", "ladbs application")),
        ),
    )


def _oakland_adu_checklist() -> PermitChecklist:
    return PermitChecklist(
        city="Oakland",
        permit_application="Oakland Building Permit Application — Accessory Dwelling Unit",
        submission_portal="Oakland Permit Center online portal",
        submission_portal_url="https://www.oaklandca.gov/topics/permits",
        checklist_source="https://www.oaklandca.gov/My-Household/Building-and-Remodeling/Homeowner-Projects-Permits/Accessory-Dwelling-Units-ADUs",
        file_naming_rules=(
            "Include sheet number and sheet name in each plan PDF filename.",
            "Group supporting documents in a /Calcs or /Forms folder when uploading.",
            "Maximum upload size per file: check current Oakland Permit Center limits.",
        ),
        separate_approvals=(
            ("Planning", True, "Zoning clearance for ADU on the parcel."),
            ("Building", True, "Plan review and permit issuance."),
            ("Fire", False, "When fire sprinkler or alarm work is included."),
        ),
        resubmission_instructions=(
            "Upload corrected sheets only unless instructed to replace the full set.",
            "Provide a written response to each plan check comment.",
            "Resubmit through the same permit record number.",
        ),
        items=(
            ChecklistItem("Site plan", "plan_sheet", ("site plan", "site", "plot plan"), ("A", "C")),
            ChecklistItem("Floor plan", "plan_sheet", ("floor plan", "floor", "layout"), ("A",)),
            ChecklistItem("Elevations", "plan_sheet", ("elevation", "elevations"), ("A",)),
            ChecklistItem("Sections and details", "plan_sheet", ("section", "sections", "detail", "details"), ("A",)),
            ChecklistItem("Structural calculations", "supporting_document", ("structural calc", "structural calculation", "structural calcs"), ("S",)),
            ChecklistItem("Energy compliance form", "supporting_document", ("cf1r", "energy compliance", "title 24", "compliance form")),
            ChecklistItem("Permit application", "application", ("permit application", "building permit application", "application form")),
        ),
    )


CHECKLIST_REGISTRY: dict[str, PermitChecklist] = {
    "los angeles": _la_adu_checklist(),
    "oakland": _oakland_adu_checklist(),
}


def get_checklist_for_address(address: str) -> tuple[PermitChecklist | None, JurisdictionProfile]:
    profile = resolve_from_address(address)
    key = profile.city.strip().lower()
    checklist = CHECKLIST_REGISTRY.get(key)
    return checklist, profile
