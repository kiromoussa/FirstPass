"""Band adapter for Compare Codes — runs the TypeScript APS + vision + compare pipeline."""

from __future__ import annotations

import logging
import os
import re
from typing import Any

import httpx

from band.core.protocols import AgentToolsProtocol
from band.core.simple_adapter import SimpleAdapter
from band.core.types import PlatformMessage

logger = logging.getLogger(__name__)

DEFAULT_API = "http://127.0.0.1:3000"
RUN_TIMEOUT_S = 300.0
DEFAULT_PPM_HANDLE = "varbtw/project-property-intake"
DEFAULT_IMPROVE_HANDLE = "varbtw/improve-agent"


class CompareCodesBandAdapter(SimpleAdapter[list[Any]]):
    """When @mentioned in Band, invoke FirstPass Compare Codes (TypeScript pipeline)."""

    async def on_message(
        self,
        msg: PlatformMessage,
        tools: AgentToolsProtocol,
        history: list[Any],
        participants_msg: str | None,
        contacts_msg: str | None,
        *,
        is_session_bootstrap: bool,
        room_id: str,
    ) -> None:
        del history, participants_msg, contacts_msg, is_session_bootstrap, room_id

        content = (msg.content or "").strip()
        if not content:
            return

        ppm = os.getenv("BAND_AGENT_PPM_HANDLE", DEFAULT_PPM_HANDLE)
        improve = os.getenv("BAND_AGENT_SOLUTIONS_HANDLE", DEFAULT_IMPROVE_HANDLE)

        await tools.send_event(
            "Compare Codes starting — APS plot (if DWG) → Claude vision → deterministic code compare.",
            "thought",
        )

        api_base = os.getenv("FIRSTPASS_API_URL", DEFAULT_API).rstrip("/")
        project_id = _project_id_from_text(content)

        try:
            with httpx.Client(timeout=RUN_TIMEOUT_S) as client:
                res = client.post(
                    f"{api_base}/api/agents/compare-codes/run",
                    json={"projectId": project_id} if project_id else {},
                )
                payload = res.json() if res.content else {}
        except httpx.TimeoutException:
            await tools.send_message(
                "Compare Codes timed out (>5 min). DWG plotting may still be running — check output/plan_vs_code.txt.",
                mentions=[ppm],
            )
            return
        except Exception as exc:
            logger.exception("Compare Codes API call failed")
            await tools.send_message(
                f"Compare Codes could not reach FirstPass API ({exc}). Is `npm run dev` running?",
                mentions=[ppm],
            )
            return

        if res.status_code >= 400:
            err = payload.get("error") or res.text
            await tools.send_message(f"Compare Codes failed: {err}", mentions=[ppm])
            return

        summary = payload.get("summary") or "Compare Codes finished."
        mentions = [improve] if payload.get("ok") else [ppm]
        await tools.send_message(summary, mentions=mentions)


def _project_id_from_text(text: str) -> str | None:
    """Best-effort UUID from kickoff metadata (optional)."""
    match = re.search(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        text,
        re.I,
    )
    return match.group(0) if match else None
