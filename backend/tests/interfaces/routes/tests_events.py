"""T1 — `GET /api/events`, the SSE endpoint.

Auth reuses `key_matches` (the same hash check `verify_api_key` and the C-05
edge use) because EventSource cannot send headers: `?key=` is an equivalent
channel, not a second rule.

Two transports, on purpose:

* the refusals go through `httpx.AsyncClient` over `ASGITransport` — the
  established async pattern in `tests/_stubs.py` — because a 401 is a
  complete response;
* the stream itself goes through a raw-ASGI harness (`_LiveStream`): both
  httpx's ASGITransport and starlette's TestClient run the app to COMPLETION
  and buffer the body before answering, which hangs forever against a stream
  that never ends. The harness also supplies the `http.disconnect` that must
  close the generator and unsubscribe it.
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import patch

import httpx

import event_bus
from app import app
from interfaces.http import deps as deps_module

CORRECT_KEY = "clave-correcta"


# ── Refusals: short responses, the established async client ──────────────────


async def _get(path: str) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        return await client.get(path)


def test_a_missing_key_is_refused_when_auth_requires_one():
    async def scenario():
        with patch("infrastructure.settings_store.auth_required", return_value=True), patch.object(
            deps_module, "credentials"
        ) as creds:
            creds.verify_api_key.side_effect = lambda key, salt, stored: key == CORRECT_KEY
            return await _get("/api/events")

    assert asyncio.run(scenario()).status_code == 401


def test_a_wrong_query_key_is_refused():
    async def scenario():
        with patch("infrastructure.settings_store.auth_required", return_value=True), patch.object(
            deps_module, "credentials"
        ) as creds:
            creds.verify_api_key.side_effect = lambda key, salt, stored: key == CORRECT_KEY
            return await _get("/api/events?key=otra-clave")

    assert asyncio.run(scenario()).status_code == 401


# ── The stream: raw ASGI, live chunks, real disconnect ───────────────────────


class _LiveStream:
    """Drive the app ASGI-style so SSE chunks arrive as they are sent."""

    def __init__(self, path: str, headers: dict[str, str] | None = None):
        self.status: int | None = None
        self.headers: dict[str, str] = {}
        self._chunks: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._disconnected = asyncio.Event()
        raw_headers = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
        raw_headers.append((b"host", b"testserver"))
        raw_path, _, query = path.partition("?")
        scope: dict = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": raw_path,
            "raw_path": raw_path.encode(),
            "query_string": query.encode(),
            "headers": raw_headers,
            "client": ("testclient", 50000),
            "server": ("testserver", 80),
            "root_path": "",
            "state": {},
            "extensions": {},
        }

        async def receive() -> dict:
            await self._disconnected.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict) -> None:
            if message["type"] == "http.response.start":
                self.status = message["status"]
                self.headers = {
                    k.decode().lower(): v.decode() for k, v in message["headers"]
                }
            elif message["type"] == "http.response.body":
                body = message.get("body", b"")
                if body:
                    await self._chunks.put(body)
                if not message.get("more_body", False):
                    await self._chunks.put(None)

        self._task = asyncio.create_task(app(scope, receive, send))

    async def read_until(self, *needles: bytes, timeout: float = 5.0) -> bytes:
        """Accumulate chunks until every needle is in the buffer (or EOF)."""
        buffer = b""
        deadline = asyncio.get_event_loop().time() + timeout
        while not all(needle in buffer for needle in needles):
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                raise AssertionError(
                    f"stream never produced {needles!r}; buffer={buffer[:400]!r}"
                )
            chunk = await asyncio.wait_for(self._chunks.get(), remaining)
            if chunk is None:
                raise AssertionError(
                    f"stream ended before {needles!r}; buffer={buffer[:400]!r}"
                )
            buffer += chunk
        return buffer

    async def disconnect(self) -> None:
        """Close the connection: the app must finish and unsubscribe."""
        self._disconnected.set()
        await asyncio.wait_for(self._task, 5)


async def _open(path: str, headers: dict[str, str] | None = None) -> _LiveStream:
    stream = _LiveStream(path, headers)
    # First bytes prove the generator started — and it subscribes before its
    # first yield, so anything published after this point is deliverable.
    await stream.read_until(b"retry: 3000\n\n")
    return stream


def test_the_right_query_key_opens_the_stream():
    from interfaces.http.routes import events as events_route  # noqa: PLC0415

    async def scenario():
        with patch("infrastructure.settings_store.auth_required", return_value=True), patch.object(
            deps_module, "credentials"
        ) as creds:
            creds.verify_api_key.side_effect = lambda key, salt, stored: key == CORRECT_KEY
            with patch.object(events_route, "HEARTBEAT_SECONDS", 15.0):
                stream = await _open(f"/api/events?key={CORRECT_KEY}")
                try:
                    return stream.status, stream.headers
                finally:
                    await stream.disconnect()

    status, headers = asyncio.run(scenario())
    assert status == 200
    assert headers["content-type"].startswith("text/event-stream")


def test_the_header_key_still_opens_the_stream():
    """EventSource cannot send headers, but every other client can."""
    from interfaces.http.routes import events as events_route  # noqa: PLC0415

    async def scenario():
        with patch("infrastructure.settings_store.auth_required", return_value=True), patch.object(
            deps_module, "credentials"
        ) as creds:
            creds.verify_api_key.side_effect = lambda key, salt, stored: key == CORRECT_KEY
            with patch.object(events_route, "HEARTBEAT_SECONDS", 15.0):
                stream = await _open("/api/events", headers={"X-Api-Key": CORRECT_KEY})
                try:
                    return stream.status
                finally:
                    await stream.disconnect()

    assert asyncio.run(scenario()) == 200


def test_the_wire_format_events_heartbeats_and_cleanup():
    """The exact bytes tests pin: retry hint, event frames, `: ping`, and an
    unsubscribe when the client goes away."""
    from interfaces.http.routes import events as events_route  # noqa: PLC0415

    payload = {
        "kind": "task",
        "channel": "grab",
        "task_id": "t1",
        "status": "done",
        "detail": "Release encolado",
    }
    expected_frame = (
        f"event: {payload['kind']}\ndata: {json.dumps(payload)}\n\n"
    ).encode()

    async def scenario():
        baseline = set(event_bus._bus._queues)
        with patch.object(events_route, "HEARTBEAT_SECONDS", 0.05):
            stream = await _open("/api/events")
            try:
                headers = stream.headers
                event_bus.publish(payload)
                buffer = await stream.read_until(expected_frame)
                heartbeat = await stream.read_until(b": ping\n\n")
            finally:
                await stream.disconnect()
        return headers, buffer, heartbeat, baseline

    headers, buffer, heartbeat, baseline = asyncio.run(scenario())
    assert headers["content-type"].startswith("text/event-stream")
    assert headers["cache-control"] == "no-cache"
    assert headers["x-accel-buffering"] == "no"
    assert expected_frame in buffer
    assert b": ping\n\n" in heartbeat
    assert set(event_bus._bus._queues) == baseline, (
        "a disconnected reader must be unsubscribed, not leaked"
    )
