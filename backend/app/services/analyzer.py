import logging
from pathlib import Path

from PIL import Image

from app.models.schemas import (
    AnalysisResponse,
    Issue,
    IssueSeverity,
    RecommendationRequest,
    RecommendationResponse,
)
from app.services.file_converter import file_to_images, save_upload
from app.services.recommendation_engine import RecommendationEngine
from app.services.report_generator import generate_report_markdown
from app.services.violation_mapper import build_floor_plan_features, build_violations
from app.services.vision_analyzer import VisionAnalyzer

logger = logging.getLogger(__name__)


def _potential_issues_to_issues(descriptions: list[str]) -> list[Issue]:
    return [
        Issue(
            category="layout",
            severity=IssueSeverity.INFO,
            title=f"Potential issue {index}",
            description=description,
        )
        for index, description in enumerate(descriptions, start=1)
        if description.strip()
    ]


class FloorPlanAnalyzer:
    """Orchestrates upload storage, vision extraction, recommendations, and reporting."""

    def __init__(self) -> None:
        self.vision = VisionAnalyzer()
        self.recommendations = RecommendationEngine()

    async def analyze(
        self,
        file_bytes: bytes,
        filename: str,
        analysis_id: str,
        project_type: str | None = None,
    ) -> AnalysisResponse:
        saved_path: Path = save_upload(file_bytes, filename, analysis_id)
        images: list[Image.Image] = file_to_images(file_bytes, filename, saved_path)

        # MVP: analyze first page/image; extend to multi-page merge later
        primary_image = images[0]
        elements = await self.vision.extract_elements(primary_image)
        issues = _potential_issues_to_issues(elements.potential_issues)
        violations = build_violations(elements, issues)

        recommendation_response: RecommendationResponse | None = None
        recommendations_error: str | None = None
        if violations:
            try:
                recommendation_response = await self.recommendations.generate(
                    RecommendationRequest(
                        project_type=project_type,
                        violations=violations,
                        floor_plan_features=build_floor_plan_features(elements),
                    )
                )
            except Exception as exc:
                logger.exception("Recommendation generation failed after analysis")
                recommendations_error = str(exc)

        report = generate_report_markdown(
            filename=filename,
            pages_analyzed=len(images),
            elements=elements,
            issues=issues,
        )

        return AnalysisResponse(
            analysis_id=analysis_id,
            filename=filename,
            pages_analyzed=len(images),
            extracted_elements=elements,
            issues=issues,
            violations=violations,
            recommendations=(
                recommendation_response.recommendations if recommendation_response else []
            ),
            recommendations_error=recommendations_error,
            report_markdown=report,
        )
