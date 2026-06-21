"""Claude vision plan analysis — Python port of src/lib/integrations/claude.ts."""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path

from pydantic import BaseModel, Field

NUMERIC_KEYS = [
    ("unitSize", "Conditioned floor area", "sqft"),
    ("height", "Building height", "ft"),
    ("setbackRear", "Rear setback", "ft"),
    ("setbackSide", "Side setback", "ft"),
]

PLANS_DIR = Path(__file__).resolve().parents[2] / "plans"
OUTPUT_DIR = Path(__file__).resolve().parents[2] / "output"
PLAN_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".webp"}


def _discover_plan_files() -> list[Path]:
    """All readable plan sheets in plans/ (PDF/PNG/JPEG)."""
    if not PLANS_DIR.is_dir():
        return []
    return sorted(
        p
        for p in PLANS_DIR.iterdir()
        if p.is_file() and p.suffix.lower() in PLAN_EXTENSIONS
    )


class ListPlansInFolderInput(BaseModel):
    """List PDF/PNG plan files available in the plans/ folder."""


def list_plans_in_folder(_input: ListPlansInFolderInput) -> str:
    paths = _discover_plan_files()
    return json.dumps(
        {
            "plans_dir": str(PLANS_DIR),
            "files": [p.name for p in paths],
            "count": len(paths),
            "hint": "Upload PDF/PNG via the FirstPass UI or copy files into plans/.",
        },
        indent=2,
    )


class AnalyzePlanInput(BaseModel):
    """Run the FirstPass Claude plan-reader on uploaded plan files (PDF/PNG)."""

    filenames: list[str] = Field(
        default_factory=list,
        description=(
            "Plan filenames in the plans/ folder (e.g. ['A1.0.pdf']). "
            "Leave empty to analyze ALL PDF/PNG files in plans/."
        ),
    )
    project_type: str = Field(
        default="Detached ADU",
        description="Project type, e.g. Detached ADU, Attached ADU, JADU",
    )
    auto_write_report: bool = Field(
        default=True,
        description="If true, also write output/plan_facts.txt with the results.",
    )


def _resolve_plan_path(name: str) -> Path:
    name = name.strip().rstrip("/")
    if name in ("plans", "", "."):
        raise FileNotFoundError(
            f"Invalid plan path: {name!r}. Pass a filename like 'A1.0.pdf' or leave filenames empty."
        )
    path = Path(name)
    if path.is_file():
        return path
    candidate = PLANS_DIR / name
    if candidate.is_file():
        return candidate
    raise FileNotFoundError(f"Plan file not found: {name} (looked in plans/ and as absolute path)")


def _resolve_plan_paths(filenames: list[str]) -> list[Path]:
    """Resolve explicit filenames, or auto-discover all plans in plans/."""
    cleaned = [n.strip().rstrip("/") for n in filenames if n.strip().rstrip("/") not in ("plans", "", ".")]
    if cleaned:
        return [_resolve_plan_path(n) for n in cleaned]
    paths = _discover_plan_files()
    if not paths:
        raise FileNotFoundError(
            f"No plan files in {PLANS_DIR}. Upload a PDF/PNG via the FirstPass UI "
            "or copy sheets into plans/ before running visual analysis."
        )
    return paths


def _media_block(path: Path) -> dict:
    data = base64.standard_b64encode(path.read_bytes()).decode("ascii")
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return {
            "type": "document",
            "source": {"type": "base64", "media_type": "application/pdf", "data": data},
        }
    media_type = "image/png" if suffix == ".png" else "image/jpeg"
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": media_type, "data": data},
    }


def _null_facts(sheet_names: list[str]) -> dict:
    facts = [
        {
            "key": key,
            "label": label,
            "value": None,
            "unit": unit,
            "sheet": "—",
            "confidence": 0,
            "raw": "Not read from the plan set.",
        }
        for key, label, unit in NUMERIC_KEYS
    ]
    facts.append(
        {
            "key": "sheets",
            "label": "Sheets present",
            "value": sheet_names,
            "unit": "docs",
            "sheet": "—",
            "confidence": 0.95 if sheet_names else 0,
        }
    )
    return {"facts": facts}


def _format_report(facts: list[dict], project_type: str) -> str:
    lines = [
        "VISUAL PLAN ANALYSIS (Claude plan reader)",
        f"Project type: {project_type}",
        "",
    ]
    for fact in facts:
        if fact["key"] == "sheets":
            sheets = fact.get("value") or []
            lines.append(f"Sheets present: {', '.join(sheets) if sheets else '(none)'}")
            continue
        value = fact.get("value")
        unit = fact.get("unit", "")
        conf = fact.get("confidence", 0)
        sheet = fact.get("sheet", "—")
        raw = fact.get("raw", "")
        display = f"{value}{unit}" if value is not None else "not shown"
        lines.append(
            f"- {fact['label']} ({fact['key']}): {display} "
            f"[sheet {sheet}, confidence {conf:.0%}] — {raw}"
        )
    return "\n".join(lines)


def analyze_plan(input: AnalyzePlanInput) -> str:
    """Extract plan facts with Claude vision — same contract as the FirstPass web app."""
    import anthropic

    from firstpass.config import DEFAULT_MODEL

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        return json.dumps({"error": "ANTHROPIC_API_KEY not configured", "facts": _null_facts([])["facts"]})

    paths = _resolve_plan_paths(input.filenames)
    sheet_names = [p.stem for p in paths]

    schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "facts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "key": {
                            "type": "string",
                            "enum": ["unitSize", "height", "setbackRear", "setbackSide"],
                        },
                        "value": {"type": "number"},
                        "unit": {"type": "string", "enum": ["ft", "sqft"]},
                        "sheet": {"type": "string"},
                        "confidence": {"type": "number"},
                        "raw": {"type": "string"},
                    },
                    "required": ["key", "value", "unit", "sheet", "confidence", "raw"],
                },
            },
        },
        "required": ["facts"],
    }

    content: list[dict] = [
        {
            "type": "text",
            "text": (
                f"You are a licensed residential plan checker reading a {input.project_type} "
                "permit plan set. Read the drawings, dimension strings, schedules, and title "
                "blocks and report ONLY what is actually shown: conditioned/ADU floor area "
                "(unitSize, sqft), building height to ridge (ft), rear setback (ft), and side "
                "setback (ft). Cite the sheet each value came from and quote the raw label. "
                "Set confidence below 0.4 if a value is unclear or not shown — do NOT guess. "
                "Emit at most one fact per key."
            ),
        }
    ]
    for path in paths:
        content.append({"type": "text", "text": f"--- Sheet {path.stem} ---"})
        content.append(_media_block(path))

    model = os.getenv("ANTHROPIC_MODEL", DEFAULT_MODEL)
    client = anthropic.Anthropic(api_key=api_key)

    try:
        resp = client.messages.create(
            model=model,
            max_tokens=16000,
            messages=[{"role": "user", "content": content}],
            output_config={"format": {"type": "json_schema", "schema": schema}},
        )
        text = next((b.text for b in resp.content if b.type == "text"), None)
        if not text:
            payload = _null_facts(sheet_names)
        else:
            parsed = json.loads(text)
            by_key = {f["key"]: f for f in parsed.get("facts", [])}
            facts = []
            for key, label, unit in NUMERIC_KEYS:
                m = by_key.get(key)
                if not m or not isinstance(m.get("value"), (int, float)):
                    facts.append(
                        {
                            "key": key,
                            "label": label,
                            "value": None,
                            "unit": unit,
                            "sheet": "—",
                            "confidence": 0,
                            "raw": "Not read from the plan set.",
                        }
                    )
                else:
                    facts.append(
                        {
                            "key": key,
                            "label": label,
                            "value": m["value"],
                            "unit": unit,
                            "sheet": m.get("sheet") or "—",
                            "confidence": m.get("confidence", 0.5),
                            "raw": m.get("raw") or "",
                        }
                    )
            facts.append(
                {
                    "key": "sheets",
                    "label": "Sheets present",
                    "value": sheet_names,
                    "unit": "docs",
                    "sheet": "—",
                    "confidence": 0.95 if sheet_names else 0,
                }
            )
            payload = {"facts": facts}
    except Exception as exc:
        payload = _null_facts(sheet_names)
        payload["error"] = str(exc)

    formatted = _format_report(payload["facts"], input.project_type)
    payload["formatted_report"] = formatted

    if input.auto_write_report:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        report_path = OUTPUT_DIR / "plan_facts.txt"
        header = (
            "FirstPass Visual Plan Analysis\n"
            f"Project type: {input.project_type}\n"
            f"{'=' * 60}\n\n"
        )
        report_path.write_text(header + formatted + "\n", encoding="utf-8")
        payload["report_path"] = str(report_path)

    return json.dumps(payload, indent=2)


PLAN_ANALYSIS_TOOLS = [
    (ListPlansInFolderInput, list_plans_in_folder),
    (AnalyzePlanInput, analyze_plan),
]
