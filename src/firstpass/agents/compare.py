"""Compare Codes — Band agent backed by the TypeScript APS + vision + compare pipeline."""

from __future__ import annotations

import asyncio
import logging
import os

from band import Agent

from firstpass.adapters.compare_codes_band import CompareCodesBandAdapter
from firstpass.config import init_environment, load_agent_config

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def _run() -> None:
    init_environment()
    agent_id, api_key = load_agent_config("compare_codes")
    adapter = CompareCodesBandAdapter()
    agent = Agent.create(adapter=adapter, agent_id=agent_id, api_key=api_key)
    logger.info(
        "Compare Codes is running (TypeScript pipeline via %s/api/agents/compare-codes/run). Press Ctrl+C to stop.",
        os.getenv("FIRSTPASS_API_URL", "http://127.0.0.1:3000"),
    )
    await agent.run()


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
