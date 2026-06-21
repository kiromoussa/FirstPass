"""Kick off a Band room where agents scrape Internet Archive and write .txt reports."""

from __future__ import annotations

import argparse
import sys

from firstpass.band_client import BandClient
from firstpass.config import init_environment, load_agent_config
from firstpass.code_sources import CODE_LAYERS, DEFAULT_ADDRESS

# One researcher per code layer, plus the synthesizer. Agents whose config is
# absent are skipped at runtime (see _try_agent_id), so you can register only the
# layers you want and the rest are silently dropped — nothing crashes.
AGENT_NAMES = {
    "municipal_researcher": "Municipal Code Researcher",
    "state_researcher": "State Code Researcher",
    "building_researcher": "Building Code Researcher",
    "residential_researcher": "Residential Code Researcher",
    "plumbing_researcher": "Plumbing Code Researcher",
    "green_researcher": "Green Code Researcher",
    "compare_codes": "Compare Codes",
    "code_synthesizer": "Code Synthesizer",
}

# Map each researcher config key to the report file it must produce.
LAYER_BY_AGENT = {f"{layer['layer']}_researcher": layer for layer in CODE_LAYERS}


def _try_agent_id(config_name: str) -> str | None:
    """Agent id from config, or None if that agent isn't configured."""
    try:
        agent_id, _ = load_agent_config(config_name)
        return agent_id
    except (ValueError, FileNotFoundError):
        return None


def build_kickoff_message(address: str, project_type: str) -> str:
    tasks = []
    report_files = []
    for config_name, display_name in AGENT_NAMES.items():
        layer = LAYER_BY_AGENT.get(config_name)
        if not layer:
            continue
        report_files.append(layer["filename"])
        tasks.append(
            f"@{display_name} — Scrape {layer['research_goal']} from Internet Archive "
            f"(archive.org). Write `output/{layer['filename']}`. Post a summary when done."
        )
    # Compare Codes runs after the researchers (skipped if not configured).
    if _try_agent_id("compare_codes"):
        tasks.append(
            "@Compare Codes — After the researchers post their reports, compare the "
            "project's plan set against the applicable codes and flag where the design "
            "likely violates them, with the governing citation. Write "
            "`output/plan_vs_code.txt`. Post the comparison in chat."
        )
        report_files.append("plan_vs_code.txt")
    tasks.append(
        "@Code Synthesizer — After the researchers finish, merge every report into "
        "`output/final_summary.txt`. Post the file path and executive summary in chat."
    )
    deliverables = ", ".join(report_files + ["final_summary.txt"])
    body = "\n\n".join(tasks)
    return f"""Research building codes for this pre-submission permit review.

**Address:** {address}
**Project type:** {project_type}

Scrape codes from **Internet Archive** (archive.org) — not paywalled ICC sites.
Each researcher must save a `.txt` report to the `output/` folder.

{body}

Deliverable: `.txt` files in `output/` — {deliverables}."""


def build_mentions(exclude_agent_id: str | None = None) -> list[dict[str, str]]:
    """Mention list for every configured researcher (unconfigured ones skipped)."""
    mentions: list[dict[str, str]] = []
    for config_name, display_name in AGENT_NAMES.items():
        agent_id = _try_agent_id(config_name)
        if not agent_id or (exclude_agent_id and agent_id == exclude_agent_id):
            continue
        mentions.append(
            {
                "id": agent_id,
                "name": display_name,
                "handle": display_name.lower().replace(" ", "-"),
            }
        )
    return mentions


def main() -> None:
    init_environment()

    parser = argparse.ArgumentParser(description="Kick off multi-agent code research in a Band room")
    parser.add_argument(
        "--address",
        default=DEFAULT_ADDRESS,
        help="Project address to research",
    )
    parser.add_argument(
        "--project-type",
        default="Detached ADU",
        help="Project type (default: Detached ADU)",
    )
    args = parser.parse_args()

    orchestrator_id, orchestrator_key = load_agent_config("orchestrator")
    client = BandClient(orchestrator_key)

    print("Validating orchestrator connection...")
    me = client.me()
    print(f"  Connected as: {me.get('name', me.get('id', 'unknown'))}")

    print("Creating Band chat room...")
    chat = client.create_chat()
    chat_id = chat.get("id")
    if not chat_id:
        print(f"Unexpected create_chat response: {chat}", file=sys.stderr)
        sys.exit(1)
    print(f"  Room ID: {chat_id}")

    print("Adding you (room owner) as a participant...")
    owner = client.add_owner(chat_id)
    if owner:
        print("  You can now send messages in this room from app.band.ai")
    else:
        print("  Warning: could not add human owner — you may need to create the room from the Band UI")

    print("Adding agents to room...")
    orchestrator_agent_id, _ = load_agent_config("orchestrator")
    for config_name in AGENT_NAMES:
        agent_id = _try_agent_id(config_name)
        if not agent_id:
            print(f"  Skipped {AGENT_NAMES[config_name]} (not configured)")
            continue
        if agent_id == orchestrator_agent_id:
            print(f"  Skipped {AGENT_NAMES[config_name]} (already in room as owner)")
            continue
        client.add_participant(chat_id, agent_id)
        print(f"  Added {AGENT_NAMES[config_name]}")

    mentions = build_mentions(exclude_agent_id=orchestrator_agent_id)

    message = build_kickoff_message(args.address, args.project_type)
    print("Sending kickoff message...")
    client.send_message(chat_id, message, mentions)

    print()
    print("Research started! Open the Band chat room to watch agents collaborate.")
    print(f"  Room ID: {chat_id}")
    print()
    report_files = ", ".join(layer["filename"] for layer in CODE_LAYERS) + ", final_summary.txt"
    print(f"Reports will be written to output/: {report_files}")
    print()
    print("Make sure the agents you configured are running, e.g.:")
    print("  uv run firstpass-municipal / firstpass-state / firstpass-building /")
    print("  firstpass-residential / firstpass-plumbing / firstpass-green / firstpass-synthesizer")


if __name__ == "__main__":
    main()
