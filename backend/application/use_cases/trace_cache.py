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

import time

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
    return traces
