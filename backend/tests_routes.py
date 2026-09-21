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

import asyncio
import json
from urllib.parse import urlencode
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

# Routes resolve their service from the real config, so URL stubs must use the
# configured Radarr URL rather than an invented one.
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
            # Field name as Radarr actually sends it. The previous fixture used
            # "altTitles", the same wrong name the code read, so the mock agreed
            # with the bug and the test stayed green.
            "alternateTitles": [{"title": "Alt Movie"}],
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


# ── POST /api/calendar/grab-batch — error reporting ───────────────────────────


class TestGrabBatchErrorReporting:
    """The batch detail must carry the reason, not just a count.

    It used to return "0 OK, 1 errores" while the cause sat in `errors[]`, so a
    failed grab was undiagnosable from the UI.
    """

    def _post(self, results):
        from unittest.mock import AsyncMock

        async def _fake_grab(session, service, guid, indexer_id=0, movie_id=0, episode_id=0):
            return results[guid]

        with patch("routes.calendar.arr_grab_release", new=AsyncMock(side_effect=_fake_grab)):
            return client.post(
                "/api/calendar/grab-batch",
                json={"source": "radarr", "guids": list(results), "indexerIds": [1] * len(results), "movieId": 1},
            )

    def test_success_detail_reports_the_count(self):
        resp = self._post({"g1": {"ok": True, "detail": "ok"}})

        body = resp.json()
        assert body["ok"] is True
        assert body["detail"] == "1 descargados"
        assert body["errors"] == []

    def test_failure_detail_includes_the_reason(self):
        reason = "Couldn't find requested release in cache, try searching again"
        resp = self._post({"g1": {"ok": False, "detail": reason}})

        body = resp.json()
        assert body["ok"] is False
        assert reason in body["detail"], "the reason must reach the user, not only errors[]"
        assert body["errors"] == [{"guid": "g1", "detail": reason}]

    def test_partial_failure_reports_both_counts_and_the_reason(self):
        resp = self._post({
            "g1": {"ok": True, "detail": "ok"},
            "g2": {"ok": False, "detail": "primer fallo"},
        })

        body = resp.json()
        assert body["ok"] is False
        assert "1 OK, 1 errores" in body["detail"]
        assert "primer fallo" in body["detail"]

    def test_several_failures_summarise_the_rest(self):
        resp = self._post({
            "g1": {"ok": False, "detail": "a"},
            "g2": {"ok": False, "detail": "b"},
            "g3": {"ok": False, "detail": "c"},
        })

        body = resp.json()
        assert "3 errores" in body["detail"]
        assert "(+2 más)" in body["detail"]

    def test_unknown_service_is_reported(self):
        resp = client.post(
            "/api/calendar/grab-batch",
            json={"source": "nope", "guids": ["g1"], "indexerIds": [1]},
        )

        assert resp.json()["ok"] is False


# ── Text filter on wanted / all listings ─────────────────────────────────────


def _wanted_record(mid: int, title: str, *, year: int = 2020, alt=None) -> dict:
    return {
        "id": mid,
        "title": title,
        "year": year,
        "overview": f"Sinopsis de {title}",
        "hasFile": False,
        "alternateTitles": [{"title": t} for t in (alt or [])],
    }


class TestWantedTextFilter:
    """The filter must cover EVERY wanted item, not just the loaded page.

    Radarr paginates server-side, so a client-side filter would only ever see
    the first page. With `q` present the backend pulls everything and paginates
    the matches itself, and `total` reflects the filtered set.
    """

    RECORDS = [
        _wanted_record(1, "Todo a la vez en todas partes"),
        _wanted_record(2, "Everything Everywhere All at Once", alt=["Ton Nom"]),
        _wanted_record(3, "Otra Pelicula Cualquiera"),
        _wanted_record(4, "Ámélie"),
    ]

    @pytest.fixture(autouse=True)
    def _clear_cache(self):
        from routes.wanted import _all_wanted_cache
        _all_wanted_cache.clear()
        yield
        _all_wanted_cache.clear()

    def _get(self, query: str = "", page_size: int = 50, page: int = 1):
        payload = {"records": self.RECORDS, "totalRecords": len(self.RECORDS)}
        routes = {f"{CONFIGURED_RADARR_URL}/api/v3/wanted/missing": (200, payload)}
        with patch("aiohttp.ClientSession", lambda *a, **k: _StubSession(routes)):
            return client.get(
                "/api/wanted",
                params={"source": "radarr", "q": query, "page": page, "page_size": page_size},
            )

    def test_without_filter_behaviour_is_unchanged(self):
        body = self._get().json()

        assert "filtered" not in body
        assert body["wanted"]["radarr"]["total"] == len(self.RECORDS)

    def test_filters_by_title(self):
        body = self._get("Otra Pelicula").json()
        radarr = body["wanted"]["radarr"]

        assert body["filtered"] is True
        assert radarr["total"] == 1
        assert radarr["items"][0]["title"] == "Otra Pelicula Cualquiera"

    def test_ignores_case(self):
        assert self._get("OTRA pelicula").json()["wanted"]["radarr"]["total"] == 1

    def test_ignores_accents_on_both_sides(self):
        assert self._get("amelie").json()["wanted"]["radarr"]["total"] == 1
        assert self._get("Ámélie").json()["wanted"]["radarr"]["total"] == 1

    def test_matches_alternate_titles(self):
        body = self._get("Ton Nom").json()
        radarr = body["wanted"]["radarr"]

        assert radarr["total"] == 1
        assert radarr["items"][0]["id"] == 2

    def test_matches_the_overview(self):
        assert self._get("Sinopsis de Otra").json()["wanted"]["radarr"]["total"] == 1

    def test_total_counts_matches_not_the_loaded_page(self):
        """The whole point: 2 matches reported even though page_size is 1."""
        body = self._get("", page_size=1).json()
        assert body["wanted"]["radarr"]["total"] == len(self.RECORDS)

        filtered = self._get("e", page_size=1).json()
        assert filtered["wanted"]["radarr"]["total"] > 1
        assert len(filtered["wanted"]["radarr"]["items"]) == 1

    def test_paginates_the_filtered_set(self):
        first = self._get("e", page=1, page_size=1).json()["wanted"]["radarr"]
        second = self._get("e", page=2, page_size=1).json()["wanted"]["radarr"]

        assert len(first["items"]) == 1
        assert len(second["items"]) == 1
        assert first["items"][0]["id"] != second["items"][0]["id"]

    def test_no_matches_returns_zero(self):
        body = self._get("zzzzz").json()

        assert body["wanted"]["radarr"]["total"] == 0
        assert body["wanted"]["radarr"]["items"] == []

    def test_repeated_filters_reuse_the_cache(self):
        """Typing must not re-download the full list on every keystroke."""
        from routes.wanted import _all_wanted_cache

        payload = {"records": self.RECORDS, "totalRecords": len(self.RECORDS)}
        routes = {f"{CONFIGURED_RADARR_URL}/api/v3/wanted/missing": (200, payload)}

        with patch("aiohttp.ClientSession") as session_cls:
            session_cls.side_effect = lambda *a, **k: _StubSession(routes)
            client.get("/api/wanted", params={"source": "radarr", "q": "o"})
            client.get("/api/wanted", params={"source": "radarr", "q": "ot"})
            client.get("/api/wanted", params={"source": "radarr", "q": "otra"})

        assert "radarr" in _all_wanted_cache, "the full list should be cached"
        assert session_cls.call_count == 1, "the wanted list must be fetched once, not per keystroke"

    def test_blank_filter_is_treated_as_no_filter(self):
        body = self._get("   ").json()

        assert "filtered" not in body


class TestAllListingsTextFilter:
    """The /all endpoints paginate INSIDE the client, before the route sees them.

    A route-level test with a stubbed client cannot catch filtering the wrong
    slice, because the slicing never runs. These tests use the real client
    against a stubbed HTTP transport, so the slicing is exercised.
    """

    # "Mk" marks the items the filter targets; they are spread across pages so a
    # filter that only looked at page 1 would miss most of them.
    MOVIES = [
        {"id": i, "title": t, "year": 2000, "hasFile": False, "path": f"/x/{i}", "monitored": True}
        for i, t in enumerate(
            ["Alpha Mk", "Your Name.", "Zulu", "Beta Mk", "Gamma Mk"], start=1
        )
    ]

    def _get(self, query: str, page_size: int = 2, page: int = 1, endpoint: str = "/api/wanted/all"):
        payload = self.MOVIES
        url = f"{CONFIGURED_RADARR_URL}/api/v3/movie"
        routes = {url: (200, payload)}
        with patch("aiohttp.ClientSession", lambda *a, **k: _StubSession(routes)):
            return client.get(
                endpoint, params={"q": query, "page": page, "page_size": page_size}
            )

    def test_filter_sees_items_beyond_the_first_page(self):
        """Gamma Mk is index 5, so a page of size 2 would never contain it."""
        body = self._get("gamma", page_size=2).json()

        assert body["total"] == 1
        assert body["items"][0]["title"] == "Gamma Mk"

    def test_filter_total_counts_all_matches(self):
        body = self._get("mk", page_size=1).json()

        # Three matches spread across the 5-item list, more than one page's worth.
        assert body["total"] == 3
        assert len(body["items"]) == 1

    def test_filtered_results_still_paginate(self):
        first = self._get("mk", page=1, page_size=2).json()
        second = self._get("mk", page=2, page_size=2).json()

        assert [i["title"] for i in first["items"]] == ["Alpha Mk", "Beta Mk"]
        assert [i["title"] for i in second["items"]] == ["Gamma Mk"]

    def test_unfiltered_request_is_unchanged(self):
        body = self._get("").json()

        assert "filtered" not in body
        assert len(body["items"]) == 2
        assert body["total"] == len(self.MOVIES)

    def test_series_endpoint_also_searches_everything(self):
        payload = [
            {"id": i, "title": t, "year": 2000, "statistics": {}}
            for i, t in enumerate(["Alfa", "Rick and Morty", "Zeta"], start=1)
        ]
        routes = {f"{ARR_BY_KEY['sonarr']['url']}/api/v3/series": (200, payload)}
        with patch("aiohttp.ClientSession", lambda *a, **k: _StubSession(routes)):
            resp = client.get(
                "/api/wanted/series/all", params={"q": "rick", "page": 1, "page_size": 1}
            )

        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["title"] == "Rick and Morty"


# ── Failures must not masquerade as "nothing missing" ────────────────────────


class _RaisingSession:
    """Session whose requests blow up, so a failure happens inside the fetcher.

    Patching the constructor itself would break the route's own
    ``async with aiohttp.ClientSession()`` before the fetcher ever runs.
    """

    def __init__(self, exc: BaseException):
        self._exc = exc

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def close(self):
        return None

    def get(self, *args, **kwargs):
        raise self._exc

    def post(self, *args, **kwargs):
        raise self._exc


class TestWantedFailuresAreVisible:
    """An empty list means "Radarr found nothing" ONLY when it actually answered.

    A timeout, a rejected API key or an unreachable host used to produce the
    same empty result, and the UI stated "No hay películas faltantes" with
    confidence. Each failure now carries a reason to the screen.
    """

    @pytest.fixture(autouse=True)
    def _clear_cache(self):
        from routes.wanted import _all_wanted_cache
        _all_wanted_cache.clear()
        yield
        _all_wanted_cache.clear()

    def _get(self, transport_routes, **params):
        with patch("aiohttp.ClientSession", lambda *a, **k: _StubSession(transport_routes)):
            return client.get("/api/wanted", params={"source": "radarr", **params})

    def test_rejected_api_key_is_reported(self):
        body = self._get({"/api/v3/wanted/missing": (401, {})}).json()
        radarr = body["wanted"]["radarr"]

        assert radarr["total"] == 0
        assert radarr["error_kind"] == "auth"
        assert "401" in radarr["error"]

    def test_plain_http_error_is_reported(self):
        body = self._get({"/api/v3/wanted/missing": (500, {})}).json()

        assert body["wanted"]["radarr"]["error_kind"] == "http"

    def test_timeout_is_reported(self):
        with patch("aiohttp.ClientSession", lambda *a, **k: _RaisingSession(asyncio.TimeoutError())):
            body = client.get("/api/wanted", params={"source": "radarr"}).json()

        assert body["wanted"]["radarr"]["error_kind"] == "timeout"

    def test_connection_error_is_reported(self):
        with patch("aiohttp.ClientSession", lambda *a, **k: _RaisingSession(aiohttp.ClientError("boom"))):
            body = client.get("/api/wanted", params={"source": "radarr"}).json()

        assert body["wanted"]["radarr"]["error_kind"] == "unreachable"

    def test_a_healthy_empty_response_carries_no_error(self):
        body = self._get({"/api/v3/wanted/missing": (200, {"records": [], "totalRecords": 0})}).json()
        radarr = body["wanted"]["radarr"]

        assert radarr["total"] == 0
        assert "error" not in radarr, "genuinely empty must stay distinguishable from failed"

    def test_failure_survives_the_text_filter(self):
        """A failed fetch must not read as 'no matches for your filter'."""
        body = self._get({"/api/v3/wanted/missing": (401, {})}, q="matrix").json()
        radarr = body["wanted"]["radarr"]

        assert radarr["error_kind"] == "auth"
        assert radarr["total"] == 0

    def test_a_failed_fetch_is_not_cached(self):
        """Caching a failure would keep the UI broken for the whole TTL."""
        from routes.wanted import _all_wanted_cache

        with patch("aiohttp.ClientSession", lambda *a, **k: _StubSession(
            {"/api/v3/wanted/missing": (401, {})}
        )):
            client.get("/api/wanted", params={"source": "radarr", "q": "x"})

        assert "radarr" not in _all_wanted_cache, "a failure must never be cached"

        # Once Radarr answers, the result is served and cached.
        with patch("aiohttp.ClientSession", lambda *a, **k: _StubSession(
            {"/api/v3/wanted/missing": (200, {"records": [_wanted_record(1, "Matrix")], "totalRecords": 1})}
        )):
            body = client.get("/api/wanted", params={"source": "radarr", "q": "matrix"}).json()

        assert body["wanted"]["radarr"]["total"] == 1
        assert "radarr" in _all_wanted_cache

    def test_all_listings_report_failures_too(self):
        with patch("aiohttp.ClientSession", lambda *a, **k: _StubSession(
            {f"{CONFIGURED_RADARR_URL}/api/v3/movie": (401, {})}
        )):
            body = client.get("/api/wanted/all", params={"q": "x"}).json()

        assert body["error_kind"] == "auth"
        assert body["items"] == []


# ── Authentication boundary ──────────────────────────────────────────────────


class TestAuthBoundary:
    """Every data route requires the API key; only three are public on purpose.

    The audit that motivated this found 21 of 48 routes unauthenticated, and
    /api/config handed out the key itself — so anyone reaching the port could
    bootstrap to every credential via /api/settings.
    """

    # Public by design: the SPA shell must load, /api/config carries no secret,
    # and /api/health is the liveness probe CI and Docker use.
    PUBLIC = {
        "/",
        "/{full_path}",
        "/api/config",
        "/api/health",
        "/openapi.json",
        "/docs",
        "/docs/oauth2-redirect",
        "/redoc",
    }

    def _routes(self):
        """Every documented route, via the OpenAPI schema.

        Enumerating `app.routes` does NOT work here: FastAPI wraps included
        routers in `_IncludedRouter` objects whose sub-routes are not exposed as
        APIRoute instances, so a naive walk finds zero routes and the guard
        passes vacuously. `app.openapi()` is the public, version-stable source.
        """
        found = []
        for path, operations in app.openapi()["paths"].items():
            for method, operation in operations.items():
                params = {p.get("name") for p in operation.get("parameters", [])}
                found.append((method.upper(), path, "x-api-key" in params))
        return found

    def test_the_guard_actually_sees_routes(self):
        """A guard that enumerates nothing is worse than no guard."""
        routes = self._routes()

        assert len(routes) > 30, f"the guard only sees {len(routes)} routes"
        assert any(path == "/api/settings" for _, path, _ in routes)
        assert any(path == "/api/files/browse" for _, path, _ in routes)

    def test_every_data_route_requires_the_api_key(self):
        offenders = [
            f"{method} {path}"
            for method, path, protected in self._routes()
            if path.startswith("/api/") and path not in self.PUBLIC and not protected
        ]

        assert not offenders, (
            "These data routes are reachable without the API key:\n  "
            + "\n  ".join(sorted(offenders))
        )

    def test_config_never_returns_the_api_key(self):
        body = client.get("/api/config").json()

        assert "api_key" not in body, "the key must never be handed out anonymously"
        assert "auth_required" in body

    def test_config_is_reachable_without_credentials(self):
        """The browser needs it before it has a key."""
        assert client.get("/api/config").status_code == 200

    def test_health_is_reachable_without_credentials(self):
        assert client.get("/api/health").status_code == 200

    def test_auth_check_validates_the_key(self):
        """With API_KEY unset every request is allowed, so this passes too."""
        assert client.get("/api/auth/check").status_code == 200


# ── Service connection tester ────────────────────────────────────────────────


class TestServiceConnectionTester:
    """The tester must distinguish a rejected key from a healthy connection.

    check_arr treats HTTP 401 as "online", which hides the most likely
    misconfiguration behind a success message.
    """

    def _test(self, routes, service_key="radarr"):
        from clients import test_service_connection

        async def _run():
            async with _StubSession(routes) as session:
                return await test_service_connection(session, ARR_BY_KEY[service_key])

        return asyncio.run(_run())

    def test_a_healthy_arr_reports_its_version(self):
        routes = {"/api/v3/system/status": (200, {"appName": "Radarr", "version": "6.4.4.10685"})}

        result = self._test(routes)

        assert result["ok"] is True
        assert result["version"] == "6.4.4.10685"
        assert result["url"] == ARR_BY_KEY["radarr"]["url"]

    def test_a_rejected_api_key_is_not_reported_as_online(self):
        routes = {"/api/v3/system/status": (401, {})}

        result = self._test(routes)

        assert result["ok"] is False
        assert result["error_kind"] == "auth"
        assert "401" in result["detail"]

    def test_a_plain_http_error_is_reported(self):
        result = self._test({"/api/v3/system/status": (500, {})})

        assert result["ok"] is False
        assert result["error_kind"] == "http"

    def test_a_timeout_is_reported(self):
        from clients import test_service_connection

        async def _run():
            session = _RaisingSession(asyncio.TimeoutError())
            return await test_service_connection(session, ARR_BY_KEY["radarr"])

        result = asyncio.run(_run())

        assert result["ok"] is False
        assert result["error_kind"] == "timeout"

    def test_an_unreachable_host_is_reported(self):
        from clients import test_service_connection

        async def _run():
            session = _RaisingSession(aiohttp.ClientError("no"))
            return await test_service_connection(session, ARR_BY_KEY["radarr"])

        result = asyncio.run(_run())

        assert result["ok"] is False
        assert result["error_kind"] == "unreachable"

    def test_the_url_is_always_reported(self):
        """The migration to a proxy is exactly about which URL is reached."""
        result = self._test({"/api/v3/system/status": (401, {})})

        assert result["url"], "an error without the URL is not actionable"

    def test_the_endpoint_lists_every_service(self):
        routes = {
            "/api/v3/system/status": (200, {"version": "1.0"}),
            "/api/v2/app/version": (200, "v5.1.4"),
        }
        with patch("aiohttp.ClientSession", lambda *a, **k: _StubSession(routes)):
            resp = client.get("/api/services/test")

        body = resp.json()
        assert {r["key"] for r in body["results"]} == ARR_KEYS | {"amutorrent"}
        assert body["ok"] is True

    def test_a_single_service_can_be_tested(self):
        routes = {"/api/v3/system/status": (200, {"version": "1.0"})}
        with patch("aiohttp.ClientSession", lambda *a, **k: _StubSession(routes)):
            resp = client.get("/api/services/test", params={"service": "radarr"})

        body = resp.json()
        assert [r["key"] for r in body["results"]] == ["radarr"]


# ── Health check must not call a rejected key "online" ───────────────────────


class TestHealthCheckHonesty:
    """check_arr used to include 401 in its success set:

        if resp.status in (200, 401, 301, 302):
            return "online", "Conexión exitosa", {}

    so the dashboard showed a service as healthy when its API key was rejected.
    That sends the user to check whether the container is running, when the
    actual problem is the credential.
    """

    def _check(self, status: int):
        from clients import check_arr

        async def _run():
            session = _StubSession({"/api/v3/system/status": (status, {})})
            return await check_arr(session, ARR_BY_KEY["radarr"])

        return asyncio.run(_run())

    def test_a_valid_key_is_online(self):
        state, reason, _ = self._check(200)

        assert state == "online"
        assert "exitosa" in reason

    def test_a_rejected_key_is_misconfigured_not_online(self):
        state, reason, _ = self._check(401)

        assert state == "misconfigured", "a rejected key must never read as healthy"
        assert "401" in reason
        assert "API key" in reason

    def test_a_forbidden_key_is_misconfigured(self):
        state, _, _ = self._check(403)

        assert state == "misconfigured"

    def test_a_rejected_key_is_not_retried(self):
        """Retrying cannot fix a credential, and it delays the dashboard."""
        from unittest.mock import patch

        from clients import check_arr

        calls = []

        class _Counting(_StubSession):
            def get(self, url, **kwargs):
                calls.append(url)
                return super().get(url, **kwargs)

        async def _run():
            session = _Counting({"/api/v3/system/status": (401, {})})
            return await check_arr(session, ARR_BY_KEY["radarr"])

        with patch("asyncio.sleep"):
            state, _, _ = asyncio.run(_run())

        assert state == "misconfigured"
        assert len(calls) == 1, f"asked {len(calls)} times; a 401 needs one attempt"

    def test_a_server_error_still_goes_offline(self):
        state, _, _ = self._check(500)

        assert state == "offline"

    def test_a_refused_connection_goes_offline(self):
        from clients import check_arr

        async def _run():
            session = _RaisingSession(aiohttp.ClientError("refused"))
            return await check_arr(session, ARR_BY_KEY["radarr"])

        with patch("asyncio.sleep"):
            state, reason, _ = asyncio.run(_run())

        assert state == "offline"
        assert "ClientError" in reason

    def test_the_download_client_reports_a_rejected_key_too(self):
        from clients import check_qbit

        async def _run():
            session = _StubSession({"/api/v2/app/version": (403, {})})
            return await check_qbit(session, ARR_BY_KEY["radarr"] | {"kind": "qbit"})

        with patch("asyncio.sleep"):
            state, reason, _ = asyncio.run(_run())

        assert state == "misconfigured"
        assert "403" in reason


# ── Configured services ──────────────────────────────────────────────────────


class TestConfiguredServices:
    """An unconfigured service must be invisible, not broken.

    Without this the app calls it, gets an auth error, and reports a failure for
    something the user never set up — indistinguishable from a real outage.
    """

    def test_an_unconfigured_service_cannot_be_found(self):
        import config

        unconfigured = {"key": "radarr", "kind": "arr", "url": "", "api_key": "", "configured": False}
        with patch.object(config, "SERVICES", [unconfigured]):
            assert config.find_service("radarr", "arr") is None

    def test_a_configured_service_is_found(self):
        import config

        usable = {"key": "radarr", "kind": "arr", "url": "http://r:1", "api_key": "k", "configured": True}
        with patch.object(config, "SERVICES", [usable]):
            assert config.find_service("radarr", "arr") == usable

    def test_the_reason_distinguishes_unknown_from_unconfigured(self):
        import config

        unconfigured = {"key": "radarr", "kind": "arr", "url": "", "api_key": "", "configured": False}
        with patch.object(config, "SERVICES", [unconfigured]):
            assert "no está configurado" in config.service_unavailable_reason("radarr")
            assert "desconocido" in config.service_unavailable_reason("nope")

    def test_a_service_needs_both_url_and_key(self):
        from config import service_is_configured

        assert service_is_configured("http://r:1", "k") is True
        assert service_is_configured("", "k") is False
        assert service_is_configured("http://r:1", "") is False
        assert service_is_configured("", "") is False

    def test_only_configured_services_are_returned(self):
        import config

        mixed = [
            {"key": "radarr", "kind": "arr", "url": "http://r:1", "api_key": "k", "configured": True},
            {"key": "sonarr", "kind": "arr", "url": "", "api_key": "", "configured": False},
        ]
        with patch.object(config, "SERVICES", mixed):
            assert [s["key"] for s in config.configured_services("arr")] == ["radarr"]

    def test_the_endpoint_reports_configured_state_without_probing(self):
        import config

        mixed = [
            {"key": "radarr", "kind": "arr", "url": "http://r:1", "api_key": "k", "configured": True},
            {"key": "sonarr", "kind": "arr", "url": "", "api_key": "", "configured": False},
            {"key": "amutorrent", "kind": "qbit", "url": "http://a:1", "api_key": "k", "configured": True},
        ]
        with patch.object(config, "SERVICES", mixed), patch(
            "routes.settings.SERVICES", mixed
        ), patch("routes.settings.configured_services", return_value=[s for s in mixed if s["configured"]]):
            with patch("aiohttp.ClientSession") as session:
                body = client.get("/api/services").json()

        session.assert_not_called()
        assert body["configured"] == ["radarr", "amutorrent"]
        assert {s["key"]: s["configured"] for s in body["services"]} == {
            "radarr": True, "sonarr": False, "amutorrent": True,
        }

    def test_the_endpoint_requires_auth(self):
        from fastapi.testclient import TestClient

        from app import app as _app
        import routes.status as status_module

        with patch.object(status_module, "API_KEY", "secreta"):
            unauth = TestClient(_app, raise_server_exceptions=False)
            assert unauth.get("/api/services").status_code == 401


class TestHealthCheckSkipsUnconfigured:
    """An unconfigured service is not "down" — it was never set up."""

    def test_unconfigured_services_are_labelled_not_failed(self):
        from unittest.mock import AsyncMock as _AM

        import config

        mixed = [
            {"key": "radarr", "kind": "arr", "url": "http://r:1", "api_key": "k", "configured": True},
            {"key": "sonarr", "kind": "arr", "url": "", "api_key": "", "configured": False},
        ]
        with patch.object(config, "SERVICES", mixed), patch(
            "routes.status.configured_services", return_value=[mixed[0]]
        ), patch("routes.status.check_service", new=_AM(return_value=("online", "ok", {}))):
            body = client.get("/api/status/refresh").json()

        assert body["radarr"] == "online:ok"
        assert body["sonarr"] == "unconfigured:Sin configurar", (
            "an unconfigured service must not read as offline"
        )
        # Only the configured one can drag the flow down.
        assert body["flow"] == "running"

    def test_nothing_configured_is_not_a_stopped_flow(self):
        from unittest.mock import AsyncMock as _AM

        import config

        nothing = [
            {"key": "radarr", "kind": "arr", "url": "", "api_key": "", "configured": False},
        ]
        with patch.object(config, "SERVICES", nothing), patch(
            "routes.status.configured_services", return_value=[]
        ), patch("routes.status.check_service", new=_AM(return_value=("online", "ok", {}))):
            body = client.get("/api/status/refresh").json()

        assert body["flow"] == "unconfigured"
        assert body["flow"] != "stopped"

    def test_an_unconfigured_service_is_never_probed(self):
        from unittest.mock import AsyncMock as _AM

        import config

        mixed = [
            {"key": "radarr", "kind": "arr", "url": "http://r:1", "api_key": "k", "configured": True},
            {"key": "sonarr", "kind": "arr", "url": "", "api_key": "", "configured": False},
        ]
        probe = _AM(return_value=("online", "ok", {}))
        with patch.object(config, "SERVICES", mixed), patch(
            "routes.status.configured_services", return_value=[mixed[0]]
        ), patch("routes.status.check_service", new=probe):
            client.get("/api/status/refresh")

        probed = [call.args[1]["key"] for call in probe.await_args_list]
        assert probed == ["radarr"]
