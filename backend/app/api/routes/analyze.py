import uuid

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.config import settings
from app.models.schemas import AnalysisResponse
from app.services.analyzer import FloorPlanAnalyzer
from app.services.file_converter import ALLOWED_EXTENSIONS, is_allowed_extension

router = APIRouter()
analyzer = FloorPlanAnalyzer()

SUPPORTED_FORMATS = ", ".join(ext.lstrip(".") for ext in sorted(ALLOWED_EXTENSIONS))


@router.post("/analyze", response_model=AnalysisResponse)
async def analyze_floor_plan(
    file: UploadFile = File(...),
    project_type: str | None = Form(None),
) -> AnalysisResponse:
    if not file.filename or not is_allowed_extension(file.filename):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type. Supported formats: {SUPPORTED_FORMATS}.",
        )

    content = await file.read()
    if len(content) > settings.max_upload_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"File exceeds maximum size of {settings.max_upload_mb} MB.",
        )

    analysis_id = str(uuid.uuid4())

    try:
        result = await analyzer.analyze(
            file_bytes=content,
            filename=file.filename,
            analysis_id=analysis_id,
            project_type=project_type,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Analysis failed.") from exc

    return result
