import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import analyze, health, recommendations
from app.config import get_config_status, settings

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    Path(settings.upload_dir).mkdir(parents=True, exist_ok=True)
    Path(settings.tmp_dir).mkdir(parents=True, exist_ok=True)
    status = get_config_status()
    logger.info(
        "Startup config: env_file=%s exists=%s size=%s anthropic_key_configured=%s",
        status["env_file_path"],
        status["env_file_exists"],
        status["env_file_size_bytes"],
        status["anthropic_api_key_configured"],
    )
    yield


app = FastAPI(
    title="FirstPass",
    description="AI floor plan reviewer API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, tags=["health"])
app.include_router(analyze.router, prefix="/api/v1", tags=["analyze"])
app.include_router(recommendations.router, prefix="/api/v1", tags=["recommendations"])
