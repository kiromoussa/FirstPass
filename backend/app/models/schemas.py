from enum import Enum

from pydantic import BaseModel, Field


class IssueSeverity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


class Room(BaseModel):
    name: str
    label: str | None = None
    approximate_area_sqft: float | None = None
    notes: str | None = None


class Door(BaseModel):
    location: str
    connects: list[str] = Field(default_factory=list)
    swing_direction: str | None = None
    notes: str | None = None


class Window(BaseModel):
    location: str
    room: str | None = None
    notes: str | None = None


class Stair(BaseModel):
    location: str
    direction: str | None = None
    notes: str | None = None


class Dimension(BaseModel):
    label: str
    value: str
    unit: str = "ft"
    location: str | None = None


class ExtractedElements(BaseModel):
    rooms: list[Room] = Field(default_factory=list)
    doors: list[Door] = Field(default_factory=list)
    windows: list[Window] = Field(default_factory=list)
    stairs: list[Stair] = Field(default_factory=list)
    dimensions: list[Dimension] = Field(default_factory=list)
    potential_issues: list[str] = Field(default_factory=list)


class Issue(BaseModel):
    category: str
    severity: IssueSeverity
    title: str
    description: str
    recommendation: str | None = None
    code_reference: str | None = None


class Violation(BaseModel):
    code_section: str
    issue: str
    location: str | None = None
    evidence: str | None = None
    severity: str


class DrawingLocation(BaseModel):
    sheet: str = ""
    area: str = ""
    bbox: list[float] | None = None
    annotation_text: str = ""


class Recommendation(BaseModel):
    violation: str
    code_section: str
    severity: str
    recommended_fix: str
    design_adjustment: str
    drawing_location: DrawingLocation
    confidence: str
    notes: str = ""


class AnalysisResponse(BaseModel):
    analysis_id: str
    filename: str
    pages_analyzed: int
    extracted_elements: ExtractedElements
    issues: list[Issue] = Field(default_factory=list)
    violations: list[Violation] = Field(default_factory=list)
    recommendations: list[Recommendation] = Field(default_factory=list)
    recommendations_error: str | None = None
    report_markdown: str


class RecommendationRequest(BaseModel):
    project_type: str | None = None
    violations: list[Violation]
    floor_plan_features: dict = Field(default_factory=dict)


class RecommendationResponse(BaseModel):
    recommendations: list[Recommendation] = Field(default_factory=list)
