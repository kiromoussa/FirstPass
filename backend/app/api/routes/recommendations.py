import logging

import anthropic
from fastapi import APIRouter, HTTPException

from app.models.schemas import RecommendationRequest, RecommendationResponse
from app.services.recommendation_engine import RecommendationEngine

logger = logging.getLogger(__name__)

router = APIRouter()
engine = RecommendationEngine()


@router.post("/recommendations", response_model=RecommendationResponse)
async def generate_recommendations(
    request: RecommendationRequest,
) -> RecommendationResponse:
    if not request.violations:
        raise HTTPException(status_code=400, detail="At least one violation is required.")

    try:
        return await engine.generate(request)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except anthropic.APIError as exc:
        logger.exception("Anthropic API error during recommendation generation")
        raise HTTPException(
            status_code=502,
            detail=f"Anthropic API error: {exc.message}",
        ) from exc
    except Exception as exc:
        logger.exception("Recommendation generation failed")
        raise HTTPException(
            status_code=500,
            detail=f"Recommendation generation failed: {exc}",
        ) from exc
