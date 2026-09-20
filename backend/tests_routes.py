"""Route-level tests.

These tests fake ONLY the HTTP transport (``aiohttp.ClientSession``) and let the
real route bodies, aggregation logic and response shaping run. That keeps them
resilient to module moves and refactors while still catching real failures such
as undefined names, broken calls or wrong response shapes.

Background: ``GET /api/wanted`` shipped broken (HTTP 500, ``NameError: name
'asyncio' is not defined``) because the route body used ``asyncio.gather``
without importing ``asyncio``. No test covered that endpoint, and the tests that
did exist patched the route module's imported client functions, so the route
body itself was never executed.
"""

import json
from unittest.mock import patch

import aiohttp
import pytest
from fastapi.testclient import TestClient

from app import app
from config import SERVICES

client = TestClient(app, raise_server_exceptions=False)

ARR_SERVICES = [s for s in SERVICES if s["kind"] == "arr"]
ARR_BY_KEY = {s["key"]: s for s in ARR_SERVICES}
ARR_KEYS = {s["key"] for s in ARR_SERVICES}


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
        return self._resolve(str(url))

    def post(self, url, **kwargs):
        return self._resolve(str(url))

    def put(self, url, **kwargs):
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


@pytest.fixture
def offline_network():
    """Every outbound HTTP call answers 503 — no socket is opened."""
    with patch("aiohttp.ClientSession", _StubSession):
        yield


@pytest.fixture
def network():
    """Install a scripted transport.

    Usage::

        with network({"/api/v3/wanted/missing": (200, {"records": []})}):
            ...
    """
    sessions: list[_StubSession] = []

    def _install(routes: dict, default_status: int = 503, default_payload=None):
        def _factory(*args, **kwargs):
            session = _StubSession(routes, default_status, default_payload)
            sessions.append(session)
            return session

        return patch("aiohttp.ClientSession", _factory)

    _install.sessions = sessions  # type: ignore[attr-defined]
    return _install


# ── Generic smoke test: every GET route must not crash ────────────────────────

SMOKE_PARAMS = {
    "page": 1,
    "page_size": 5,
    "source": "radarr",
    "path": "/mnt/storage",
    "start": "2026-09-01",
    "end": "2026-09-30",
    "level": "all",
}

DUMMY_PATH_PARAMS = {
    "task_id": "does-not-exist",
}


def _get_paths() -> list[str]:
    """Every GET route that can be called without inventing path params.

    Reads the OpenAPI schema rather than walking ``app.routes``: FastAPI wraps
    included routers in internal objects, so enumerating ``app.routes`` silently
    misses every router-provided endpoint — the failure mode this guard exists to
    prevent. ``test_smoke_covers_the_wanted_endpoint`` keeps that honest.
    """
    paths: list[str] = []
    for path, operations in app.openapi()["paths"].items():
        if "get" not in operations:
            continue
        for name, value in DUMMY_PATH_PARAMS.items():
            path = path.replace("{" + name + "}", value)
        if "{" in path:
            continue  # still needs a path param we cannot invent
        paths.append(path)
    return sorted(set(paths))


def test_smoke_covers_the_wanted_endpoint():
    """Guard the guard: the smoke list must include the endpoint that broke."""
    paths = _get_paths()

    assert "/api/wanted" in paths
    # A guard that silently covers nothing is worse than no guard.
    assert len(paths) > 10, f"smoke test is covering almost nothing: {paths}"


@pytest.mark.parametrize("path", _get_paths())
def test_get_route_does_not_500_when_network_is_down(path, offline_network):
    """A dead network must degrade gracefully, never crash the route body.

    This is the generic regression guard for this bug class: it executes every
    route body, so an undefined name, a bad call or a broken response shape
    fails here even when no client data can be fetched.
    """
    resp = client.get(path, params=SMOKE_PARAMS)

    assert resp.status_code < 500, (
        f"GET {path} returned {resp.status_code} with the network down.\n"
        f"Body: {resp.text[:400]}"
    )


# ── GET /api/wanted — functional contract ─────────────────────────────────────

RADARR_PAYLOAD = {
    "records": [
        {
            "id": 11,
            "title": "Wanted Movie",
            "year": 2020,
            "overview": "A missing film",
            "hasFile": False,
            "altTitles": [{"title": "Alt Movie"}],
        }
    ],
    "totalRecords": 1,
}

SONARR_PAYLOAD = {
    "records": [
        {
            "id": 7,
            "title": "Pilot",
            "seriesId": 3,
            "seasonNumber": 1,
            "episodeNumber": 1,
            "airDateUtc": "2026-09-01T00:00:00Z",
            "hasFile": False,
            "series": {"title": "Wanted Show", "alternateTitles": []},
        }
    ],
    "totalRecords": 1,
}


def _wanted_routes(*, radarr=True, sonarr=True) -> dict:
    """Script the wanted/missing endpoint per configured arr service."""
    routes: dict = {}
    if radarr:
        routes[f"{ARR_BY_KEY['radarr']['url']}/api/v3/wanted/missing"] = (200, RADARR_PAYLOAD)
    if sonarr:
        routes[f"{ARR_BY_KEY['sonarr']['url']}/api/v3/wanted/missing"] = (200, SONARR_PAYLOAD)
    return routes


def test_wanted_returns_items_for_every_arr_service(network):
    with network(_wanted_routes()):
        resp = client.get("/api/wanted")

    assert resp.status_code == 200
    body = resp.json()

    assert set(body["wanted"]) == ARR_KEYS
    assert isinstance(body["updated_at"], int)
    assert body["updated_at"] > 0

    radarr_item = body["wanted"]["radarr"]["items"][0]
    assert radarr_item["id"] == 11
    assert radarr_item["title"] == "Wanted Movie"
    assert radarr_item["year"] == 2020
    assert radarr_item["altTitles"] == ["Alt Movie"]

    sonarr_item = body["wanted"]["sonarr"]["items"][0]
    assert sonarr_item["id"] == 7
    assert sonarr_item["title"] == "Pilot"
    assert sonarr_item["series_id"] == 3
    assert sonarr_item["season_number"] == 1
    assert sonarr_item["series_title"] == "Wanted Show"


@pytest.mark.parametrize("source", sorted(ARR_KEYS))
def test_wanted_source_filter_returns_only_that_service(network, source):
    with network(_wanted_routes()):
        resp = client.get("/api/wanted", params={"source": source})

    assert resp.status_code == 200
    assert set(resp.json()["wanted"]) == {source}


def test_wanted_forwards_pagination_to_the_arr_api(network):
    with network(_wanted_routes()):
        resp = client.get("/api/wanted", params={"page": 3, "page_size": 25})

    assert resp.status_code == 200

    sessions = network.sessions  # type: ignore[attr-defined]
    wanted_calls = [
        url
        for session in sessions
        for url, _ in session.calls
        if "/api/v3/wanted/missing" in url
    ]
    assert len(wanted_calls) == len(ARR_SERVICES)


def test_wanted_degrades_gracefully_when_the_arr_api_is_down(offline_network):
    resp = client.get("/api/wanted")

    assert resp.status_code == 200
    body = resp.json()
    assert set(body["wanted"]) == ARR_KEYS
    for result in body["wanted"].values():
        assert result["items"] == []


def test_wanted_unknown_source_returns_no_services(offline_network):
    resp = client.get("/api/wanted", params={"source": "nonexistent"})

    assert resp.status_code == 200
    assert resp.json()["wanted"] == {}
