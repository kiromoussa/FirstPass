"""Run Internet Archive code scraping locally without Band — writes .txt reports."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from firstpass.archive_tool import ArchiveCodeScrapeInput, archive_code_scrape
from firstpass.config import init_environment
from firstpass.code_sources import DEFAULT_ADDRESS
from firstpass.jurisdiction import parse_city_from_address
from firstpass.report_tool import MergeResearchReportsInput, merge_research_reports


def _scrape_and_write(
    filename: str,
    report_type: str,
    scrape_input: ArchiveCodeScrapeInput,
) -> Path:
    scrape_input.auto_write_report = True
    scrape_input.report_filename = filename
    scrape_input.report_type = report_type
    raw = archive_code_scrape(scrape_input)
    data = json.loads(raw)
    if path := data.get("report_path"):
        return Path(path)
    raise RuntimeError(f"Scrape failed for {filename}: {data.get('errors', data.get('validation_warnings', raw))}")


def main() -> None:
    init_environment()

    parser = argparse.ArgumentParser(description="Scrape building codes from Internet Archive locally")
    parser.add_argument("--address", default=DEFAULT_ADDRESS)
    parser.add_argument("--project-type", default="Detached ADU")
    parser.add_argument(
        "--with-browserbase",
        action="store_true",
        help="Also browse official sources in Browserbase (slower; requires BROWSERBASE_API_KEY)",
    )
    args = parser.parse_args()

    city = parse_city_from_address(args.address) or "Oakland"

    print(f"Scraping municipal codes for {args.address} ({city})...")
    municipal_path = _scrape_and_write(
        "municipal_codes.txt",
        "municipal",
        ArchiveCodeScrapeInput(
            research_goal=f"Municipal ADU/zoning for {args.address}, {args.project_type}",
            jurisdiction=f"{city}, CA",
            address=args.address,
            project_type=args.project_type,
            search_terms=f"accessory dwelling unit ADU {city} LAMC zoning setback height lot coverage LADBS",
            use_browserbase=args.with_browserbase,
        ),
    )
    print(f"  Wrote {municipal_path}")

    print("Scraping California state ADU statutes and building code...")
    state_path = _scrape_and_write(
        "state_codes.txt",
        "state",
        ArchiveCodeScrapeInput(
            research_goal=f"State ADU statutes and building code for {args.address}, {args.project_type}",
            jurisdiction="California",
            address=args.address,
            project_type=args.project_type,
            search_terms="accessory dwelling unit ADU 65852.2 66313 ministerial setback parking height sprinkler",
            use_browserbase=args.with_browserbase,
        ),
    )
    print(f"  Wrote {state_path}")

    print("Synthesizing compliance report...")
    merge_result = json.loads(
        merge_research_reports(
            MergeResearchReportsInput(
                address=args.address,
                project_type=args.project_type,
                use_browserbase=args.with_browserbase,
            )
        )
    )
    final_path = Path(merge_result.get("path", "output/final_summary.txt"))
    print(f"  Status: {merge_result.get('status')}")
    if merge_result.get("preliminary_result"):
        print(f"  {merge_result['preliminary_result']}")
    print()
    print("Done. Output files:")
    print(f"  {municipal_path}")
    print(f"  {state_path}")
    print(f"  {final_path}")
    print(f"  output/compliance_report.json")
    print(f"  output/municipal_requirements.json")
    print(f"  output/state_requirements.json")


if __name__ == "__main__":
    main()
