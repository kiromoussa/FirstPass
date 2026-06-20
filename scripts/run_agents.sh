#!/usr/bin/env bash
# Run all three Band agents in parallel (requires tmux or separate terminals)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Starting FirstPass code research agents..."
echo "Run 'uv run firstpass-kickoff --address \"YOUR ADDRESS\"' in another terminal to start research."
echo ""

uv run firstpass-municipal &
PID1=$!
uv run firstpass-state &
PID2=$!
uv run firstpass-synthesizer &
PID3=$!

trap 'kill $PID1 $PID2 $PID3 2>/dev/null' EXIT INT TERM

wait
