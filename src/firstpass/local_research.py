"""Run Internet Archive code scraping locally without Band — writes .txt reports."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from firstpass.archive_tool import ArchiveCodeScrapeInput, archive_code_scrape
from firstpass.config import init_environment
from firstpass.code_sources import CODE_LAYERS, DEFAULT_ADDRESS
from firstpass.report_tool import WriteTextReportInput, write_text_report


def _scrape_and_write(
    filename: str,
    report_type: str,
    scrape_input: ArchiveCodeScrapeInput,
) -> Path:
    raw = archive_code_scrape(scrape_input)
    data = json.loads(raw)
    content = data.get("formatted_report", raw)
    result = json.loads(
        write_text_report(
            WriteTextReportInput(filename=filename, content=content, report_type=report_type)
        )
    )
    return Path(result["path"])


def _build_final_summary(layer_paths: list[tuple[str, Path]], address: str, project_type: str) -> str:
    sections = []
    for layer, path in layer_paths:
        body = path.read_text(encoding="utf-8") if path.exists() else "(missing)"
        sections.append(f"{'=' * 60}\n{layer.upper()} FINDINGS (from {path.name})\n{'=' * 60}\n{body}")
    joined = "\n\n".join(sections)
    return f"""FINAL SUMMARY — {project_type}
Address: {address}

{joined}

{'=' * 60}
SYNTHESIS
{'=' * 60}
This report combines code excerpts across every layer — municipal/zoning, state,
building (CBC), residential (CRC), plumbing (CPC), and green (CALGreen) — scraped
from Internet Archive. Where state code preempts local limits, state controls.
Verify against current official editions before submission.
"""


def main() -> None:
    init_environment()

    parser = argparse.ArgumentParser(description="Scrape building codes from Internet Archive locally")
    parser.add_argument("--address", default=DEFAULT_ADDRESS)
    parser.add_argument("--project-type", default="Detached ADU")
    parser.add_argument(
        "--with-browserbase",
        action="store_true",
        help="Also open archive.org in Browserbase (slower; requires BROWSERBASE_API_KEY)",
    )
    parser.add_argument(
        "--layers",
        default="",
        help="comma-separated subset of layers to scrape (default: all). e.g. municipal,state,green",
    )
    args = parser.parse_args()

    ocr_only = not args.with_browserbase
    only = {s.strip() for s in args.layers.split(",") if s.strip()}
    layers = [layer for layer in CODE_LAYERS if not only or layer["layer"] in only]

    # Scrape one report per code layer — this is what makes the output "all of it".
    layer_paths: list[tuple[str, Path]] = []
    for layer in layers:
        print(f"Scraping {layer['layer']} codes...")
        path = _scrape_and_write(
            layer["filename"],
            layer["layer"],
            ArchiveCodeScrapeInput(
                research_goal=f"{layer['research_goal']} for {args.address}",
                jurisdiction=layer["jurisdiction"],
                archive_item_id=layer["archive_item_id"],
                archive_url=layer["archive_url"],
                search_terms=layer["search_terms"],
                use_browserbase=not ocr_only,
            ),
        )
        layer_paths.append((layer["layer"], path))
        print(f"  Wrote {path}")

    print("Writing final summary...")
    summary_content = _build_final_summary(layer_paths, args.address, args.project_type)
    final_result = json.loads(
        write_text_report(
            WriteTextReportInput(
                filename="final_summary.txt",
                content=summary_content,
                report_type="final_summary",
            )
        )
    )
    final_path = Path(final_result["path"])
    print(f"  Wrote {final_path}")
    print()
    print("Done. Output files:")
    for _, path in layer_paths:
        print(f"  {path}")
    print(f"  {final_path}")


if __name__ == "__main__":
    main()
