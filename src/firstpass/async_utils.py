"""Thread helpers for running sync Playwright under an active asyncio loop."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError

DEFAULT_THREAD_TIMEOUT = 120


def run_sync_in_thread(fn, *args, timeout_seconds: int = DEFAULT_THREAD_TIMEOUT, **kwargs):
    """Run sync Playwright safely when Band's asyncio loop is active."""
    try:
        asyncio.get_running_loop()
        in_async = True
    except RuntimeError:
        in_async = False

    if not in_async:
        return fn(*args, **kwargs)

    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(fn, *args, **kwargs)
        try:
            return future.result(timeout=timeout_seconds)
        except FuturesTimeoutError as exc:
            future.cancel()
            raise TimeoutError(f"Operation timed out after {timeout_seconds}s") from exc
