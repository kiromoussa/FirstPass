"""Write research reports to local .txt files."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from pydantic import BaseModel, Field

OUTPUT_DIR = Path(__file__).resolve().parents[2] / "output"


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

    path.write_text(header + input.content.strip() + "\n", encoding="utf-8")

    return json.dumps(
        {
            "status": "written",
            "path": str(path),
            "filename": filename,
            "bytes": path.stat().st_size,
            "message": f"Report saved to {path}",
        },
        indent=2,
    )


REPORT_TOOLS = [(WriteTextReportInput, write_text_report)]
