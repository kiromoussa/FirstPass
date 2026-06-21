"""Visual Analysis Agent — Claude plan-reader (mirrors FirstPass web app)."""

from __future__ import annotations

import asyncio
import logging

from firstpass.agent_factory import create_band_agent
from firstpass.prompts import VISUAL_ANALYSIS_PROMPT

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def _run() -> None:
    agent = create_band_agent("visual_analysis", VISUAL_ANALYSIS_PROMPT, role="visual")
    logger.info("Visual Analysis Agent is running. Press Ctrl+C to stop.")
    await agent.run()


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
