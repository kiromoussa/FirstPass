"""Code Synthesizer — Band agent that merges findings into one conclusion."""

from __future__ import annotations

import asyncio
import logging

from firstpass.agent_factory import create_band_agent
from firstpass.prompts import CODE_SYNTHESIZER_PROMPT

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def _run() -> None:
    agent = create_band_agent("code_synthesizer", CODE_SYNTHESIZER_PROMPT, role="synthesizer")
    logger.info("Code Synthesizer is running. Press Ctrl+C to stop.")
    await agent.run()


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
