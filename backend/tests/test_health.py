import io

from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from app.services.dwg_converter import DWG_CONVERSION_ERROR

client = TestClient(app)


def test_health_check():
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["service"] == "firstpass"


def test_analyze_rejects_unsupported_format():
    response = client.post(
        "/api/v1/analyze",
        files={"file": ("plan.txt", b"hello", "text/plain")},
    )
    assert response.status_code == 400
    assert "Supported formats" in response.json()["detail"]


def test_analyze_rejects_invalid_pdf():
    response = client.post(
        "/api/v1/analyze",
        files={"file": ("plan.pdf", b"not a pdf", "application/pdf")},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid PDF file."


def test_analyze_rejects_invalid_png():
    response = client.post(
        "/api/v1/analyze",
        files={"file": ("plan.png", b"fake", "image/png")},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid PNG file."


def test_analyze_dwg_returns_conversion_error():
    response = client.post(
        "/api/v1/analyze",
        files={"file": ("plan.dwg", b"AC1018 fake dwg content", "application/octet-stream")},
    )
    assert response.status_code == 503
    assert response.json()["detail"] == DWG_CONVERSION_ERROR


def _minimal_png_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), color="white").save(buffer, format="PNG")
    return buffer.getvalue()


def test_analyze_accepts_png_and_reaches_vision_layer(monkeypatch):
    async def mock_extract(_image):
        from app.models.schemas import ExtractedElements

        return ExtractedElements()

    monkeypatch.setattr(
        "app.services.analyzer.FloorPlanAnalyzer.vision",
        type("V", (), {"extract_elements": mock_extract})(),
        raising=False,
    )

    # Patch the analyzer instance used by the route
    from app.api.routes import analyze as analyze_route

    async def mock_analyze(**kwargs):
        from app.models.schemas import AnalysisResponse, ExtractedElements

        return AnalysisResponse(
            analysis_id=kwargs["analysis_id"],
            filename=kwargs["filename"],
            pages_analyzed=1,
            extracted_elements=ExtractedElements(),
            issues=[],
            violations=[],
            recommendations=[],
            recommendations_error=None,
            report_markdown="# Test",
        )

    monkeypatch.setattr(analyze_route.analyzer, "analyze", mock_analyze)

    response = client.post(
        "/api/v1/analyze",
        files={"file": ("plan.png", _minimal_png_bytes(), "image/png")},
    )
    assert response.status_code == 200
