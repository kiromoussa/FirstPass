"""Plumbing Code Researcher — Band agent (California Plumbing Code / CPC)."""

from __future__ import annotations

import asyncio
import logging

from firstpass.agent_factory import create_band_agent
from firstpass.prompts import PLUMBING_RESEARCHER_PROMPT

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def _run() -> None:
    agent = create_band_agent("plumbing_researcher", PLUMBING_RESEARCHER_PROMPT, role="researcher")
    logger.info("Plumbing Code Researcher is running. Press Ctrl+C to stop.")
    await agent.run()


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
