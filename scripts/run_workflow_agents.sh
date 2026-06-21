#!/usr/bin/env bash
# Run local Band listeners for the 3-chat firm workflow (CEO → Permit → CEO).
set -uo pipefail
cd "$(dirname "$0")/.."

LOG_DIR="${FIRSTPASS_LOG_DIR:-/tmp/firstpass-agents}"
mkdir -p "$LOG_DIR"

echo "Starting FirstPass workflow agents (3-chat firm workflow)..."
echo "Logs: $LOG_DIR"
echo ""
echo "Chat 1 kickoff (CEO only — app sends this automatically):"
echo "  @varbtw/ceo-boss"
echo "  <project address from FirstPass UI>"
echo ""

pids=()
start() {
  local cmd=$1
  local log="$LOG_DIR/${cmd}.log"
  echo "→ $cmd (log: $log)"
  uv run "$cmd" >"$log" 2>&1 &
  pids+=($!)
}

start firstpass-ceo
start firstpass-project-property-manager
start firstpass-synthesizer
start firstpass-municipal
start firstpass-state
start firstpass-visual
start firstpass-compare

# Registered in Band as @varbtw/improve-agent:
start firstpass-solutions
start firstpass-permit-agent

echo ""
echo "Started ${#pids[@]} processes. PIDs: ${pids[*]}"
echo "Stop all: kill ${pids[*]}"

trap 'kill "${pids[@]}" 2>/dev/null' EXIT INT TERM
wait
