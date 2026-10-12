"""T2(b) — the trace sweep and the downloads poller announce their refreshes.

After each *successful* refresh — and only then — a best-effort event goes
out so open dashboards invalidate immediately while the polling fallback
stays exactly as it was. A cached read inside the TTL is not a refresh and
must stay silent: the downloads poller calls `get_downloads` every tick, and
an event per tick would turn an invalidation into a second poller.
"""

from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, patch

import event_bus
from application.use_cases import downloads_cache, trace_cache


def test_a_trace_refresh_publishes_a_trace_event():
    async def scenario():
        trace_cache._trace_cache = None
        queue = event_bus.subscribe()
        try:
            with patch(
                "application.use_cases.trace_cache.build_traces", new_callable=AsyncMock
            ) as build:
                build.return_value = [{"source": "radarr"}]
                await trace_cache.get_traces()
                return await asyncio.wait_for(queue.get(), 1)
        finally:
            event_bus.unsubscribe(queue)
            trace_cache._trace_cache = None

    event = asyncio.run(scenario())
    assert event["kind"] == "trace"
    assert isinstance(event["version"], float), (
        "the version timestamp is what a client can dedupe on"
    )


def test_a_cached_trace_read_publishes_nothing():
    async def scenario():
        trace_cache._trace_cache = (time.time(), [{"source": "radarr"}])
        queue = event_bus.subscribe()
        try:
            await trace_cache.get_traces()
            await asyncio.sleep(0)
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                return True
            return False
        finally:
            event_bus.unsubscribe(queue)
            trace_cache._trace_cache = None

    assert asyncio.run(scenario()) is True, (
        "a read served from the cache is not a refresh"
    )


def test_a_downloads_refresh_publishes_a_downloads_event():
    async def scenario():
        downloads_cache._downloads_cache = None
        queue = event_bus.subscribe()
        try:
            with patch.object(
                downloads_cache, "collect_downloads", new_callable=AsyncMock
            ) as collect:
                collect.return_value = {"downloads": [], "errors": [], "updated_at": 1}
                await downloads_cache.get_downloads()
                return await asyncio.wait_for(queue.get(), 1)
        finally:
            event_bus.unsubscribe(queue)
            downloads_cache._downloads_cache = None

    event = asyncio.run(scenario())
    assert event["kind"] == "downloads"
    assert isinstance(event["version"], float)


def test_a_downloads_read_inside_the_ttl_publishes_nothing():
    """The poller ticks every DOWNLOADS_TTL; only the refresh may speak."""

    async def scenario():
        downloads_cache._downloads_cache = (
            time.time(),
            {"downloads": [], "errors": [], "updated_at": 1},
        )
        queue = event_bus.subscribe()
        try:
            await downloads_cache.get_downloads()
            await asyncio.sleep(0)
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                return True
            return False
        finally:
            event_bus.unsubscribe(queue)
            downloads_cache._downloads_cache = None

    assert asyncio.run(scenario()) is True
