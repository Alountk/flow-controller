"""`arr_series_episodes` joins the two Sonarr endpoints the row needs.

Sonarr answers "does this episode have its file" and "where is that file" from
two different endpoints, joined by `episodeFileId`. The panel draws all three
facts — the pill, the quality tag and the folder — so all three have to come
back together or the row lies.

The file lookup failing is deliberately NOT a failure of the list: `has_file`
plus a null path reads as "it is there and we could not read it", which is what
happened, rather than "it is not there", which would be a lie.
"""

import asyncio

from infrastructure import arr_client
from tests._stubs import _StubSession

SONARR = "http://sonarr.test:8989"

#: NOTE on routing: `/api/v3/episode` is a substring of `/api/v3/episodefile`,
#: and `_StubSession` matches fragments by substring IN INSERTION ORDER. The
#: more specific one must come first or every file lookup silently answers with
#: the episode payload.
EPISODE = {"id": 1, "seasonNumber": 1, "episodeNumber": 1, "title": "Despegue cero",
           "airDateUtc": "2021-10-08T00:00:00Z", "hasFile": True, "episodeFileId": 77}
EPISODE_NO_FILE = {"id": 2, "seasonNumber": 1, "episodeNumber": 2, "title": "Sin archivo",
                   "airDateUtc": "", "hasFile": False, "episodeFileId": None}
FILE_77 = {
    "id": 77,
    "path": "/mnt/storage-6tb/shared-media/shows/Rick and Morty/S01E01.mkv",
    "quality": {"quality": {"id": 9, "name": "HDTV-1080p"}, "revision": {"version": 1}},
}


def _service() -> dict:
    return {"key": "sonarr", "url": SONARR, "api_key": "k"}


def _run(routes: dict) -> dict:
    return asyncio.run(arr_client.arr_series_episodes(_StubSession(routes), _service(), 1))


def _routes(episodes: dict, files: dict) -> dict:
    """`episodefile` first — see the substring note above."""
    return {
        "/api/v3/episodefile": (200, files),
        "/api/v3/episode": (200, episodes),
    }


def test_a_file_episode_carries_pill_quality_and_path_together():
    result = _run(_routes([EPISODE], [FILE_77]))

    ep = result["episodes"][0]
    assert ep["has_file"] is True
    assert ep["quality"] == "HDTV-1080p"
    assert ep["path"] == FILE_77["path"]


def test_an_episode_without_a_file_reports_it_and_stops_at_null():
    """None is not id 0: looking it up as a key would raise KeyError."""
    result = _run(_routes([EPISODE, EPISODE_NO_FILE], [FILE_77]))

    first, second = result["episodes"]
    assert first["has_file"] is True
    assert second["has_file"] is False
    assert second["quality"] is None
    assert second["path"] is None


def test_a_failed_file_lookup_keeps_the_list_and_says_only_what_it_knows():
    """`has_file: true` + no path = "it is there, we could not read it"."""
    routes = _routes([EPISODE], {"detail": "boom"})  # 500 for the files
    routes["/api/v3/episodefile"] = (500, {})
    result = _run(routes)

    assert "error" not in result, "episodes came back — the list must not be discarded"
    ep = result["episodes"][0]
    assert ep["has_file"] is True, "hasFile came from the endpoint that DID answer"
    assert ep["path"] is None
    assert ep["quality"] is None


def test_a_failed_episode_lookup_still_ends_the_request():
    """The only fatal failure — same contract as before this join existed."""
    routes = {"/api/v3/episodefile": (200, [FILE_77]),
              "/api/v3/episode": (404, {"detail": "nope"})}
    result = _run(routes)

    assert result["episodes"] == []
    assert "error" in result


def test_an_empty_series_is_empty_not_an_error():
    result = _run(_routes([], []))
    assert result == {"episodes": []}


def test_both_calls_are_made_even_when_one_of_them_fails():
    """The file call must not be skipped just because episodes answered."""
    routes = _routes([EPISODE], {})
    routes["/api/v3/episodefile"] = (500, {})
    session = _StubSession(routes)
    asyncio.run(arr_client.arr_series_episodes(session, _service(), 1))

    asked = [url for url, _ in session.calls]
    assert any("/api/v3/episode" in u for u in asked)
    assert any("/api/v3/episodefile" in u for u in asked)
