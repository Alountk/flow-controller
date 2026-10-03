"""The two `movieFile` facts the panel's downloaded-file block shows (PR C).

`fetch_all_movies_detailed` already reads `movieFile` for `quality` (PR #113).
The same object also carries `relativePath` (the file Radarr owns) and
`languages` (the languages of THAT file) — zero new calls to the arr, only two
more reads of a payload that is already in memory.

The contract these tests pin is the conservative half:

- a missing / odd payload reads as **no name** (``""``) and **no languages**
  (``[]``), never as a guessed name and never as ``[""]`` — an empty string in
  the list would render on screen as a language nobody spoke;
- an entry without a ``name`` is dropped, never stringified: ``{"id": 3}`` must
  not become ``"undefined"`` (or ``"None"``) in the UI.

Only the HTTP transport is faked (`_StubSession`), so the real function body
runs.
"""

import asyncio
from unittest.mock import patch

from clients import fetch_all_movies_detailed
from tests_routes import CONFIGURED_RADARR_URL, _StubSession, client

RADARR_URL = "http://radarr.test:7878"

MOVIE_WITH_FILE = {
    "id": 1,
    "title": "ParaNorman",
    "year": 2012,
    "hasFile": True,
    "path": "/movies/ParaNorman (2012)",
    "monitored": True,
    "movieFile": {
        "relativePath": "ParaNorman.2012.1080p.BluRay.x264.mkv",
        "quality": {"quality": {"name": "Bluray-1080p"}},
        "languages": [{"id": 1, "name": "Spanish"}, {"id": 2, "name": "English"}],
    },
}

MOVIE_WITHOUT_FILE = {
    "id": 2,
    "title": "Aún sin archivo",
    "year": 2026,
    "hasFile": False,
    "path": "/movies/Aún sin archivo (2026)",
    "monitored": True,
}


def _service(url: str = RADARR_URL) -> dict:
    return {"key": "radarr", "kind": "arr", "url": url, "api_key": "test-key"}


def _fetch(payload) -> dict:
    routes = {f"{RADARR_URL}/api/v3/movie": (200, payload)}
    session = _StubSession(routes)
    return asyncio.run(fetch_all_movies_detailed(session, _service()))


def _item(payload) -> dict:
    return _fetch(payload)["items"][0]


# ── file_name ─────────────────────────────────────────────────────────────────


def test_a_movie_with_a_file_reports_its_relative_path():
    item = _item([MOVIE_WITH_FILE])

    assert item["file_name"] == "ParaNorman.2012.1080p.BluRay.x264.mkv"


def test_a_movie_without_movieFile_reports_no_name():
    """``""`` means "no name to show", never a name built from the title."""
    item = _item([MOVIE_WITHOUT_FILE])

    assert item["file_name"] == ""


def test_a_malformed_movieFile_never_invents_a_name():
    """`movieFile` as a plain string is not Radarr's shape; passing it through
    (or falling back to the title) would present a guess as the file."""
    item = _item([{**MOVIE_WITHOUT_FILE, "movieFile": "ParaNorman.mkv"}])

    assert item["file_name"] == ""


def test_a_non_string_relativePath_reads_as_no_name():
    item = _item([
        {**MOVIE_WITHOUT_FILE, "movieFile": {"relativePath": 1234}},
    ])

    assert item["file_name"] == ""


# ── languages ─────────────────────────────────────────────────────────────────


def test_languages_are_the_names_of_that_file():
    item = _item([MOVIE_WITH_FILE])

    assert item["languages"] == ["Spanish", "English"]


def test_a_movie_without_movieFile_reports_no_languages():
    item = _item([MOVIE_WITHOUT_FILE])

    # `[]`, not `[""]`: an empty list renders nothing on screen.
    assert item["languages"] == []


def test_a_movie_file_without_a_languages_key_reports_no_languages():
    item = _item([
        {**MOVIE_WITHOUT_FILE, "movieFile": {"relativePath": "x.mkv"}},
    ])

    assert item["languages"] == []


def test_an_entry_without_a_name_is_dropped_not_stringified():
    """`{"id": 3}` carries no name; turning it into "undefined"/"None" would
    put a language on screen that Radarr never reported."""
    item = _item([
        {**MOVIE_WITHOUT_FILE, "movieFile": {"languages": [{"id": 3}]}},
    ])

    assert item["languages"] == []


def test_an_empty_or_non_string_name_is_dropped():
    item = _item([
        {**MOVIE_WITHOUT_FILE, "movieFile": {"languages": [
            {"name": ""}, {"name": None}, {"name": 7},
        ]}},
    ])

    assert item["languages"] == []


def test_a_languages_container_of_the_wrong_type_reads_as_no_languages():
    """A bare string must not be iterated character by character: `"Spanish"`
    would come back as `["S", "p", "a", ...]`."""
    item = _item([
        {**MOVIE_WITHOUT_FILE, "movieFile": {"languages": "Spanish"}},
    ])

    assert item["languages"] == []


# ── the whole thing, through the route the frontend actually calls ────────────


def test_the_wanted_route_carries_both_fields_to_the_client():
    routes = {f"{CONFIGURED_RADARR_URL}/api/v3/movie": (200, [MOVIE_WITH_FILE])}

    with patch("aiohttp.ClientSession", lambda *a, **k: _StubSession(routes)):
        body = client.get("/api/wanted/all").json()

    item = body["items"][0]
    assert item["file_name"] == "ParaNorman.2012.1080p.BluRay.x264.mkv"
    assert item["languages"] == ["Spanish", "English"]
    assert item["quality"] == "Bluray-1080p"
