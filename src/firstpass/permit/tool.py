"""Band tools for the Permit Agent."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from pydantic import BaseModel, Field

from firstpass.permit.review import format_permit_package_text, review_permit_package

OUTPUT_DIR = Path(__file__).resolve().parents[3] / "output"


class ReviewPermitPackageInput(BaseModel):
    """Compare an uploaded plan set against the city's official permit checklist."""

    address: str = Field(..., description="Project address — used to resolve city checklist")
    plan_set_path: str = Field(
        ...,
        description="Path to plan set directory, sheet index .txt, or JSON manifest",
    )
    project_type: str = Field(default="Detached ADU")
    auto_write_report: bool = Field(
        default=True,
        description="Write output/permit_package.json and output/permit_package.txt",
    )


def review_permit_package_tool(input: ReviewPermitPackageInput) -> str:
    """Run permit package review and optionally write reports to output/."""
    try:
        review = review_permit_package(
            address=input.address,
            plan_set_path=input.plan_set_path,
            project_type=input.project_type,
        )
    except FileNotFoundError as exc:
        return json.dumps(
            {
                "status": "error",
                "error": str(exc),
                "instruction": "Reply in chat that the plan set path was not found. Ask for a valid directory or index file.",
            }
        )
    except (ValueError, OSError) as exc:
        return json.dumps(
            {
                "status": "error",
                "error": str(exc),
                "instruction": "Reply in chat with the error and ask for a corrected plan set path.",
            }
        )

    payload: dict = {
        "status": "reviewed",
        "package_completion": review.package_completion,
        "missing_count": len(review.missing_items),
        "missing_items": review.missing_items,
        "submission_portal": review.submission_portal,
        "city": review.city,
        "review": review.model_dump(),
    }

    if input.auto_write_report:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        json_path = OUTPUT_DIR / "permit_package.json"
        txt_path = OUTPUT_DIR / "permit_package.txt"

        json_path.write_text(
            json.dumps(review.model_dump(), indent=2) + "\n",
            encoding="utf-8",
        )

        header = (
            f"FirstPass Permit Package Review\n"
            f"Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n"
            f"{'=' * 60}\n\n"
        )
        txt_path.write_text(header + format_permit_package_text(review), encoding="utf-8")

        payload["json_path"] = str(json_path)
        payload["txt_path"] = str(txt_path)
        payload["instruction"] = (
            "Reply once in Band chat with plain text only (no more tools). "
            f"Lead with package completion {review.package_completion}% and list missing items. "
            f"Files: {json_path}, {txt_path}. Max 5 sentences. Then stop."
        )
    else:
        payload["instruction"] = (
            "Reply once in chat with package completion percentage and missing items. Max 5 sentences."
        )

    return json.dumps(payload)


PERMIT_TOOLS = [(ReviewPermitPackageInput, review_permit_package_tool)]
