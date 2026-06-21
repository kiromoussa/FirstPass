#!/usr/bin/env bash
# Run the Band research agents in parallel (requires tmux or separate terminals).
# Set RUN_ALL_LAYERS=1 to also launch the optional code-layer researchers
# (building/residential/plumbing/green). Unconfigured agents exit immediately, so
# only enable layers you've registered in firstpass.config.yaml.
set -uo pipefail
cd "$(dirname "$0")/.."

echo "Starting FirstPass code research agents..."
echo "Run 'uv run firstpass-kickoff --address \"YOUR ADDRESS\"' in another terminal to start research."
echo ""

pids=()
start() { uv run "$1" & pids+=($!); }

# Core three (pre-registered).
start firstpass-municipal
start firstpass-state
start firstpass-synthesizer

# Optional per-layer researchers.
if [[ "${RUN_ALL_LAYERS:-0}" == "1" ]]; then
  start firstpass-building
  start firstpass-residential
  start firstpass-plumbing
  start firstpass-green
fi

trap 'kill "${pids[@]}" 2>/dev/null' EXIT INT TERM
wait
