"""B2.3 — the trace refresher builds only when someone can observe it.

Since B2.4 the frontend's 15 s `['trace']` poll sleeps while the SSE stream
is connected, and `get_traces` refreshes lazily (TTL + readers): on the
stream no read arrives, the TTL never fires, and the kanban freezes on
whatever was last built. The refresher is the backend half of that gate —
`downloads_poller`'s loop with one condition in front of the build:

- no subscriber: a build nobody could see (9 outbound HTTP calls + a SQLite
  read) must not run — the tick sleeps and that is all;
- at least one subscriber: one build per `TRACE_TTL`, shared by every open
  tab (the TTL's own budget — the event is already published inside
  `get_traces` on a real refresh, never here);
- a failed tick is absorbed and retried next tick: a refresher that died on
  the first error would freeze the stream-fed dashboards silently.

What these tests pin, mirroring `TestThePollersIsOneLongLivedLoop`:
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from application.use_cases import trace_cache


def _refresher_runs_ticks(sleeps: list[float], stop_after: int):
    """Patch the sleep so N ticks cost no wall clock; cancel on the Nth."""

    async def stop(seconds: float) -> None:
        sleeps.append(seconds)
        if len(sleeps) >= stop_after:
            raise asyncio.CancelledError

    return patch("asyncio.sleep", stop)


def test_with_nobody_listening_it_never_builds():
    """Zero subscribers across ≥2 ticks → 0 builds, TTL-paced sleeps only."""
    sleeps: list[float] = []
    bus = MagicMock()
    bus.subscriber_count.return_value = 0

    with patch.object(trace_cache, "event_bus", bus), patch.object(
        trace_cache, "get_traces", new_callable=AsyncMock
    ) as get, _refresher_runs_ticks(sleeps, stop_after=2):
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(trace_cache.trace_refresher())

    assert get.call_count == 0, (
        "with no SSE reader a build would be 9 outbound calls nobody can observe"
    )
    assert sleeps == [trace_cache.TRACE_TTL, trace_cache.TRACE_TTL], (
        "an idle tick must wait exactly one TTL before the next check"
    )


def test_with_a_subscriber_it_builds_every_ttl():
    """One tab on the stream: every tick builds (and only the TTL paces it)."""
    sleeps: list[float] = []
    bus = MagicMock()
    bus.subscriber_count.return_value = 1

    with patch.object(trace_cache, "event_bus", bus), patch.object(
        trace_cache, "get_traces", new_callable=AsyncMock
    ) as get, _refresher_runs_ticks(sleeps, stop_after=2):
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(trace_cache.trace_refresher())

    assert get.call_count == 2, "each tick with a subscriber must refresh"
    assert sleeps == [trace_cache.TRACE_TTL, trace_cache.TRACE_TTL], (
        "the refresher cadence IS the TTL — a faster one multiplies the fan-out"
    )


def test_a_failed_tick_leaves_the_refresher_running():
    """`background_checker`'s contract, cloned: absorb, sleep, retry. A
    refresher that died on the first error would freeze every stream-fed
    dashboard on whatever was last built — silently."""
    sleeps: list[float] = []
    bus = MagicMock()
    bus.subscriber_count.return_value = 1

    with patch.object(trace_cache, "event_bus", bus), patch.object(
        trace_cache, "get_traces", new_callable=AsyncMock
    ) as get, _refresher_runs_ticks(sleeps, stop_after=1):
        get.side_effect = ConnectionError("arr unreachable")
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(trace_cache.trace_refresher())

    assert get.call_count == 1, "the tick was attempted before it failed"
    assert sleeps == [trace_cache.TRACE_TTL], (
        "a failed tick must still reach the sleep — otherwise the loop died"
    )
