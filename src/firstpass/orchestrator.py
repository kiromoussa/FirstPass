"""Kick off a Band room where agents scrape Internet Archive and write .txt reports."""

from __future__ import annotations

import argparse
import sys

from firstpass.band_client import BandClient
from firstpass.config import init_environment, load_agent_config
from firstpass.code_sources import DEFAULT_ADDRESS

AGENT_NAMES = {
    "municipal_researcher": "Municipal Code Researcher",
    "state_researcher": "State Code Researcher",
    "code_synthesizer": "Code Synthesizer",
}


def build_kickoff_message(address: str, project_type: str) -> str:
    return f"""Research building codes for this pre-submission permit review.

**Address:** {address}
**Project type:** {project_type}

Scrape codes from **Internet Archive** (archive.org) — not paywalled ICC sites.
Each researcher must save a `.txt` report to the `output/` folder.

@Municipal Code Researcher — Scrape Oakland municipal ADU/planning code from Internet Archive. Write `output/municipal_codes.txt`. Post summary when done.

@State Code Researcher — Scrape California Title 24 / Gov Code ADU sections from Internet Archive (e.g. gov.ca.bsc.residential.2025). Write `output/state_codes.txt`. Post summary when done.

@Code Synthesizer — After both researchers finish, merge findings into `output/final_summary.txt`. Post the file path and executive summary in chat.

Deliverable: three `.txt` files in `output/` — municipal_codes.txt, state_codes.txt, final_summary.txt."""


def build_mentions(exclude_agent_id: str | None = None) -> list[dict[str, str]]:
    """Build mention list from agent config for all three researchers."""
    mentions: list[dict[str, str]] = []
    for config_name, display_name in AGENT_NAMES.items():
        agent_id, _ = load_agent_config(config_name)
        if exclude_agent_id and agent_id == exclude_agent_id:
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
        agent_id, _ = load_agent_config(config_name)
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
    print("Reports will be written to: output/municipal_codes.txt, state_codes.txt, final_summary.txt")
    print()
    print("Make sure all three agents are running:")
    print("  uv run firstpass-municipal")
    print("  uv run firstpass-state")
    print("  uv run firstpass-synthesizer")


if __name__ == "__main__":
    main()
