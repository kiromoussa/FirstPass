"""Local CLI for permit package review (no Band / Claude)."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from firstpass.permit.review import format_permit_package_text, review_permit_package

OUTPUT_DIR = Path(__file__).resolve().parents[3] / "output"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compare an uploaded plan set against the city's permit checklist.",
    )
    parser.add_argument("--address", required=True, help="Project address")
    parser.add_argument(
        "--plan-set",
        required=True,
        help="Path to plan set directory, sheet index .txt, or JSON manifest",
    )
    parser.add_argument("--project-type", default="Detached ADU")
    parser.add_argument(
        "--output-dir",
        default=str(OUTPUT_DIR),
        help="Directory for permit_package.json and permit_package.txt",
    )
    parser.add_argument("--json-only", action="store_true", help="Print JSON to stdout only")
    args = parser.parse_args()

    review = review_permit_package(
        address=args.address,
        plan_set_path=args.plan_set,
        project_type=args.project_type,
    )

    if args.json_only:
        print(json.dumps(review.model_dump(), indent=2))
        return

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    json_path = out_dir / "permit_package.json"
    txt_path = out_dir / "permit_package.txt"

    json_path.write_text(json.dumps(review.model_dump(), indent=2) + "\n", encoding="utf-8")
    header = (
        f"FirstPass Permit Package Review\n"
        f"Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n"
        f"{'=' * 60}\n\n"
    )
    txt_path.write_text(header + format_permit_package_text(review), encoding="utf-8")

    print(format_permit_package_text(review))
    print(f"JSON: {json_path}")
    print(f"Text: {txt_path}")


if __name__ == "__main__":
    main()
