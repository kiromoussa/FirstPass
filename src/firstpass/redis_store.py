"""Shared Redis client for the Band agents — the firm's blackboard.

This is the Python half of FirstPass's "Redis as shared brain" (see
docs/REDIS_PLAN.md). The Next.js app already persists project state and the code
corpus to Redis via ``src/lib/store.ts``; this module lets the Python Band agents
write their research artifacts to the SAME Redis so the dashboard — and every
downstream agent — reads from Redis instead of re-parsing ``output/*.txt``. That
closes the split-brain gap: Compare Codes can read the Municipal researcher's
output without opening a file.

Design mirrors store.ts: best-effort. If ``REDIS_URL`` is unset or the ``redis``
package isn't installed, every call is a silent no-op so an agent never crashes
because Redis is down — the file-based flow (output/*.txt) still works.

Keys (namespaced; JSON string values unless noted), matching REDIS_PLAN.md §3.1:

    project:active                 STRING  current project id (set at kickoff)
    project:{id}:meta              STRING  {address, project_type, citySlug, ...}
    project:{id}:blackboard        HASH    field per artifact + "{field}_at"
    project:{id}:events            PUBSUB  {"from", "type", "field"} on write
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone

# Six-hour TTL on per-project keys, matching the Next.js store (store.ts kvSet).
_TTL_SECONDS = 60 * 60 * 6

# Map a report filename / report_type to its blackboard field. Anything not
# listed falls back to the file's stem so nothing silently vanishes.
ARTIFACT_FIELDS = {
    "municipal_codes": "municipal_codes",
    "state_codes": "state_codes",
    "final_summary": "final_summary",
    "compare_codes": "plan_vs_code",
    "plan_vs_code": "plan_vs_code",
    "permit_report": "permit_report",
    "planner_brief": "planner_brief",
    "visual_analysis": "visual_analysis",
}

_client = None
_tried = False


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _redis():
    """Lazily build a Redis client from REDIS_URL. Returns None (no-op mode) when
    REDIS_URL is unset or the redis package / connection is unavailable."""
    global _client, _tried
    if _client is not None or _tried:
        return _client
    _tried = True
    url = os.getenv("REDIS_URL")
    if not url:
        return None
    try:
        import redis  # type: ignore

        # decode_responses so we deal in str, not bytes — matches JSON handling.
        _client = redis.Redis.from_url(url, decode_responses=True, socket_timeout=5)
        _client.ping()
    except Exception:
        _client = None
    return _client


def enabled() -> bool:
    """True when a live Redis connection is available."""
    return _redis() is not None


def field_for(name: str) -> str:
    """Resolve a report filename/type (e.g. 'municipal_codes.txt') to a
    blackboard field, falling back to the cleaned stem."""
    stem = name.rsplit("/", 1)[-1]
    if stem.endswith(".txt"):
        stem = stem[:-4]
    return ARTIFACT_FIELDS.get(stem, stem)


def resolve_project_id(explicit: str | None = None) -> str:
    """The project these artifacts belong to. Precedence:
    explicit arg → FIRSTPASS_PROJECT_ID env → Redis ``project:active`` → "latest".

    The Next.js project id is canonical; orchestrator.py sets ``project:active``
    at kickoff so the long-running agent listeners pick it up without per-message
    plumbing. "latest" is a last-resort so a stray write is still recoverable."""
    if explicit:
        return explicit
    env = os.getenv("FIRSTPASS_PROJECT_ID")
    if env:
        return env
    r = _redis()
    if r is not None:
        try:
            active = r.get("project:active")
            if active:
                return active
        except Exception:
            pass
    return "latest"


def set_active_project(project_id: str, meta: dict | None = None) -> bool:
    """Mark ``project_id`` as the active project (called at kickoff) and store its
    meta. Returns False in no-op mode."""
    r = _redis()
    if r is None:
        return False
    try:
        r.set("project:active", project_id, ex=_TTL_SECONDS)
        if meta is not None:
            r.set(f"project:{project_id}:meta", json.dumps(meta), ex=_TTL_SECONDS)
        return True
    except Exception:
        return False


def ensure_project(project_id: str, meta: dict | None = None) -> None:
    """Create the project's meta key if absent. Best-effort no-op on failure."""
    r = _redis()
    if r is None:
        return
    try:
        key = f"project:{project_id}:meta"
        if meta is not None and not r.exists(key):
            r.set(key, json.dumps(meta), ex=_TTL_SECONDS)
    except Exception:
        pass


def hset_artifact(field: str, content: str, project_id: str | None = None) -> bool:
    """Publish a research artifact to the project blackboard.

    Writes the content and a ``{field}_at`` ISO timestamp to
    ``project:{id}:blackboard`` (a HASH), refreshes the TTL, and publishes a
    ``project:{id}:events`` notification so the dashboard can react. Returns False
    in no-op mode so callers can branch on whether Redis actually persisted."""
    r = _redis()
    if r is None:
        return False
    pid = resolve_project_id(project_id)
    key = f"project:{pid}:blackboard"
    try:
        r.hset(key, mapping={field: content, f"{field}_at": _now_iso()})
        r.expire(key, _TTL_SECONDS)
        r.publish(
            f"project:{pid}:events",
            json.dumps({"from": field, "type": "artifact", "field": field}),
        )
        return True
    except Exception:
        return False


def get_artifact(field: str, project_id: str | None = None) -> str | None:
    """Read one blackboard artifact. None in no-op mode or when absent."""
    r = _redis()
    if r is None:
        return None
    pid = resolve_project_id(project_id)
    try:
        return r.hget(f"project:{pid}:blackboard", field)
    except Exception:
        return None


def get_blackboard(project_id: str | None = None) -> dict:
    """The full blackboard hash for a project ({} in no-op mode)."""
    r = _redis()
    if r is None:
        return {}
    pid = resolve_project_id(project_id)
    try:
        return r.hgetall(f"project:{pid}:blackboard") or {}
    except Exception:
        return {}
