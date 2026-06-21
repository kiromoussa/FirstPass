"""Project and Property Manager — orchestrates the multi-agent permit-readiness workflow."""

from __future__ import annotations

import asyncio
import logging

from firstpass.agent_factory import create_band_agent
from firstpass.prompts import PROJECT_PROPERTY_MANAGER_PROMPT

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def _run() -> None:
    agent = create_band_agent(
        "project_property_manager",
        PROJECT_PROPERTY_MANAGER_PROMPT,
        role="planner",
    )
    logger.info("Project and Property Manager is running. Press Ctrl+C to stop.")
    await agent.run()


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
