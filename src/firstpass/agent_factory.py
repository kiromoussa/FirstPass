"""Factory for creating Band agents with Internet Archive scraping + report tools."""

from __future__ import annotations

import os
from typing import Literal

from band import Agent
from band.adapters import AnthropicAdapter

from firstpass.archive_tool import ARCHIVE_SCRAPE_TOOLS
from firstpass.browserbase_tool import BROWSERBASE_TOOLS
from firstpass.config import DEFAULT_MODEL, init_environment, load_agent_config
from firstpass.permit.tool import PERMIT_TOOLS
from firstpass.plan_analysis_tool import PLAN_ANALYSIS_TOOLS
from firstpass.report_tool import MERGE_REPORT_TOOLS, REPORT_TOOLS

AgentRole = Literal[
    "researcher",
    "synthesizer",
    "municipal_researcher",
    "permit_agent",
    "comparator",
    "ceo",
    "planner",
    "solutions",
    "visual",
]

# Keep completions short — full code text lives in output/*.txt, not chat/tool payloads
RESEARCHER_MAX_TOKENS = 1024
SYNTHESIZER_MAX_TOKENS = 2048


def _tools_for_role(role: AgentRole) -> list:
    if role == "synthesizer":
        return MERGE_REPORT_TOOLS + REPORT_TOOLS
    if role == "permit_agent":
        return PERMIT_TOOLS + REPORT_TOOLS
    if role == "municipal_researcher":
        return ARCHIVE_SCRAPE_TOOLS + BROWSERBASE_TOOLS + REPORT_TOOLS
    if role == "comparator":
        return REPORT_TOOLS + ARCHIVE_SCRAPE_TOOLS
    if role in ("ceo", "planner"):
        return REPORT_TOOLS
    if role == "solutions":
        return REPORT_TOOLS
    if role == "visual":
        return REPORT_TOOLS + PLAN_ANALYSIS_TOOLS
    return ARCHIVE_SCRAPE_TOOLS + REPORT_TOOLS


def create_band_agent(
    config_name: str,
    custom_section: str,
    role: AgentRole = "researcher",
) -> Agent:
    init_environment()

    max_tokens = SYNTHESIZER_MAX_TOKENS if role == "synthesizer" else RESEARCHER_MAX_TOKENS

    adapter = AnthropicAdapter(
        model=os.getenv("ANTHROPIC_MODEL", DEFAULT_MODEL),
        custom_section=custom_section,
        enable_execution_reporting=False,
        max_tokens=max_tokens,
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
        # Band SDK expects the host root; TS/httpx clients use .../api/v1/agent.
        rest_url = rest_url.removesuffix("/api/v1/agent").rstrip("/") or "https://app.band.ai"
        kwargs["rest_url"] = rest_url

    return Agent.create(**kwargs)
