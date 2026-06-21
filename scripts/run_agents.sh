#!/usr/bin/env bash
# Run the Band research agents in parallel.
# Set RUN_ALL_LAYERS=1 to also launch optional code-layer researchers
# (building/residential/plumbing/green). Unconfigured agents exit immediately.
set -uo pipefail
cd "$(dirname "$0")/.."

echo "Starting FirstPass code research agents..."
echo "Kickoff: paste address in Band or run: uv run firstpass-kickoff --address \"YOUR ADDRESS\""
echo ""

pids=()
start() { uv run "$1" & pids+=($!); }

start firstpass-municipal
start firstpass-state
start firstpass-synthesizer
start firstpass-compare

if [[ "${RUN_ALL_LAYERS:-0}" == "1" ]]; then
  start firstpass-building
  start firstpass-residential
  start firstpass-plumbing
  start firstpass-green
fi

trap 'kill "${pids[@]}" 2>/dev/null' EXIT INT TERM
wait
