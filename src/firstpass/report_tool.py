"""Write research reports to local .txt files."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from pydantic import BaseModel, Field

OUTPUT_DIR = Path(__file__).resolve().parents[2] / "output"
SESSION_LINE_PREFIX = "Browserbase Session"


def _browserbase_sessions_from_file(path: Path) -> list[str]:
    """Extract Browserbase session URLs already written in a report file."""
    if not path.exists():
        return []
    sessions: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith(SESSION_LINE_PREFIX):
            continue
        url = line.split(":", 1)[1].strip()
        if url.startswith("http") and url not in sessions:
            sessions.append(url)
    return sessions


def _append_research_sessions(content: str) -> str:
    """Append municipal/state Browserbase session links to a final summary."""
    municipal_sessions = _browserbase_sessions_from_file(OUTPUT_DIR / "municipal_codes.txt")
    state_sessions = _browserbase_sessions_from_file(OUTPUT_DIR / "state_codes.txt")
    if not municipal_sessions and not state_sessions:
        return content.strip()

    lines = [content.strip(), "", "BROWSERBASE SESSION RECORDINGS", "----------------------------"]
    if municipal_sessions:
        lines.append("Municipal researcher:")
        lines.extend(f"- {url}" for url in municipal_sessions)
    if state_sessions:
        lines.append("State researcher:")
        lines.extend(f"- {url}" for url in state_sessions)
    return "\n".join(lines) + "\n"


class WriteTextReportInput(BaseModel):
    """Write a building code research report to a .txt file in the output/ folder."""

    filename: str = Field(
        ...,
        description="Output filename without path, e.g. state_codes.txt or final_summary.txt",
    )
    content: str = Field(..., description="Full report text to write")
    report_type: str = Field(
        default="research",
        description="One of: municipal, state, final_summary",
    )


def _safe_filename(name: str) -> str:
    base = re.sub(r"[^\w.\-]", "_", name.strip())
    if not base.endswith(".txt"):
        base = f"{base}.txt"
    return base


def write_text_report(input: WriteTextReportInput) -> str:
    """Write report content to output/ and return the file path."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    filename = _safe_filename(input.filename)
    path = OUTPUT_DIR / filename

    header = (
        f"FirstPass Code Research Report\n"
        f"Type: {input.report_type}\n"
        f"Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n"
        f"{'=' * 60}\n\n"
    )

    body = input.content.strip()
    if input.report_type == "final_summary":
        body = _append_research_sessions(body)

    path.write_text(header + body + "\n", encoding="utf-8")

    payload: dict = {
        "status": "written",
        "path": str(path),
        "filename": filename,
        "bytes": path.stat().st_size,
    }
    if input.report_type == "final_summary":
        payload["instruction"] = (
            "Report saved. You MUST now reply in Band chat with plain text only (no more tools): "
            f"confirm final_summary.txt path {path} and a 1–2 sentence summary. Max 5 sentences."
        )
    else:
        payload["message"] = f"Report saved to {path}"

    return json.dumps(payload)


class MergeResearchReportsInput(BaseModel):
    """Merge municipal + state reports into final_summary.txt from output/ files."""

    address: str = Field(..., description="Project address from the kickoff message")
    project_type: str = Field(default="Detached ADU")
    municipal_filename: str = Field(default="municipal_codes.txt")
    state_filename: str = Field(default="state_codes.txt")


def merge_research_reports(input: MergeResearchReportsInput) -> str:
    """Concatenate researcher reports into final_summary.txt (verbatim + session links)."""
    municipal_name = _safe_filename(input.municipal_filename)
    state_name = _safe_filename(input.state_filename)
    municipal_path = OUTPUT_DIR / municipal_name
    state_path = OUTPUT_DIR / state_name

    missing = [
        name
        for name, path in ((municipal_name, municipal_path), (state_name, state_path))
        if not path.exists()
    ]
    if missing:
        return json.dumps(
            {
                "status": "waiting",
                "missing_files": missing,
                "instruction": "Reply in chat that you are waiting for the missing report(s). Do not call merge again yet.",
            }
        )

    municipal_content = municipal_path.read_text(encoding="utf-8")
    state_content = state_path.read_text(encoding="utf-8")
    body = (
        f"FINAL CODE SYNTHESIS — {input.project_type}\n"
        f"Address: {input.address}\n\n"
        f"{'=' * 60}\n"
        f"COMPLETE MUNICIPAL REPORT ({municipal_name})\n"
        f"{'=' * 60}\n"
        f"{municipal_content.strip()}\n\n"
        f"{'=' * 60}\n"
        f"COMPLETE STATE REPORT ({state_name})\n"
        f"{'=' * 60}\n"
        f"{state_content.strip()}\n"
    )
    body = _append_research_sessions(body)

    path = OUTPUT_DIR / "final_summary.txt"
    header = (
        f"FirstPass Code Research Report\n"
        f"Type: final_summary\n"
        f"Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n"
        f"{'=' * 60}\n\n"
    )
    path.write_text(header + body, encoding="utf-8")

    return json.dumps(
        {
            "status": "written",
            "path": str(path),
            "filename": "final_summary.txt",
            "instruction": (
                "Merge complete. Reply once in chat with plain text only — no @mentions, no more tools. "
                f"Tell the user final_summary.txt is at {path}. Max 5 sentences. Then stop."
            ),
        }
    )


MERGE_REPORT_TOOLS = [(MergeResearchReportsInput, merge_research_reports)]
REPORT_TOOLS = [(WriteTextReportInput, write_text_report)]
