"""CEO Boss — owns orchestration and delegates to the Project and Property Manager and specialist team."""

from __future__ import annotations

import asyncio
import logging

from firstpass.agent_factory import create_band_agent
from firstpass.prompts import CEO_BOSS_PROMPT

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def _run() -> None:
    agent = create_band_agent("ceo", CEO_BOSS_PROMPT, role="ceo")
    logger.info("CEO Boss is running. Press Ctrl+C to stop.")
    await agent.run()


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
