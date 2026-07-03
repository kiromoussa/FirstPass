#!/usr/bin/env bash
# Weekly corpus refresh, run by launchd (see com.firstpass.corpus-refresh.plist).
# launchd doesn't source your shell profile, so PATH is set explicitly below.
# Unlike cron, launchd's StartCalendarInterval catches this up shortly after
# wake if the Mac was asleep/off at the scheduled time, instead of skipping it.
set -uo pipefail

REPO="/Users/kiromoussa/Downloads/FirstPass"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

cd "$REPO" || exit 1
mkdir -p logs
LOG="logs/corpus-refresh-$(date +%Y-%m-%d_%H%M).log"

echo "=== corpus refresh started $(date) ===" >>"$LOG" 2>&1
uv run python scripts/refresh_corpus.py --all >>"$LOG" 2>&1
REFRESH_EXIT=$?

echo >>"$LOG"
echo "=== git status: data/cities/ ===" >>"$LOG" 2>&1
git status --short data/cities/ >>"$LOG" 2>&1
CHANGED_N=$(git status --short data/cities/ | wc -l | tr -d ' ')

# A source-level fetch failure doesn't crash refresh_corpus.py (it's logged and
# skipped per-source), so grep the log for that instead of relying on exit code.
FAILED_N=$(grep -c "FETCH FAILED" "$LOG" || true)

INDEX_EXIT=0
if [ "$CHANGED_N" -gt 0 ]; then
  echo "=== rebuilding RedisVL index (content changed) ===" >>"$LOG" 2>&1
  uv run python scripts/index_codes_redisvl.py --all >>"$LOG" 2>&1
  INDEX_EXIT=$?
fi

echo "=== done $(date) — refresh_exit=$REFRESH_EXIT index_exit=$INDEX_EXIT fetch_failures=$FAILED_N changed=$CHANGED_N ===" >>"$LOG" 2>&1

# Build one honest notification instead of a blanket "success" — surface every
# real problem (crash, fetch failure, index rebuild failure) so a bad week
# doesn't silently look identical to a clean one.
PROBLEMS=""
if [ "$REFRESH_EXIT" -ne 0 ]; then PROBLEMS="${PROBLEMS}refresh_corpus.py crashed (exit $REFRESH_EXIT). "; fi
if [ "$FAILED_N" -gt 0 ]; then PROBLEMS="${PROBLEMS}$FAILED_N source fetch(es) failed. "; fi
if [ "$INDEX_EXIT" -ne 0 ]; then PROBLEMS="${PROBLEMS}RedisVL index rebuild crashed (exit $INDEX_EXIT). "; fi

if [ -n "$PROBLEMS" ]; then
  TITLE="FirstPass corpus refresh — NEEDS ATTENTION"
  BODY="${PROBLEMS}See $LOG"
elif [ "$CHANGED_N" -gt 0 ]; then
  TITLE="FirstPass corpus refresh"
  BODY="$CHANGED_N file(s) changed under data/cities/ — see $LOG"
else
  TITLE="FirstPass corpus refresh"
  BODY="No source changes this week."
fi
osascript -e "display notification \"$BODY\" with title \"$TITLE\"" 2>/dev/null || true
