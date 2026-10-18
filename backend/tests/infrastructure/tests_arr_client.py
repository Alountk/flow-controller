"""`arr_movie_file` — where the file Radarr holds for a movie lives (T11/S10).

The "does the arr already have it?" question of `arr_has_file`, one level
deeper: not a boolean but the ABSOLUTE path of the file, or `None` for every
"no" (not in the library, no file yet, could not ask). The route's `ready`
state is built from that path, so a fabricated or partial answer would place
the wrong file in the mixer slot — every case below pins a conservative `None`
over a guess.

Only the HTTP transport is faked (`_StubSession`), so the real function body
runs. Written next to `tests_arr_has_file.py`, its transport twin.
"""

import asyncio

import aiohttp
import pytest

from infrastructure import arr_client
from tests._stubs import _StubSession

RADARR_URL = "http://radarr.test:7878"

MOVIE_WITH_FILE = {
    "id": 42,
    "tmdbId": 550,
    "title": "Dune Parte Dos",
    "path": "/movies/Dune Parte Dos (2024)",
    "hasFile": True,
    "movieFile": {"relativePath": "Dune.Parte.Dos.2024.1080p.mkv"},
}


def _service(url: str = RADARR_URL, key: str = "radarr") -> dict:
    return {"key": key, "kind": "arr", "url": url, "api_key": "test-key"}


def _session(payload, status: int = 200) -> _StubSession:
    return _StubSession({f"{RADARR_URL}/api/v3/movie": (status, payload)})


def _file_of(payload, tmdb_id=550, session=None, status=200):
    session = session if session is not None else _session(payload, status)
    return asyncio.run(arr_client.arr_movie_file(session, _service(), tmdb_id))


def test_a_movie_with_a_file_reports_its_absolute_path():
    assert _file_of([MOVIE_WITH_FILE]) == (
        "/movies/Dune Parte Dos (2024)/Dune.Parte.Dos.2024.1080p.mkv"
    )


def test_the_match_is_by_tmdb_id():
    other = dict(MOVIE_WITH_FILE, id=7, tmdbId=123)

    assert _file_of([other, MOVIE_WITH_FILE], tmdb_id=550) == (
        "/movies/Dune Parte Dos (2024)/Dune.Parte.Dos.2024.1080p.mkv"
    )


def test_the_radarr_movie_id_is_accepted_too():
    """The mixer's status query carries `movie.id` — the Radarr id the T7
    lookup hands the UI. The parameter is named `tmdb_id` (the contract's
    signature), so the match accepts both identities; the internal id wins
    when a value collides, because that is what the caller actually holds.
    """
    colliding = dict(MOVIE_WITH_FILE, id=3, tmdbId=42)

    assert _file_of([colliding, MOVIE_WITH_FILE], tmdb_id=42) == (
        "/movies/Dune Parte Dos (2024)/Dune.Parte.Dos.2024.1080p.mkv"
    )


def test_a_movie_without_a_file_answers_none():
    movie = {"id": 42, "tmdbId": 550, "path": "/movies/Dune Parte Dos (2024)", "hasFile": False}

    assert _file_of([movie]) is None


def test_a_movie_without_a_relative_path_answers_none():
    """No guessed name from the title: Radarr's own file name or nothing."""
    movie = dict(MOVIE_WITH_FILE, movieFile={"quality": {}})

    assert _file_of([movie]) is None


def test_a_movie_missing_from_the_library_answers_none():
    assert _file_of([dict(MOVIE_WITH_FILE, id=7, tmdbId=123)]) is None


def test_an_http_error_answers_none():
    """A server error must not read as 'the file is at …'."""
    assert _file_of([MOVIE_WITH_FILE], status=500) is None


def test_without_an_id_there_is_nothing_to_ask_for():
    session = _session([MOVIE_WITH_FILE])

    assert _file_of([MOVIE_WITH_FILE], tmdb_id=0, session=session) is None
    assert session.calls == [], "no id means no request to make"


class _TimeoutSession:
    def get(self, url, **kwargs):
        raise asyncio.TimeoutError()


class _ClientErrorSession:
    def get(self, url, **kwargs):
        raise aiohttp.ClientError("network is down")


@pytest.mark.parametrize("session", [_TimeoutSession(), _ClientErrorSession()])
def test_a_timeout_or_client_error_answers_none(session):
    result = asyncio.run(arr_client.arr_movie_file(session, _service(), 550))

    assert result is None
