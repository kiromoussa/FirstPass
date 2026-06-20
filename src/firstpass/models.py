"""Shared Pydantic models for agent outputs."""

from __future__ import annotations

from pydantic import BaseModel, Field


class CodeCitation(BaseModel):
    title: str = Field(description="Short name of the code section or ordinance")
    section: str = Field(description="Section number or identifier")
    url: str = Field(description="Official source URL")
    excerpt: str = Field(description="Relevant excerpt from the source")
    authority: str = Field(description="e.g. municipal, state, county")


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
