"""Run Internet Archive code scraping locally without Band — writes .txt reports."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from firstpass.archive_tool import ArchiveCodeScrapeInput, archive_code_scrape
from firstpass.config import init_environment
from firstpass.code_sources import ARCHIVE_ITEMS, DEFAULT_ADDRESS
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


def _build_final_summary(municipal_path: Path, state_path: Path, address: str, project_type: str) -> str:
    municipal = municipal_path.read_text(encoding="utf-8") if municipal_path.exists() else "(missing)"
    state = state_path.read_text(encoding="utf-8") if state_path.exists() else "(missing)"
    return f"""FINAL SUMMARY — {project_type}
Address: {address}

{'=' * 60}
MUNICIPAL FINDINGS (from {municipal_path.name})
{'=' * 60}
{municipal}

{'=' * 60}
STATE FINDINGS (from {state_path.name})
{'=' * 60}
{state}

{'=' * 60}
SYNTHESIS
{'=' * 60}
This report combines municipal and state code excerpts scraped from Internet Archive.
Review both sections above for applicable ADU requirements.
Verify against current official Oakland and California code editions before submission.
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
    args = parser.parse_args()

    ocr_only = not args.with_browserbase

    print(f"Scraping municipal codes for {args.address}...")
    municipal_path = _scrape_and_write(
        "municipal_codes.txt",
        "municipal",
        ArchiveCodeScrapeInput(
            research_goal=f"Municipal ADU/zoning codes for {args.address}",
            jurisdiction="Oakland, CA",
            archive_url="https://archive.org/search?query=oakland+planning+code+accessory+dwelling+unit",
            search_terms="accessory dwelling unit ADU Oakland planning setback",
            use_browserbase=not ocr_only,
        ),
    )
    print(f"  Wrote {municipal_path}")

    print("Scraping California state residential code from Internet Archive...")
    crc = ARCHIVE_ITEMS["ca_residential_2025"]
    state_path = _scrape_and_write(
        "state_codes.txt",
        "state",
        ArchiveCodeScrapeInput(
            research_goal="California Title 24 residential ADU requirements",
            jurisdiction="California",
            archive_item_id=crc["id"],
            archive_url=crc["url"],
            search_terms="accessory dwelling unit ADU setback height fire separation",
            use_browserbase=not ocr_only,
        ),
    )
    print(f"  Wrote {state_path}")

    print("Writing final summary...")
    summary_content = _build_final_summary(municipal_path, state_path, args.address, args.project_type)
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
    print(f"  {municipal_path}")
    print(f"  {state_path}")
    print(f"  {final_path}")


if __name__ == "__main__":
    main()
