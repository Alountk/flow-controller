"""Tests for `clients.arr_has_file`, the cheap "does the arr already have it?" guard.

Only the HTTP transport is faked, so the real function body runs. The point of
these tests is the three-valued answer: `True` (has it), `False` (explicitly
not), `None` (could not tell). Collapsing `None` into `False` would turn a
transient network failure into "not imported yet" and invite a duplicate copy —
the failure the guard exists to prevent.
"""

import asyncio

import aiohttp
import pytest

from clients import arr_has_file
from tests_routes import _StubSession

RADARR_URL = "http://radarr.test:7878"
SONARR_URL = "http://sonarr.test:8989"


def _service(url: str, key: str = "radarr") -> dict:
    return {"key": key, "kind": "arr", "url": url, "api_key": "test-key"}


def test_movie_reports_true_when_the_arr_has_the_file():
    routes = {f"{RADARR_URL}/api/v3/movie/855": (200, {"id": 855, "hasFile": True})}
    session = _StubSession(routes)

    result = asyncio.run(arr_has_file(session, _service(RADARR_URL), movie_id=855))

    assert result is True


def test_episode_reports_true_when_the_arr_has_the_file():
    routes = {f"{SONARR_URL}/api/v3/episode/2286": (200, {"id": 2286, "hasFile": True})}
    session = _StubSession(routes)

    result = asyncio.run(
        arr_has_file(session, _service(SONARR_URL, "sonarr"), episode_id=2286)
    )

    assert result is True


def test_an_episode_asks_for_that_episode_not_a_season():
    routes = {f"{SONARR_URL}/api/v3/episode/2286": (200, {"id": 2286, "hasFile": False})}
    session = _StubSession(routes)

    asyncio.run(arr_has_file(session, _service(SONARR_URL, "sonarr"), episode_id=2286))

    assert session.calls[0][0] == f"{SONARR_URL}/api/v3/episode/2286"


def test_explicit_false_is_preserved():
    routes = {f"{RADARR_URL}/api/v3/movie/855": (200, {"id": 855, "hasFile": False})}
    session = _StubSession(routes)

    result = asyncio.run(arr_has_file(session, _service(RADARR_URL), movie_id=855))

    assert result is False


def test_a_missing_has_file_field_is_unknown_not_false():
    routes = {f"{RADARR_URL}/api/v3/movie/855": (200, {"id": 855})}
    session = _StubSession(routes)

    result = asyncio.run(arr_has_file(session, _service(RADARR_URL), movie_id=855))

    assert result is None


def test_an_http_error_is_unknown_not_false():
    routes = {f"{RADARR_URL}/api/v3/movie/855": (500, {})}
    session = _StubSession(routes)

    result = asyncio.run(arr_has_file(session, _service(RADARR_URL), movie_id=855))

    assert result is None, "a server error must not read as 'no file'"


class _TimeoutSession:
    def get(self, url, **kwargs):
        raise asyncio.TimeoutError()


class _ClientErrorSession:
    def get(self, url, **kwargs):
        raise aiohttp.ClientError("network is down")


@pytest.mark.parametrize("session", [_TimeoutSession(), _ClientErrorSession()])
def test_a_timeout_or_client_error_is_unknown_not_false(session):
    """The test that keeps a transient failure from causing a duplicate copy."""
    result = asyncio.run(arr_has_file(session, _service(RADARR_URL), movie_id=855))

    assert result is None


def test_without_any_id_the_answer_is_unknown():
    session = _StubSession({})

    result = asyncio.run(arr_has_file(session, _service(RADARR_URL)))

    assert result is None
    assert session.calls == [], "no id means no request to make"
