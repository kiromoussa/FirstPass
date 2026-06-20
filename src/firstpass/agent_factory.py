"""Factory for creating Band agents with Internet Archive scraping + report tools."""

from __future__ import annotations

import os
from typing import Literal

from band import Agent
from band.adapters import AnthropicAdapter

from firstpass.archive_tool import ARCHIVE_SCRAPE_TOOLS
from firstpass.config import init_environment, load_agent_config
from firstpass.report_tool import REPORT_TOOLS

AgentRole = Literal["researcher", "synthesizer"]


def _tools_for_role(role: AgentRole) -> list:
    if role == "synthesizer":
        return REPORT_TOOLS + ARCHIVE_SCRAPE_TOOLS
    return ARCHIVE_SCRAPE_TOOLS + REPORT_TOOLS


def create_band_agent(
    config_name: str,
    custom_section: str,
    role: AgentRole = "researcher",
) -> Agent:
    init_environment()

    adapter = AnthropicAdapter(
        model=os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-5-20250929"),
        custom_section=custom_section,
        enable_execution_reporting=True,
        additional_tools=_tools_for_role(role),
    )

    agent_id, api_key = load_agent_config(config_name)

    kwargs: dict = {
        "adapter": adapter,
        "agent_id": agent_id,
        "api_key": api_key,
    }
    if ws_url := os.getenv("BAND_WS_URL"):
        kwargs["ws_url"] = ws_url
    if rest_url := os.getenv("BAND_REST_URL"):
        kwargs["rest_url"] = rest_url

    return Agent.create(**kwargs)
