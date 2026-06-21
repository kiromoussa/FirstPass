from fastapi import APIRouter

from app.config import get_config_status

router = APIRouter()


@router.get("/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok", "service": "firstpass"}


@router.get("/health/config")
async def config_debug() -> dict[str, str | int | bool]:
    """Temporary debug endpoint: shows whether .env was found and key is loaded (not the key itself)."""
    return get_config_status()
