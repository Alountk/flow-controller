"""The bounded poster proxy: what it serves, and everything it must refuse.

The arrs report posters as ``/MediaCover/…`` paths (Radarr's ``urlBase`` is
``/``), and the browser resolves them against THIS app's origin — where
nothing serves ``/MediaCover``, so every poster 404'd into the initials
fallback. ``GET /api/mediacover/{source}/{rest:path}`` fetches the image
server-side with the arr's API key; these tests pin both halves of its
contract:

- a configured source passes a ``MediaCover/…`` path through, forwards the
  upstream ``Content-Type`` and streams the bytes back;
- an unknown or unconfigured source, a traversal attempt and a non-MediaCover
  path are 404 with NO outbound request at all;
- an upstream failure degrades to 502 (connection failure) or the upstream
  status (everything else) with a short body of our own that leaks neither
  the arr's URL nor its API key — a missing poster must never become a 500.

Only the HTTP transport is faked (``aiohttp.ClientSession``), so the real
route body — the normalisation order included — runs.
"""

import aiohttp
import pytest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import app
from config import find_service
from routes.mediacover import _safe_mediacover_path

client = TestClient(app, raise_server_exceptions=False)

RADARR = find_service("radarr", "arr")


# ── HTTP transport stub ───────────────────────────────────────────────────────


class _Chunked:
    """``resp.content.iter_chunked`` — the route streams the body through it."""

    def __init__(self, body: bytes):
        self._body = body

    async def iter_chunked(self, size: int):
        for start in range(0, len(self._body), size):
            yield self._body[start:start + size]


class _UpstreamResponse:
    """What the route sees from ``session.get(...)`` inside its exit stack."""

    def __init__(self, status: int, body: bytes, content_type: str):
        self.status = status
        self.headers = {"Content-Type": content_type}
        self.content = _Chunked(body)

    async def __aenter__(self) -> "_UpstreamResponse":
        return self

    async def __aexit__(self, *exc) -> bool:
        return False


class _FakeArr:
    """A scripted arr: answers, failures and every call are set per test."""

    status = 200
    body = b""
    content_type = "image/jpeg"
    error: BaseException | None = None
    calls: list = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self) -> "_FakeArr":
        return self

    async def __aexit__(self, *exc) -> bool:
        return False

    async def close(self) -> None:
        return None

    def get(self, url, **kwargs):
        type(self).calls.append((str(url), dict(kwargs)))
        if type(self).error is not None:
            raise type(self).error
        return _UpstreamResponse(type(self).status, type(self).body, type(self).content_type)


@pytest.fixture
def upstream():
    """Install the fake arr as THE HTTP transport, freshly scripted."""
    _FakeArr.status = 200
    _FakeArr.body = b""
    _FakeArr.content_type = "image/jpeg"
    _FakeArr.error = None
    _FakeArr.calls = []
    with patch("aiohttp.ClientSession", _FakeArr):
        yield _FakeArr


# ── the happy path: a configured source, a MediaCover path ────────────────────


def test_the_suite_really_has_a_configured_radarr():
    """Guard the guard: every test below assumes Radarr counts as usable."""
    assert RADARR is not None
    assert RADARR["kind"] == "arr"


def test_a_configured_source_passes_the_path_through(upstream):
    upstream.body = b"\xff\xd8fake-jpeg"
    resp = client.get("/api/mediacover/radarr/MediaCover/1/poster.jpg?h=f8b1724d493fa6da0bfc")

    assert resp.status_code == 200
    assert resp.content == upstream.body  # streamed back byte for byte
    (url, kwargs), = upstream.calls
    assert url == f"{RADARR['url'].rstrip('/')}/MediaCover/1/poster.jpg?h=f8b1724d493fa6da0bfc"
    # The arr's key travels server-side; an <img src> can never send it.
    assert kwargs["headers"]["X-Api-Key"] == RADARR["api_key"]


def test_the_content_type_comes_from_upstream(upstream):
    upstream.content_type = "image/png"

    resp = client.get("/api/mediacover/radarr/MediaCover/1/poster.png")

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("image/png")
    # The upstream URL already carries a `?h=…` cache-buster of its own.
    assert "max-age" in resp.headers.get("cache-control", "")


def test_the_query_string_travels_to_the_arr(upstream):
    upstream.body = b"png-bytes"

    resp = client.get("/api/mediacover/radarr/MediaCover/1/poster.jpg?h=abc123")

    assert resp.status_code == 200
    (url, _kwargs), = upstream.calls
    assert url.endswith("/MediaCover/1/poster.jpg?h=abc123")


# ── sources: unknown and unconfigured are both 404 ────────────────────────────


def test_an_unknown_source_is_404_without_an_upstream_call(upstream):
    resp = client.get("/api/mediacover/not-a-service/MediaCover/1/poster.jpg")

    assert resp.status_code == 404
    assert upstream.calls == []
    assert RADARR["url"] not in resp.text
    assert RADARR["api_key"] not in resp.text


def test_an_unconfigured_source_is_404_without_an_upstream_call(monkeypatch, upstream):
    monkeypatch.setattr(
        "config.SERVICES",
        [
            {
                "key": "radarr",
                "kind": "arr",
                "url": "http://radarr.internal:7878",
                "api_key": "sekret-key",
                "configured": False,
            }
        ],
    )

    resp = client.get("/api/mediacover/radarr/MediaCover/1/poster.jpg")

    assert resp.status_code == 404
    assert upstream.calls == []
    assert "http://radarr.internal:7878" not in resp.text
    assert "sekret-key" not in resp.text


# ── path traversal: normalise FIRST, then require MediaCover/ ─────────────────

TRAVERSAL_ATTEMPTS = [
    pytest.param("/api/mediacover/radarr/MediaCover/../../api/v3/system/status", id="dot-dot"),
    pytest.param(
        "/api/mediacover/radarr/MediaCover/%2e%2e/%2e%2e/api/v3/system/status",
        id="encoded-dot-dot",
    ),
    pytest.param(
        "/api/mediacover/radarr/MediaCover/%252e%252e/api/v3/system/status",
        id="double-encoded-dot-dot",
    ),
    pytest.param("/api/mediacover/radarr/http://evil.example/x", id="absolute-rest-scheme-host"),
    pytest.param("/api/mediacover/radarr//etc/passwd", id="absolute-rest-rooted"),
]


@pytest.mark.parametrize("path", TRAVERSAL_ATTEMPTS)
def test_traversal_and_absolute_rests_are_404_without_an_upstream_call(upstream, path):
    resp = client.get(path)

    assert resp.status_code == 404
    assert upstream.calls == []
    assert RADARR["url"] not in resp.text
    assert RADARR["api_key"] not in resp.text


def test_the_normaliser_collapses_within_mediacover_then_checks():
    # Normalise THEN check: this resolves back under MediaCover and is allowed
    # — but only in its collapsed form.
    assert _safe_mediacover_path("MediaCover/1/../1/poster.jpg") == "MediaCover/1/poster.jpg"


def test_the_normaliser_refuses_a_rest_that_escapes_mediacover():
    # The order is the defence: the RAW string starts with "MediaCover/", so a
    # check-before-normalise would pass it and only then collapse it into a
    # path that escapes the prefix. Same for the percent-encoded dots.
    assert _safe_mediacover_path("MediaCover/../../api/v3/system/status") is None
    assert _safe_mediacover_path("MediaCover/%2e%2e/api/v3/system/status") is None
    assert _safe_mediacover_path("MediaCover/../../MediaCover/1/poster.jpg") is None
    assert _safe_mediacover_path("") is None


def test_a_non_mediacover_rest_is_404_without_an_upstream_call(upstream):
    resp = client.get("/api/mediacover/radarr/api/v3/system/status")

    assert resp.status_code == 404
    assert upstream.calls == []
    assert RADARR["url"] not in resp.text
    assert RADARR["api_key"] not in resp.text


def test_a_prefix_lookalike_is_not_mediacover(upstream):
    resp = client.get("/api/mediacover/radarr/MediaCoverX/1/poster.jpg")

    assert resp.status_code == 404
    assert upstream.calls == []


# ── upstream failures: a status, a short body, no leaks ───────────────────────


def test_an_upstream_500_is_forwarded_without_leaking(upstream):
    upstream.status = 500
    upstream.body = b"<html>Traceback ... http://localhost:7878 sekret-key ...</html>"

    resp = client.get("/api/mediacover/radarr/MediaCover/1/poster.jpg")

    assert resp.status_code == 500
    assert len(resp.content) < 200  # a short body of our own …
    assert b"Traceback" not in resp.content  # … never the upstream's
    assert RADARR["url"] not in resp.text
    assert RADARR["api_key"] not in resp.text


def test_a_missing_poster_is_the_upstream_404_not_a_500(upstream):
    upstream.status = 404

    resp = client.get("/api/mediacover/radarr/MediaCover/1/gone.jpg")

    assert resp.status_code == 404
    assert "500" not in resp.text


def test_a_connection_failure_is_502_without_leaking(upstream):
    upstream.error = aiohttp.ClientConnectionError("refused")

    resp = client.get("/api/mediacover/radarr/MediaCover/1/poster.jpg")

    assert resp.status_code == 502
    assert RADARR["url"] not in resp.text
    assert RADARR["api_key"] not in resp.text
    assert "Traceback" not in resp.text
