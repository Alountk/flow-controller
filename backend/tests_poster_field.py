"""`remotePoster` in the five arr fetchers that feed the section rows.

Regression cover for a real bug: ``fetch_wanted_movies``,
``fetch_all_movies_detailed`` and ``fetch_all_series_detailed`` read a
``remotePoster`` key Radarr and Sonarr never send, so every row in
Biblioteca / Faltantes / Calidad — and the detail panel, which is fed from
those same rows — always rendered an empty poster. The arr payloads carry
``images: [{"url": ..., "coverType": "poster"}]``; the two calendar fetchers
already read the poster that way.

The contract pinned here:

- the poster is ``images[0].url``, rewritten to this app's own poster proxy
  (``/api/mediacover/<source>/…``) — only a ``/MediaCover/…`` path is
  rewritten, relative and absolute shapes alike; anything else is left alone;
- missing / empty / malformed ``images`` reads as **``""``** — the frontend
  falls back to initials, and an empty ``<img src="">`` must not render;
- no shape of ``images`` may raise (the calendar expression itself used to
  blow up on a non-list container or a non-dict entry);
- the calendar fetchers keep the output they had before any shared helper,
  byte for byte, on every payload the old expression survived;
- **all five** fetchers are exercised by one table: three of five shipped
  broken precisely because no test ever iterated the implementations.

Only the HTTP transport is faked (``_StubSession``), so the real function
bodies run.
"""

import asyncio
import inspect

import pytest

import clients
from clients import (
    fetch_all_movies_detailed,
    fetch_all_series_detailed,
    fetch_radarr_calendar,
    fetch_sonarr_calendar,
    fetch_wanted_movies,
)
from tests_routes import _StubSession

RADARR_URL = "http://radarr.test:7878"
SONARR_URL = "http://sonarr.test:8989"

# The shape Radarr really reports with `urlBase = /`: a RELATIVE MediaCover
# path the browser would resolve against our own origin — the value the proxy
# rewrite below has to recognise (and the one the running app returns today).
POSTER_URL = "/MediaCover/1/poster.jpg?h=f8b1724d493fa6da0bfc"

# Sentinel: the payload carries no `images` key at all (as opposed to an
# `images` key holding some value).
MISSING = object()

# Shapes captured from real Radarr / Sonarr payloads (movie, series and the
# `includeSeries=true` calendar episode, whose poster lives on `series`).
MOVIE = {"id": 813, "title": "Your Name.", "year": 2016, "hasFile": False}
SERIES = {"id": 3, "title": "Of Ice Men", "year": 2006, "monitored": True}
EPISODE = {
    "id": 70,
    "seriesId": 3,
    "seasonNumber": 3,
    "episodeNumber": 7,
    "title": "Of Ice Men",
    "airDateUtc": "2006-11-27T00:00:00Z",
    "hasFile": False,
}


def _with_images(base: dict, images) -> dict:
    """Copy of ``base``, carrying ``images`` unless the case says it is absent."""
    item = dict(base)
    if images is not MISSING:
        item["images"] = images
    return item


def _radarr_service() -> dict:
    return {"key": "radarr", "kind": "arr", "url": RADARR_URL, "api_key": "test-key"}


def _sonarr_service() -> dict:
    return {"key": "sonarr", "kind": "arr", "url": SONARR_URL, "api_key": "test-key"}


# One runner per fetcher: each builds the payload that fetcher really receives,
# fakes only the transport, and returns the `remotePoster` of its first item.
# The table below feeds the SAME `images` value to all five, which is exactly
# what was missing when three of them read a field the arrs never send.


def _poster_of_wanted_movies(images) -> str:
    record = _with_images({**MOVIE, "alternateTitles": []}, images)
    payload = {"records": [record], "totalRecords": 1}
    routes = {f"{RADARR_URL}/api/v3/wanted/missing": (200, payload)}
    result = asyncio.run(fetch_wanted_movies(_StubSession(routes), _radarr_service()))
    return result["items"][0]["remotePoster"]


def _poster_of_movies_detailed(images) -> str:
    payload = [_with_images(MOVIE, images)]
    routes = {f"{RADARR_URL}/api/v3/movie": (200, payload)}
    result = asyncio.run(fetch_all_movies_detailed(_StubSession(routes), _radarr_service()))
    return result["items"][0]["remotePoster"]


def _poster_of_series_detailed(images) -> str:
    payload = [_with_images(SERIES, images)]
    routes = {f"{SONARR_URL}/api/v3/series": (200, payload)}
    result = asyncio.run(fetch_all_series_detailed(_StubSession(routes), _sonarr_service()))
    return result["items"][0]["remotePoster"]


def _poster_of_radarr_calendar(images) -> str:
    payload = [_with_images(MOVIE, images)]
    routes = {f"{RADARR_URL}/api/v3/calendar": (200, payload)}
    result = asyncio.run(
        fetch_radarr_calendar(_StubSession(routes), _radarr_service(), "2026-10-01", "2026-10-31")
    )
    return result[0]["remotePoster"]


def _poster_of_sonarr_calendar(images) -> str:
    # Sonarr's poster rides on the episode's `series`, not on the episode.
    episode = {**EPISODE, "series": _with_images(SERIES, images)}
    routes = {f"{SONARR_URL}/api/v3/calendar": (200, [episode])}
    result = asyncio.run(
        fetch_sonarr_calendar(_StubSession(routes), _sonarr_service(), "2026-10-01", "2026-10-31")
    )
    return result[0]["remotePoster"]


# The source each runner's fetcher reports. The proxy prefix carries it, so
# the table below pins the RIGHT prefix for each of the five call sites.
_poster_of_wanted_movies.source = "radarr"
_poster_of_movies_detailed.source = "radarr"
_poster_of_series_detailed.source = "sonarr"
_poster_of_radarr_calendar.source = "radarr"
_poster_of_sonarr_calendar.source = "sonarr"


FETCHERS = [
    pytest.param(_poster_of_wanted_movies, id="fetch_wanted_movies"),
    pytest.param(_poster_of_movies_detailed, id="fetch_all_movies_detailed"),
    pytest.param(_poster_of_series_detailed, id="fetch_all_series_detailed"),
    pytest.param(_poster_of_radarr_calendar, id="fetch_radarr_calendar"),
    pytest.param(_poster_of_sonarr_calendar, id="fetch_sonarr_calendar"),
]

EMPTY_IMAGES = [
    pytest.param([], id="images-empty-list"),
    pytest.param(MISSING, id="images-key-absent"),
    pytest.param([{}], id="images-first-entry-without-url"),
    pytest.param([{"coverType": "poster"}], id="images-first-entry-without-url-key"),
]

MALFORMED_IMAGES = [
    pytest.param("https://img.example/not-a-list", id="images-is-a-string"),
    pytest.param({"url": POSTER_URL}, id="images-is-a-dict"),
    pytest.param(["not-a-dict"], id="images-entry-is-a-string"),
    pytest.param([None], id="images-entry-is-none"),
]

# Every `images` value the old calendar expression survived — any malformed
# shape below used to raise (`"str"[0].get(...)` → AttributeError), so none of
# them can be part of a byte-identity pin against it.
CALENDAR_SAFE_IMAGES = [
    pytest.param([], id="empty-list"),
    pytest.param(MISSING, id="key-absent"),
    pytest.param([{}], id="entry-without-url"),
    pytest.param([{"coverType": "poster"}], id="entry-without-url-key"),
    pytest.param([{"url": POSTER_URL, "coverType": "poster"}], id="poster"),
    pytest.param([{"url": ""}], id="url-present-but-empty"),
    pytest.param(
        [{"url": POSTER_URL}, {"url": "https://img.example/banner.jpg"}],
        id="first-entry-wins",
    ),
]


# ── all five fetchers, one table ──────────────────────────────────────────────


@pytest.mark.parametrize("poster_of", FETCHERS)
def test_every_fetcher_reads_the_first_images_url(poster_of):
    """The bug, in one assertion: three of five fetchers read a field the arrs
    never send, so their poster was always ``""`` — and the poster they now
    read arrives as the proxied path the browser can actually fetch."""
    images = [{"url": POSTER_URL, "coverType": "poster"}]

    assert poster_of(images) == f"/api/mediacover/{poster_of.source}{POSTER_URL}"


@pytest.mark.parametrize("poster_of", FETCHERS)
def test_every_fetcher_rewrites_the_absolute_shape_too(poster_of):
    """Both arr shapes — relative and absolute — land on the same proxied
    path, origin dropped: the app becomes the only client that reaches the
    arr, whichever way it worded the poster URL."""
    images = [
        {
            "url": "http://arr.test:7878/MediaCover/1/poster.jpg?h=f8b1724d493fa6da0bfc",
            "coverType": "poster",
        }
    ]

    assert poster_of(images) == f"/api/mediacover/{poster_of.source}{POSTER_URL}"


@pytest.mark.parametrize("poster_of", FETCHERS)
def test_every_fetcher_leaves_a_url_it_does_not_recognise_alone(poster_of):
    """A poster that is not a MediaCover URL (another CDN, another service)
    travels untouched — what we do not recognise, we do not mangle."""
    images = [{"url": "https://img.example/your-name.jpg", "coverType": "poster"}]

    assert poster_of(images) == "https://img.example/your-name.jpg"


@pytest.mark.parametrize("poster_of", FETCHERS)
@pytest.mark.parametrize("images", EMPTY_IMAGES)
def test_a_missing_or_empty_images_reads_as_no_poster(poster_of, images):
    """``""``, not ``None`` and not a placeholder: the frontend falls back to
    initials, and an empty ``<img src="">`` must never be rendered."""
    assert poster_of(images) == ""


@pytest.mark.parametrize("poster_of", FETCHERS)
@pytest.mark.parametrize("images", MALFORMED_IMAGES)
def test_a_malformed_images_reads_as_no_poster_without_raising(poster_of, images):
    """No payload shape may raise. The calendar expression used to die on these
    (``"str"[0].get(...)`` → AttributeError), and a crash takes the whole row
    down rather than showing a posterless one."""
    assert poster_of(images) == ""


def test_the_table_covers_every_remote_poster_read_in_clients():
    """Three of five fetchers shipped broken because nothing iterated them.

    A sixth ``"remotePoster":`` read added to clients.py without a matching
    entry in ``FETCHERS`` fails here — this test closes the gap the bug came
    through.
    """
    assert clients.__file__ is not None
    source = inspect.getsource(clients)

    assert source.count('"remotePoster":') == len(FETCHERS)


# ── regression: the calendar fetchers were never broken ───────────────────────


def _legacy_calendar_poster(item: dict) -> str:
    """The exact expression ``fetch_radarr_calendar`` / ``fetch_sonarr_calendar``
    shipped with — the byte-for-byte baseline these tests pin."""
    return (item.get("images") or [{}])[0].get("url", "") if item.get("images") else ""


def _legacy_with_proxy_prefix(legacy: str, source: str) -> str:
    """The baseline output with the one change: a MediaCover path now carries
    the proxy prefix. Everything else — empty shapes, unrecognised URLs —
    must come back byte for byte."""
    return f"/api/mediacover/{source}{legacy}" if legacy.startswith("/MediaCover/") else legacy


@pytest.mark.parametrize("images", CALENDAR_SAFE_IMAGES)
def test_the_calendar_fetchers_keep_their_previous_output(images):
    """Sharing a helper must not move the two fetchers that were correct: same
    input → same bytes as the expression above, apart from the proxy prefix a
    MediaCover poster now carries."""
    movie = _with_images(MOVIE, images)
    series = _with_images(SERIES, images)

    assert _poster_of_radarr_calendar(images) == _legacy_with_proxy_prefix(
        _legacy_calendar_poster(movie), "radarr"
    )
    assert _poster_of_sonarr_calendar(images) == _legacy_with_proxy_prefix(
        _legacy_calendar_poster(series), "sonarr"
    )


# ── the rewrite at the source: _poster_url, both shapes ───────────────────────


def test_a_relative_mediacover_path_becomes_the_proxied_path():
    item = {"images": [{"url": "/MediaCover/1/poster.jpg?h=abc"}]}

    assert clients._poster_url(item, "radarr") == "/api/mediacover/radarr/MediaCover/1/poster.jpg?h=abc"


def test_an_absolute_mediacover_url_keeps_path_and_query_and_drops_the_origin():
    item = {"images": [{"url": "http://sonarr.test:8989/MediaCover/3/poster.jpg?h=abc"}]}

    assert clients._poster_url(item, "sonarr") == "/api/mediacover/sonarr/MediaCover/3/poster.jpg?h=abc"


def test_an_empty_poster_stays_empty():
    assert clients._poster_url({"images": [{"url": ""}]}, "radarr") == ""


def test_a_url_that_is_not_mediacover_is_left_alone():
    untouched = "https://img.example/your-name.jpg"

    assert clients._poster_url({"images": [{"url": untouched}]}, "radarr") == untouched


def test_a_traversing_mediacover_path_is_never_rewritten():
    # Never `/api/mediacover/radarr/…/../..`: the path is normalised first and
    # only then checked, so a path that escapes MediaCover stays untouched.
    raw = "http://radarr.test:7878/MediaCover/../../api/v3/system/status"

    assert clients._poster_url({"images": [{"url": raw}]}, "radarr") == raw
