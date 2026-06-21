import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.schemas import RecommendationRequest, Violation
from app.services.recommendation_engine import RecommendationEngine

client = TestClient(app)

SAMPLE_REQUEST = {
    "project_type": "ADU",
    "violations": [
        {
            "code_section": "2025 CRC R309.2",
            "issue": "Detached ADU may require fire sprinklers",
            "location": "ADU building",
            "evidence": "ADU area exceeds 1200 sq ft or primary dwelling has sprinklers",
            "severity": "high",
        }
    ],
    "floor_plan_features": {},
}

MOCK_RESPONSE = {
    "recommendations": [
        {
            "violation": "Detached ADU may require fire sprinklers",
            "code_section": "2025 CRC R309.2",
            "severity": "high",
            "recommended_fix": "Provide automatic fire sprinkler system throughout the ADU.",
            "design_adjustment": "Add sprinkler layout to ADU floor plan and note system type.",
            "drawing_location": {
                "sheet": "",
                "area": "ADU building",
                "bbox": None,
                "annotation_text": "Note sprinkler requirement at ADU floor plan",
            },
            "confidence": "medium",
            "notes": "Confirm with local AHJ; exact sheet not provided.",
        }
    ]
}


def test_recommendations_rejects_empty_violations():
    response = client.post("/api/v1/recommendations", json={"violations": []})
    assert response.status_code == 400
    assert response.json()["detail"] == "At least one violation is required."


@pytest.mark.asyncio
async def test_generate_calls_claude(monkeypatch):
    captured: dict = {}

    class Block:
        type = "text"
        text = json.dumps(MOCK_RESPONSE)

    class Response:
        content = [Block()]

    async def mock_create(**kwargs):
        captured.update(kwargs)
        return Response()

    class MockMessages:
        @staticmethod
        async def create(**kwargs):
            return await mock_create(**kwargs)

    class MockClient:
        messages = MockMessages()

    monkeypatch.setattr("app.services.recommendation_engine.settings.anthropic_api_key", "test-key")
    monkeypatch.setattr(
        "app.services.recommendation_engine.AsyncAnthropic",
        lambda **kwargs: MockClient(),
    )

    engine = RecommendationEngine()
    request = RecommendationRequest.model_validate(SAMPLE_REQUEST)
    result = await engine.generate(request)

    assert captured["model"] == "claude-sonnet-4-6"
    assert "2025 CRC R309.2" in captured["messages"][0]["content"]
    assert len(result.recommendations) == 1
    assert result.recommendations[0].code_section == "2025 CRC R309.2"
    assert result.recommendations[0].drawing_location.bbox is None


def test_recommendations_endpoint(monkeypatch):
    async def mock_generate(_request):
        from app.models.schemas import RecommendationResponse

        return RecommendationResponse.model_validate(MOCK_RESPONSE)

    monkeypatch.setattr(
        "app.api.routes.recommendations.engine.generate",
        mock_generate,
    )

    response = client.post("/api/v1/recommendations", json=SAMPLE_REQUEST)
    assert response.status_code == 200
    data = response.json()
    assert len(data["recommendations"]) == 1
    assert data["recommendations"][0]["recommended_fix"].startswith("Provide automatic")
