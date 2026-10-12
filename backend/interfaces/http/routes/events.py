"""`GET /api/events` — server-sent events (sse-events T1).

The transport for `event_bus`: one long-lived response per reader, heartbeats
to keep proxies from reaping an idle stream, and auth through the SAME rule
the rest of the app uses. EventSource cannot send headers, so `?key=` is
accepted as an equivalent channel — it is routed through `key_matches`, the
one hash comparison `verify_api_key` and the C-05 edge already share, not a
second copy of the rules.

Wire format (pinned by `tests/interfaces/routes/tests_events.py`)::

    retry: 3000                      once, at open — the browser's reconnect hint
    event: <kind>\\n                  kind is one of task | trace | downloads
    data: <json>\\n\\n
    : ping\\n\\n                       every ~15 s while idle (proxy heartbeat)

Deployment note — nginx. The response already carries ``Cache-Control:
no-cache`` and ``X-Accel-Buffering: no`` (nginx honors the latter per
response, so a global ``proxy_buffering on`` stays correct everywhere else),
and the ODD doc still remembers the buffering incident, so the deployment
documents the belt-and-suspenders location block::

    location /api/events {
        proxy_pass         http://flow_controller;
        proxy_http_version 1.1;
        proxy_set_header   Connection "";
        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 3600s;
    }

The ``: ping`` comments every ~15 s are what keep ``proxy_read_timeout``
from closing an idle stream; the retry hint plus the client's native
EventSource reconnect cover a dropped connection, and the polling fallback
(``refetchInterval``, deliberately still on) repairs whatever a missed
event would have refreshed.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import StreamingResponse

import event_bus
from interfaces.http.deps import key_matches

router = APIRouter()

#: Idle gap after which a `: ping` comment goes out. Well under any proxy's
#: read timeout (nginx defaults to 60 s) — tests patch it down to milliseconds.
HEARTBEAT_SECONDS = 15.0

#: The `retry:` hint: how long the browser waits before reconnecting.
RETRY_MILLIS = 3000


async def _stream():
    """The SSE body: retry hint, events off the bus, heartbeat in the gaps.

    The queue is subscribed BEFORE the first yield (so the first bytes the
    client sees prove delivery is armed) and unsubscribed in `finally` — a
    disconnect closes the generator, and closing it must not leak the queue.
    """
    queue = event_bus.subscribe()
    try:
        yield f"retry: {RETRY_MILLIS}\n\n"
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
            except asyncio.TimeoutError:
                yield ": ping\n\n"
                continue
            kind = event.get("kind", "task")
            yield f"event: {kind}\ndata: {json.dumps(event)}\n\n"
    finally:
        event_bus.unsubscribe(queue)


@router.get("/api/events")
async def events(
    key: str | None = Query(default=None),
    x_api_key: str | None = Header(default=None),
):
    """Open the stream for a reader that proved the key (or needs no key).

    Auth is checked BEFORE the stream opens: a 401 is a complete response,
    while an unauthorized stream would never end.
    """
    # Same lazy import `verify_api_key` uses: the gateways are bound by the
    # composition root before any route can run.
    from application.gateways import auth_required as _auth_required

    if _auth_required() and not key_matches(key or x_api_key):
        raise HTTPException(status_code=401, detail="API key inválida")

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
