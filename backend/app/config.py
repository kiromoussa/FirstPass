import logging
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BACKEND_DIR / ".env"

logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
    )

    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-4-6"
    cors_origins: str = "http://localhost:5173"
    max_upload_mb: int = 20
    pdf_dpi: int = 200
    upload_dir: str = "uploads"
    tmp_dir: str = "tmp"

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def anthropic_api_key_configured(self) -> bool:
        return bool(self.anthropic_api_key.strip())


def get_config_status() -> dict[str, str | int | bool]:
    env_exists = ENV_FILE.exists()
    env_size = ENV_FILE.stat().st_size if env_exists else 0
    return {
        "env_file_path": str(ENV_FILE),
        "env_file_exists": env_exists,
        "env_file_size_bytes": env_size,
        "anthropic_api_key_configured": settings.anthropic_api_key_configured,
        "anthropic_api_key_length": len(settings.anthropic_api_key.strip()),
        "anthropic_model": settings.anthropic_model,
    }


settings = Settings()

if not settings.anthropic_api_key_configured:
    logger.warning(
        "ANTHROPIC_API_KEY not loaded (env_file=%s, exists=%s, size=%s bytes). "
        "Ensure backend/.env contains ANTHROPIC_API_KEY=your-key and is saved to disk.",
        ENV_FILE,
        ENV_FILE.exists(),
        ENV_FILE.stat().st_size if ENV_FILE.exists() else 0,
    )
else:
    logger.info(
        "ANTHROPIC_API_KEY loaded (env_file=%s, key_length=%d)",
        ENV_FILE,
        len(settings.anthropic_api_key.strip()),
    )
