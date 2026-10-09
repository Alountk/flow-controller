"""`/api/trace` is the heaviest poller in the app and had no cache at all.

One page-load costs **9 outbound HTTP calls** (4 per arr + the qBittorrent
list), and the frontend asks for it every 15 s *per open tab*. Five tabs were
therefore forty-five calls every fifteen seconds against services that do not
change that fast.

A short shared TTL turns that into one fan-out per window regardless of how
many tabs are open. It is deliberately shorter than the 15 s poll: a stale
trace for at most 10 s is invisible, while a full fan-out every 15 s per tab is
not.
"""

from unittest.mock import AsyncMock, patch

from app import app
from fastapi.testclient import TestClient

client = TestClient(app, raise_server_exceptions=False)

_TRACE = [{"source": "radarr", "stage": "downloaded"}]


class TestTheTraceFanOutIsShared:
    """Since F-07 the cache lives in `application.use_cases.trace_cache`; the
    route only asks for traces. The patch points moved with it — same lesson
    as T1's offloop retargets: tests patch WHERE THE CODE IS, not where it
    used to be."""

    def _get(self):
        return client.get("/api/trace")

    def _cold(self):
        from application.use_cases import trace_cache as trace_cache

        trace_cache._trace_cache = None

    def test_a_repeated_poll_inside_the_ttl_does_not_rebuild(self):
        self._cold()
        with patch("application.use_cases.trace_cache.build_traces", new_callable=AsyncMock) as build:
            build.return_value = list(_TRACE)
            first = self._get()
            second = self._get()

        assert first.status_code == 200 and second.status_code == 200
        assert first.json() == second.json()
        assert build.call_count == 1, (
            "the second poll inside the TTL paid for all nine outbound calls again"
        )

    def test_the_result_expires_and_is_built_again(self):
        """Age the entry out by hand rather than sleeping past the TTL."""
        import time

        from application.use_cases import trace_cache as trace_cache

        self._cold()
        with patch("application.use_cases.trace_cache.build_traces", new_callable=AsyncMock) as build:
            build.return_value = list(_TRACE)
            self._get()
            built = trace_cache._trace_cache
            assert built is not None, "the first poll must have cached something"
            trace_cache._trace_cache = (time.time() - trace_cache.TRACE_TTL - 1, built[1])
            self._get()

        assert build.call_count == 2, "an expired entry must be rebuilt"

    def test_the_ttl_is_shorter_than_the_frontend_poll(self):
        """If this ever inverts, one tab pays the full fan-out every cycle again."""
        from application.use_cases import trace_cache as trace_cache

        assert trace_cache.TRACE_TTL < 15, "the frontend polls /api/trace every 15 s"


class TestTheCacheLivesInTheApplicationLayer:
    def test_the_route_no_longer_holds_the_cache(self):
        """F-07 moved the TTL and its builder out of the handler.

        The route is delivery: it answers a request. How stale the traces may
        be, and which builder runs behind the TTL, are application concerns —
        shared state a handler happened to sit on is not. The cache moving is
        also what made `build_traces` reusable from the application layer at
        all; a route that still imported the builder would keep that reuse
        blocked and keep these tests patching a delivery module.
        """
        from interfaces.http.routes import status as status

        assert not hasattr(status, "_trace_cache"), (
            "the cache belongs to application.use_cases.trace_cache now"
        )
        assert not hasattr(status, "_TRACE_TTL"), (
            "the TTL belongs to application.use_cases.trace_cache now"
        )
        assert not hasattr(status, "build_traces"), (
            "the route must reach the traces through the application layer, "
            "not hold a reference to the legacy builder"
        )
