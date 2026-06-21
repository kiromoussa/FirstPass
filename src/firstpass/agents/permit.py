"""Permit Agent — researches permit portals via Browserbase and builds submission packages."""

from __future__ import annotations

import asyncio
import logging

from firstpass.agent_factory import create_band_agent
from firstpass.prompts import PERMIT_AGENT_PROMPT

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def _run() -> None:
    agent = create_band_agent("permit_agent", PERMIT_AGENT_PROMPT, role="permit_agent")
    logger.info("Permit Agent is running. Press Ctrl+C to stop.")
    await agent.run()


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
