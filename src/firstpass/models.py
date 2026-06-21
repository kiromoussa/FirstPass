"""Shared Pydantic models for agent outputs."""

from __future__ import annotations

from pydantic import BaseModel, Field


class CodeCitation(BaseModel):
    title: str = Field(description="Short name of the code section or ordinance")
    section: str = Field(description="Section number or identifier")
    url: str = Field(description="Official source URL")
    excerpt: str = Field(description="Relevant excerpt from the source")
    authority: str = Field(description="e.g. municipal, state, county")


class CodeRequirement(BaseModel):
    requirement: str
    value: str | None = None
    jurisdiction: str
    authority: str = ""
    source_url: str = ""
    official_source: bool = False
    applies_to_project: bool = True
    applicability_reason: str = ""
    confidence: float = 0.5
    quoted_text: str = ""
    needs_verification: bool = False
    category: str = "unknown"  # zoning | building | statute | parcel


class PropertyCheck(BaseModel):
    field_name: str
    value: str | None = None
    source: str = ""
    confirmed: bool = False


class ComplianceReport(BaseModel):
    address: str
    project_type: str
    preliminary_result: str
    confirmed_requirements: list[CodeRequirement] = Field(default_factory=list)
    property_checks: list[PropertyCheck] = Field(default_factory=list)
    unresolved_items: list[str] = Field(default_factory=list)
    conflict_notes: list[str] = Field(default_factory=list)
    supporting_excerpts: list[dict] = Field(default_factory=list)
    checklist_coverage: dict[str, int] = Field(default_factory=dict)


ADU_CHECKLIST: dict[str, list[str]] = {
    "municipal": [
        "base_zoning",
        "overlay_zones",
        "front_setback",
        "side_setback",
        "rear_setback",
        "max_height",
        "lot_coverage",
        "floor_area_ratio",
        "max_adu_size",
        "parking",
        "historic_district",
        "fire_flood_restrictions",
        "ladbs_requirements",
    ],
    "state": [
        "ministerial_approval",
        "max_review_time",
        "min_adu_size",
        "side_rear_setback",
        "height_protection",
        "parking_exemption",
        "owner_occupancy",
        "impact_fees",
        "utility_connection",
        "replacement_parking",
        "multifamily_adu",
        "local_preemption",
        "coastal_fire_exceptions",
        "sprinkler_exception",
        "adu_definition",
    ],
}


class CodeResearchFinding(BaseModel):
    jurisdiction_city: str
    jurisdiction_state: str
    project_type: str
    codes: list[CodeCitation]
    summary: str = Field(description="2-3 sentence summary of applicable codes")
    confidence: str = Field(description="high, medium, or low")
    gaps: list[str] = Field(default_factory=list, description="Missing or unclear items")


class FinalCodeConclusion(BaseModel):
    city: str
    state: str
    project_type: str
    applicable_codes: list[CodeCitation]
    municipal_summary: str
    state_summary: str
    combined_conclusion: str = Field(
        description="One concise paragraph: the definitive answer for permit readiness"
    )
    confidence: str
    disagreements_resolved: list[str] = Field(default_factory=list)
    requires_professional_review: list[str] = Field(default_factory=list)
