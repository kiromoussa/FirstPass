"""Pydantic models for permit package review output."""

from __future__ import annotations

from pydantic import BaseModel, Field


class PermitDocument(BaseModel):
    name: str
    status: str = Field(description="found | missing | optional")
    sheet: str | None = None
    source: str | None = Field(default=None, description="Filename or index line that matched")
    category: str = Field(default="plan_sheet", description="plan_sheet | supporting_document | application")


class SeparateApproval(BaseModel):
    agency: str
    required: bool = True
    notes: str = ""


class PermitPackageReview(BaseModel):
    address: str
    city: str
    project_type: str
    permit_application: str
    required_documents: list[PermitDocument] = Field(default_factory=list)
    submission_portal: str
    submission_portal_url: str = ""
    file_naming_rules: list[str] = Field(default_factory=list)
    separate_approvals: list[SeparateApproval] = Field(default_factory=list)
    missing_items: list[str] = Field(default_factory=list)
    resubmission_instructions: list[str] = Field(default_factory=list)
    package_completion: int = Field(ge=0, le=100)
    checklist_source: str = ""
