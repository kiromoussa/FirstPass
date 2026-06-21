import os
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

from app.config import BACKEND_DIR, ENV_FILE, Settings, get_config_status, settings


def test_env_file_path_points_to_backend():
    assert ENV_FILE == BACKEND_DIR / ".env"
    assert BACKEND_DIR.name == "backend"


def test_settings_loads_from_env_file(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("ANTHROPIC_API_KEY=test-key-from-file\n")

    class FileSettings(BaseSettings):
        model_config = SettingsConfigDict(env_file=env_file, env_file_encoding="utf-8")
        anthropic_api_key: str = ""

    loaded = FileSettings()
    assert loaded.anthropic_api_key == "test-key-from-file"


def test_settings_reads_process_environment(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-from-env")
    loaded = Settings()
    assert loaded.anthropic_api_key == "test-key-from-env"
    assert loaded.anthropic_api_key_configured is True


def test_config_status_does_not_expose_key_value():
    status = get_config_status()

    assert "env_file_path" in status
    assert "anthropic_api_key_configured" in status
    assert "anthropic_api_key_length" in status
    assert "anthropic_api_key" not in status
    if settings.anthropic_api_key:
        assert settings.anthropic_api_key not in str(status)
