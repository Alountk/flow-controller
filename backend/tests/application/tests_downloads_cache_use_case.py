"""F-06(e): the downloads snapshot — one shared window, one background poll.

`/api/downloads` used to fan out on EVERY request: two arr queues and, when
anything was queued, the aMuTorrent categories + torrents — four upstream
calls each poll, 60/min per open tab (f06-amule-local.md §1). The study chose
the local mirror (e): one background poller refreshes an in-memory snapshot
and every reader is served from memory, the way `background_checker` feeds
`/api/status`, with the TTL discipline `_trace_cache` already proved.

What these tests pin:

- the cost depends on the WINDOW, never on how many readers arrive;
- a failed refresh keeps serving the last snapshot (`status_cache` precedent:
  an unreachable service must not empty the screen);
- a failure before ANY snapshot is not dressed up as "no downloads";
- the poller sleeps through a failed tick instead of dying (a dead poller
  would freeze every reader silently).
"""

import asyncio
import time
from unittest.mock import AsyncMock, patch

import pytest

from application.use_cases import downloads_cache

_SNAPSHOT = {
    "downloads": [{"id": "1", "source": "radarr", "problem": False, "progress": 31.0}],
    "errors": [],
    "updated_at": 1728000000,
}


def _cold():
    downloads_cache._downloads_cache = None


def _read():
    return asyncio.run(downloads_cache.get_downloads())


class TestOneWindowOneFetch:
    """The whole point of (e): readers share the window, they don't pay for it."""

    def test_two_reads_inside_the_ttl_fetch_once(self):
        _cold()
        with patch.object(
            downloads_cache, "collect_downloads", new_callable=AsyncMock
        ) as collect:
            collect.return_value = dict(_SNAPSHOT)

            async def read_twice():
                return await downloads_cache.get_downloads(), await downloads_cache.get_downloads()

            first, second = asyncio.run(read_twice())

        assert first == second == _SNAPSHOT
        assert collect.call_count == 1, (
            "the second read inside the TTL paid for the arr fan-out again"
        )

    def test_an_expired_snapshot_is_refetched(self):
        """Age the entry out by hand rather than sleeping past the TTL."""
        _cold()
        with patch.object(
            downloads_cache, "collect_downloads", new_callable=AsyncMock
        ) as collect:
            collect.return_value = dict(_SNAPSHOT)
            _read()
            cached = downloads_cache._downloads_cache
            assert cached is not None, "the first read must have cached a snapshot"
            downloads_cache._downloads_cache = (
                time.time() - downloads_cache.DOWNLOADS_TTL - 1,
                cached[1],
            )
            _read()

        assert collect.call_count == 2, "an expired snapshot must be rebuilt"

    def test_the_ttl_matches_the_studys_proposal(self):
        """`f06-amule-local.md:103` proposes ~3 s; flecos T7 repeats it verbatim.

        Shorter than the 4 s the study measured for an active tab — the
        window, not the tab count, is what upstream cost now scales with.
        """
        assert downloads_cache.DOWNLOADS_TTL <= 3.0, (
            "T7 asks for the study's ~3 s window, measured from here"
        )


class TestFailuresNeverLie:
    def test_a_failed_refresh_keeps_serving_the_last_snapshot(self):
        """stale-last, the `status_cache` precedent: `/api/status` keeps
        answering from the last check when a probe throws, and the frozen
        `updated_at` is what makes the staleness visible."""
        _cold()
        with patch.object(
            downloads_cache, "collect_downloads", new_callable=AsyncMock
        ) as collect:
            collect.return_value = dict(_SNAPSHOT)
            _read()
            collect.side_effect = ConnectionError("arr unreachable")
            served = _read()

        assert served == _SNAPSHOT

    def test_a_failure_before_any_snapshot_is_not_dressed_up_as_no_downloads(self):
        """The module contract: an unreachable client must never look like
        "no downloads". With nothing to serve, the failure surfaces instead."""
        _cold()
        with patch.object(
            downloads_cache, "collect_downloads", new_callable=AsyncMock
        ) as collect:
            collect.side_effect = ConnectionError("arr unreachable")
            with pytest.raises(ConnectionError):
                _read()


class TestThePollerIsOneLongLivedLoop:
    def test_it_refreshes_on_the_ttl_until_cancelled(self):
        _cold()
        sleeps: list[float] = []

        async def stop_after_one_tick(seconds: float) -> None:
            sleeps.append(seconds)
            raise asyncio.CancelledError

        with patch.object(
            downloads_cache, "collect_downloads", new_callable=AsyncMock
        ) as collect, patch("asyncio.sleep", stop_after_one_tick):
            collect.return_value = dict(_SNAPSHOT)
            with pytest.raises(asyncio.CancelledError):
                asyncio.run(downloads_cache.downloads_poller())

        assert collect.call_count == 1
        assert sleeps == [downloads_cache.DOWNLOADS_TTL], (
            "the poller must wait exactly one TTL between refreshes"
        )
        assert downloads_cache._downloads_cache is not None, (
            "the tick's snapshot is what every reader will be served from"
        )

    def test_a_failed_refresh_leaves_the_poller_running(self):
        """`background_checker`'s contract: an exception is absorbed, the loop
        sleeps, the next tick retries. A poller that dies on the first error
        would freeze every reader on whatever was cached — silently."""
        _cold()
        sleeps: list[float] = []

        async def stop_after_one_tick(seconds: float) -> None:
            sleeps.append(seconds)
            raise asyncio.CancelledError

        with patch.object(
            downloads_cache, "collect_downloads", new_callable=AsyncMock
        ) as collect, patch("asyncio.sleep", stop_after_one_tick):
            collect.side_effect = ConnectionError("arr unreachable")
            with pytest.raises(asyncio.CancelledError):
                asyncio.run(downloads_cache.downloads_poller())

        assert sleeps == [downloads_cache.DOWNLOADS_TTL], (
            "a failed refresh must still reach the sleep — otherwise the loop died"
        )
        assert downloads_cache._downloads_cache is None, "nothing was cached, nothing faked"
