"""Green Code Researcher — Band agent (CALGreen / Title 24 Part 11)."""

from __future__ import annotations

import asyncio
import logging

from firstpass.agent_factory import create_band_agent
from firstpass.prompts import GREEN_RESEARCHER_PROMPT

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def _run() -> None:
    agent = create_band_agent("green_researcher", GREEN_RESEARCHER_PROMPT, role="researcher")
    logger.info("Green Code Researcher is running. Press Ctrl+C to stop.")
    await agent.run()


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
