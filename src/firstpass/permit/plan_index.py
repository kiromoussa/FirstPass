"""Parse uploaded plan sets from directories, index files, or manifests."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

SHEET_NUMBER_RE = re.compile(
    r"\b([A-Z]{1,2}\s*[-.]?\s*\d+(?:\.\d+)?)\b",
    re.IGNORECASE,
)


@dataclass
class PlanEntry:
    label: str
    sheet: str | None = None
    source: str = ""


def _normalize_sheet(raw: str) -> str:
    cleaned = re.sub(r"\s+", "", raw.upper())
    cleaned = cleaned.replace("-", ".")
    if "." not in cleaned:
        match = re.match(r"^([A-Z]+)(\d+)$", cleaned)
        if match:
            return f"{match.group(1)}{match.group(2)}.0"
    return cleaned


def _extract_sheet(text: str) -> str | None:
    match = SHEET_NUMBER_RE.search(text)
    if not match:
        return None
    return _normalize_sheet(match.group(1))


def _parse_index_line(line: str) -> PlanEntry | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None

    sheet = _extract_sheet(stripped)
    return PlanEntry(label=stripped, sheet=sheet, source=stripped)


def load_plan_entries(plan_set_path: str | Path) -> list[PlanEntry]:
    """Load plan entries from a directory, index file, or JSON manifest."""
    path = Path(plan_set_path).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"Plan set path not found: {path}")

    if path.is_dir():
        return _load_from_directory(path)
    if path.suffix.lower() == ".json":
        return _load_from_json(path)
    return _load_from_index_file(path)


def _load_from_directory(directory: Path) -> list[PlanEntry]:
    entries: list[PlanEntry] = []
    index_candidates = ("plan_index.txt", "sheet_index.txt", "index.txt")
    for candidate in index_candidates:
        index_path = directory / candidate
        if index_path.exists():
            entries.extend(_load_from_index_file(index_path))
            break

    for file_path in sorted(directory.iterdir()):
        if not file_path.is_file():
            continue
        if file_path.name.lower() in index_candidates:
            continue
        if file_path.suffix.lower() not in {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".dwg"}:
            continue
        stem = file_path.stem.replace("_", " ")
        entries.append(
            PlanEntry(
                label=stem,
                sheet=_extract_sheet(file_path.name) or _extract_sheet(stem),
                source=file_path.name,
            )
        )
    return entries


def _load_from_index_file(path: Path) -> list[PlanEntry]:
    entries: list[PlanEntry] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        entry = _parse_index_line(line)
        if entry:
            entries.append(entry)
    return entries


def _load_from_json(path: Path) -> list[PlanEntry]:
    data = json.loads(path.read_text(encoding="utf-8"))
    sheets = data.get("sheets") or data.get("documents") or data
    if not isinstance(sheets, list):
        raise ValueError("Plan manifest JSON must contain a list under 'sheets' or 'documents'.")

    entries: list[PlanEntry] = []
    for item in sheets:
        if isinstance(item, str):
            entry = _parse_index_line(item)
            if entry:
                entries.append(entry)
            continue
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("label") or item.get("title") or "").strip()
        sheet_raw = item.get("sheet") or item.get("number")
        sheet = _normalize_sheet(str(sheet_raw)) if sheet_raw else _extract_sheet(name)
        source = str(item.get("source") or item.get("filename") or name)
        if name or sheet:
            entries.append(PlanEntry(label=name or sheet or source, sheet=sheet, source=source))
    return entries
