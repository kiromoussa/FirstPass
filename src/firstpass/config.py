"""Unified FirstPass configuration — single YAML file for API keys and agent IDs."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import yaml

CONFIG_FILENAME = "firstpass.config.yaml"
EXAMPLE_FILENAME = "firstpass.config.yaml.example"

# Cheapest Claude model suitable for tool-calling + vision agents (Band team default).
# Override only if you accept higher cost: Sonnet/Opus are NOT used by default.
DEFAULT_MODEL = "claude-haiku-4-5-20251001"

# Maps firstpass.config.yaml band keys → Next.js band-client.ts env var names.
BAND_ENV_MAP: dict[str, tuple[str, str]] = {
    "ceo": ("BAND_AGENT_CEO_ID", "BAND_AGENT_CEO_KEY"),
    "project_property_manager": (
        "BAND_AGENT_PROJECT_PROPERTY_MANAGER_ID",
        "BAND_AGENT_PROJECT_PROPERTY_MANAGER_KEY",
    ),
    "code_synthesizer": ("BAND_AGENT_SYNTHESIZER_ID", "BAND_AGENT_SYNTHESIZER_KEY"),
    "municipal_researcher": ("BAND_AGENT_MUNICIPAL_ID", "BAND_AGENT_MUNICIPAL_KEY"),
    "state_researcher": ("BAND_AGENT_STATE_ID", "BAND_AGENT_STATE_KEY"),
    "visual_analysis": ("BAND_AGENT_VISUAL_ID", "BAND_AGENT_VISUAL_KEY"),
    "compare_codes": ("BAND_AGENT_COMPARE_ID", "BAND_AGENT_COMPARE_KEY"),
    "solutions_agent": ("BAND_AGENT_SOLUTIONS_ID", "BAND_AGENT_SOLUTIONS_KEY"),
    "permit_report": ("BAND_AGENT_PERMIT_ID", "BAND_AGENT_PERMIT_KEY"),
}


def get_config_path() -> Path:
    return Path(os.getcwd()) / CONFIG_FILENAME


@lru_cache(maxsize=1)
def load_config() -> dict:
    path = get_config_path()
    if not path.exists():
        raise FileNotFoundError(
            f"Config not found at {path}. "
            f"Copy {EXAMPLE_FILENAME} to {CONFIG_FILENAME} and fill in your credentials."
        )
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def init_environment() -> None:
    """Load config and populate env vars for Anthropic, Browserbase, and Band."""
    config = load_config()

    if anthropic := config.get("anthropic"):
        if key := anthropic.get("api_key"):
            os.environ.setdefault("ANTHROPIC_API_KEY", key)
        if model := anthropic.get("model"):
            os.environ.setdefault("ANTHROPIC_MODEL", model)

    if browserbase := config.get("browserbase"):
        if key := browserbase.get("api_key"):
            os.environ.setdefault("BROWSERBASE_API_KEY", key)
        if project_id := browserbase.get("project_id"):
            os.environ.setdefault("BROWSERBASE_PROJECT_ID", project_id)

    if rest_url := config.get("band_rest_url"):
        os.environ.setdefault("BAND_REST_URL", rest_url)
    if ws_url := config.get("band_ws_url"):
        os.environ.setdefault("BAND_WS_URL", ws_url)

    band = config.get("band", {})
    # Legacy config keys before rename to Project and Property Manager.
    for legacy in ("ceo_planner", "vp"):
        if legacy in band and "project_property_manager" not in band:
            band = {**band, "project_property_manager": band[legacy]}
            break
    if orch := band.get("orchestrator"):
        if key := orch.get("api_key"):
            os.environ.setdefault("BAND_API_KEY", key)
    for agent_key, (id_env, key_env) in BAND_ENV_MAP.items():
        agent = band.get(agent_key)
        if not agent:
            continue
        if agent_id := agent.get("agent_id"):
            os.environ.setdefault(id_env, agent_id)
        if api_key := agent.get("api_key"):
            os.environ.setdefault(key_env, api_key)


def load_agent_config(agent_key: str) -> tuple[str, str]:
    """Return (agent_id, api_key) for a Band agent from the config file."""
    aliases = {"ceo_planner": "project_property_manager", "vp": "project_property_manager"}
    agent_key = aliases.get(agent_key, agent_key)
    band = load_config().get("band", {})
    agent = band.get(agent_key)
    if not agent:
        raise ValueError(
            f"Agent '{agent_key}' not found under 'band' in {get_config_path()}. "
            f"See {EXAMPLE_FILENAME} for the expected structure."
        )

    agent_id = agent.get("agent_id")
    api_key = agent.get("api_key")
    missing = [f for f, v in [("agent_id", agent_id), ("api_key", api_key)] if not v]
    if missing:
        raise ValueError(
            f"Missing {', '.join(missing)} for '{agent_key}' in {get_config_path()}"
        )

    return agent_id, api_key
