"""CEO Planner — orchestrates the multi-agent permit-readiness workflow."""

from __future__ import annotations

import asyncio
import logging

from firstpass.agent_factory import create_band_agent
from firstpass.prompts import CEO_PLANNER_PROMPT

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def _run() -> None:
    agent = create_band_agent("ceo_planner", CEO_PLANNER_PROMPT, role="planner")
    logger.info("CEO Planner is running. Press Ctrl+C to stop.")
    await agent.run()


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
