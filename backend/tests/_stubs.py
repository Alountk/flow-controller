"""Shared test doubles — what more than one test module needs.

A test module should not be a library. `tests_routes.py` was: six other files
imported `_StubSession`, `client` or `CONFIGURED_RADARR_URL` from it, so the
thing under test and the scaffolding around it were the same file. Splitting
them is what makes it possible to move tests into separate directories at all —
without it they either share a directory or fight over import order.

Not collected by pytest: `python_files = tests*.py` does not match `_stubs`.
"""

import json
from urllib.parse import urlencode

import aiohttp
from fastapi.testclient import TestClient

from app import app
from config import SERVICES

#: One client for the whole suite. Importing it is enough: the app is built at
#: import time, and each test replaces what the routes call, not the client.
client = TestClient(app, raise_server_exceptions=False)

#: Routes resolve their service from the real config, so URL stubs must use the
#: configured Radarr URL rather than an invented one.
ARR_BY_KEY = {s["key"]: s for s in SERVICES if s["kind"] == "arr"}
CONFIGURED_RADARR_URL = ARR_BY_KEY["radarr"]["url"]

# ── HTTP transport stubs ──────────────────────────────────────────────────────


class _StubResponse:
    """Minimal stand-in for an ``aiohttp.ClientResponse``."""

    def __init__(self, status: int = 503, payload: dict | None = None):
        self.status = status
        self._payload = payload if payload is not None else {}

    async def json(self, content_type=None):
        return self._payload

    async def text(self) -> str:
        return json.dumps(self._payload)

    async def read(self) -> bytes:
        return json.dumps(self._payload).encode()

    def raise_for_status(self) -> None:
        return None

    def release(self) -> None:
        return None

    async def __aenter__(self) -> "_StubResponse":
        return self

    async def __aexit__(self, *exc) -> bool:
        return False


class _StubSession:
    """Fake ``aiohttp.ClientSession`` that matches responses by URL substring.

    Anything not explicitly scripted answers ``503`` so callers take their
    graceful-degradation path instead of touching the network.
    """

    def __init__(self, routes: dict | None = None, default_status: int = 503, default_payload=None):
        self.routes = routes or {}
        self.default_status = default_status
        self.default_payload = default_payload
        self.calls: list[tuple[str, dict]] = []

    def _resolve(self, url: str) -> _StubResponse:
        self.calls.append((url, {}))
        for fragment, (status, payload) in self.routes.items():
            if fragment in url:
                return _StubResponse(status, payload)
        return _StubResponse(self.default_status, self.default_payload)

    def get(self, url, **kwargs):
        # Query parameters take part in matching: routes like
        # `?category=radarr` carry meaning in params, not in the path, and a
        # URL-only match would silently serve the wrong payload.
        target = str(url)
        params = kwargs.get("params")
        if params:
            target += "?" + urlencode(params)
        return self._resolve(target)

    def post(self, url, **kwargs):
        return self._resolve(str(url))

    def put(self, url, **kwargs):
        return self._resolve(str(url))

    def delete(self, url, **kwargs):
        return self._resolve(str(url))

    def request(self, method, url, **kwargs):
        return self._resolve(str(url))

    def ws_connect(self, url, **kwargs):
        raise aiohttp.ClientError("network disabled in tests")

    async def close(self) -> None:
        return None

    async def __aenter__(self) -> "_StubSession":
        return self

    async def __aexit__(self, *exc) -> bool:
        return False
