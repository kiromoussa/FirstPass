"""Kick off Band Chat 1 — CEO-led intake (Chats 2–3 open from the app)."""

from __future__ import annotations

import argparse
import sys

from firstpass.band_client import BandClient
from firstpass.config import init_environment, load_agent_config
from firstpass.code_sources import DEFAULT_ADDRESS

# Config key → display name for room participants (orchestrator excluded if same id).
AGENT_CONFIG = [
    ("ceo", "CEO Boss", "varbtw/ceo-boss"),
    ("project_property_manager", "Project and Property Manager", "varbtw/project-property-intake"),
    ("code_synthesizer", "Code Synthesizer", "varbtw/code-synthesizer"),
    ("municipal_researcher", "Municipal Code Researcher", "varbtw/municipal-researcher"),
    ("state_researcher", "State Code Researcher", "varbtw/state-code-researcher"),
    ("visual_analysis", "Visual Analysis", "varbtw/vis-agent"),
    ("compare_codes", "Compare Codes", "varbtw/compare-codes"),
]


def build_kickoff_message(address: str, project_type: str) -> str:
    return f"""@varbtw/ceo-boss → @varbtw/project-property-intake

**Chat 1 — Intake & Code Research**

New project for FirstPass pre-submission review.

**Address:** {address}
**Project type:** {project_type}

@varbtw/project-property-intake — The CEO has approved scope. Write `output/planner_brief.txt`, then @mention @varbtw/code-synthesizer **once**. One handoff at a time."""


def build_kickoff_mentions() -> list[dict[str, str]]:
    """Band only delivers to agents in `mentions`; route kickoff to PPM."""
    ppm_id, _ = load_agent_config("project_property_manager")
    return [
        {
            "id": ppm_id,
            "name": "Project and Property Manager",
            "handle": "project-property-intake",
        }
    ]


def build_mentions(exclude_agent_id: str | None = None) -> list[dict[str, str]]:
    mentions: list[dict[str, str]] = []
    for config_name, display_name, handle in AGENT_CONFIG:
        agent_id, _ = load_agent_config(config_name)
        if exclude_agent_id and agent_id == exclude_agent_id:
            continue
        mentions.append(
            {
                "id": agent_id,
                "name": display_name,
                "handle": handle.split("/")[-1],
            }
        )
    return mentions


def main() -> None:
    init_environment()

    parser = argparse.ArgumentParser(description="Kick off CEO-led Band workflow")
    parser.add_argument("--address", default=DEFAULT_ADDRESS, help="Project address")
    parser.add_argument("--project-type", default="Detached ADU", help="Project type")
    args = parser.parse_args()

    # Prefer CEO as orchestrator; fall back to orchestrator key in config.
    try:
        orchestrator_id, orchestrator_key = load_agent_config("ceo")
    except ValueError:
        orchestrator_id, orchestrator_key = load_agent_config("orchestrator")

    client = BandClient(orchestrator_key)

    print("Validating orchestrator connection...")
    me = client.me()
    print(f"  Connected as: {me.get('handle') or me.get('name') or me.get('id')}")

    print("Creating Band chat room...")
    chat = client.create_chat()
    chat_id = chat.get("id")
    if not chat_id:
        print(f"Unexpected create_chat response: {chat}", file=sys.stderr)
        sys.exit(1)
    print(f"  Room ID: {chat_id}")

    print("Adding you (room owner)...")
    owner = client.add_owner(chat_id)
    print("  OK" if owner else "  Warning: could not add human owner")

    print("Adding agents...")
    for config_name, display_name, _ in AGENT_CONFIG:
        agent_id, _ = load_agent_config(config_name)
        if agent_id == orchestrator_id:
            print(f"  Skipped {display_name} (orchestrator already in room)")
            continue
        client.add_participant(chat_id, agent_id)
        print(f"  Added {display_name}")

    mentions = build_kickoff_mentions()
    message = build_kickoff_message(args.address, args.project_type)
    print("Sending kickoff...")
    client.send_message(chat_id, message, mentions)

    print()
    print("Workflow started. Keep local listeners running:")
    print("  ./scripts/run_workflow_agents.sh")
    print(f"  Room: {chat_id}")


if __name__ == "__main__":
    main()
