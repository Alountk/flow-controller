"""The shared TTL behind `/api/trace`, in the application layer (F-07).

This cache used to live inside the route handler: a module-level global that
delivery happened to sit on, which also meant `build_traces` — the heaviest
fan-out in the app — was reachable only through an HTTP module. Moving it
here makes the staleness budget an application concern and the route a
handler again; `tests_trace_cache.py` patches this module now, not a route.

What the window buys, in the numbers that motivated it: one page-load costs
**9 outbound HTTP calls** (4 per arr plus the qBittorrent list), and the
frontend polls every 15 s *per open tab* — five tabs were forty-five calls
every fifteen seconds against three LAN services that do not change that
fast. A shared TTL shorter than the poll makes the cost depend on the
window, not on how many tabs are open: one fan-out per 10 s, period.

`build_traces` returns [] both for an idle pipeline and for a transport
failure, so an empty result cannot be told apart and is not special-cased.
What bounds a bad cache is the TTL itself: at most 10 s of staleness.
"""

from __future__ import annotations

import asyncio
import time

import event_bus
from state import http_session
from traces import build_traces

#: Seconds a cached fan-out stays good for. Deliberately shorter than the
#: frontend's 15 s poll — see the module docstring.
TRACE_TTL = 10.0

#: `(built_at, traces)`. Module state on purpose: the budget is shared by
#: every poller, which is the whole point — one window, one fan-out, no lock
#: (a lost race builds the same snapshot twice; it never builds it wrong).
_trace_cache: tuple[float, list[dict]] | None = None


async def get_traces() -> list[dict]:
    """Traces fresher than `TRACE_TTL`, built at most once per window.

    The HTTP session is opened only on a miss: a poll served from the cache
    must not even pay for creating one, which is exactly how the route
    behaved before the cache moved here.
    """
    global _trace_cache
    cached = _trace_cache
    if cached and time.time() - cached[0] < TRACE_TTL:
        return cached[1]
    async with http_session() as session:
        traces = await build_traces(session)
    _trace_cache = (time.time(), traces)
    # sse-events T2(b): the refresh itself announces the new version — a
    # best-effort event, never a reason to fail the read (the bus cannot
    # raise, and the try keeps that promise local even if it changes).
    try:
        event_bus.publish({"kind": "trace", "version": time.time()})
    except Exception:  # noqa: BLE001 — a dropped event costs one poll
        pass
    return traces


async def trace_refresher() -> None:
    """Refresh the traces every `TRACE_TTL` while someone is listening.

    Started once, from the lifespan — the `downloads_poller` pattern: B2.4
    turns the frontend's 15 s poll off while the SSE stream is connected,
    and this cache refreshes lazily (TTL + readers), so without a backend
    tick the stream-fed dashboards would freeze on whatever was last built.
    The gate is the bus itself: with no subscriber a build (nine outbound
    HTTP calls plus a SQLite read) could not be observed by anyone, so the
    tick sleeps and that is all; with at least one reader the TTL's own
    budget applies — one build per window, shared by every open tab. The
    event goes out inside `get_traces` on a real refresh, never twice from
    here.
    """
    while True:
        try:
            if event_bus.subscriber_count() >= 1:
                await get_traces()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — a failed tick must not kill the loop
            pass  # the last cache (if any) keeps serving; next tick retries
        await asyncio.sleep(TRACE_TTL)
