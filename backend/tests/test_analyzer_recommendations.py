import io
import json

import pytest
from PIL import Image

from app.models.schemas import ExtractedElements, RecommendationResponse, Room, Violation
from app.services.analyzer import FloorPlanAnalyzer


def _minimal_png_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), color="white").save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.mark.asyncio
async def test_analyze_runs_recommendations_on_detected_violations(monkeypatch):
    elements = ExtractedElements(
        rooms=[Room(name="ADU", label="ADU")],
        potential_issues=["Detached ADU may require fire sprinklers"],
    )

    async def mock_extract(_image):
        return elements

    captured: dict = {}

    async def mock_generate(request):
        captured["violations"] = request.violations
        captured["floor_plan_features"] = request.floor_plan_features
        return RecommendationResponse(
            recommendations=[
                {
                    "violation": request.violations[0].issue,
                    "code_section": "unclear",
                    "severity": "medium",
                    "recommended_fix": "Add sprinklers",
                    "design_adjustment": "Update plan notes",
                    "drawing_location": {
                        "sheet": "",
                        "area": "ADU",
                        "bbox": None,
                        "annotation_text": "Sprinkler note",
                    },
                    "confidence": "medium",
                    "notes": "",
                }
            ]
        )

    analyzer = FloorPlanAnalyzer()
    monkeypatch.setattr(analyzer.vision, "extract_elements", mock_extract)
    monkeypatch.setattr(analyzer.recommendations, "generate", mock_generate)

    result = await analyzer.analyze(
        file_bytes=_minimal_png_bytes(),
        filename="plan.png",
        analysis_id="test-analysis-id",
        project_type="ADU",
    )

    assert len(result.violations) == 1
    assert result.violations[0].issue == "Detached ADU may require fire sprinklers"
    assert len(result.recommendations) == 1
    assert result.recommendations[0].recommended_fix == "Add sprinklers"
    assert captured["violations"][0].issue == "Detached ADU may require fire sprinklers"
    assert captured["floor_plan_features"]["rooms"][0]["name"] == "ADU"
    assert result.recommendations_error is None
