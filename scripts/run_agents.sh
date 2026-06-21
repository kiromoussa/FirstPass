#!/usr/bin/env bash
# Run the core Band code-research agents in parallel.
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

trap 'kill "${pids[@]}" 2>/dev/null' EXIT INT TERM
wait
