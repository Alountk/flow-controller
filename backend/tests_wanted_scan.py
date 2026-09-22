"""Tests for the "scan for misplaced files" matching in routes/wanted.py.

Regression cover for a real bug: the scan read ``altTitles`` from Radarr, but
Radarr returns ``alternateTitles``. The field was therefore always empty, so the
scan could only ever match the primary title — a file named after any localized
title (e.g. the French "Ton Nom" for "Your Name.") was invisible.

These tests fake only the HTTP transport, so the real matching logic runs.
"""

import asyncio
from pathlib import Path
from unittest.mock import patch

import pytest

from clients import arr_movie_metadata, arr_series_episodes, fetch_wanted_movies
from config import SERVICES
from models import ActionRequest
from routes.wanted import _scan_for_movies_inner
from tests_routes import _StubSession

RADARR_URL = "http://radarr.test:7878"

# The scan resolves its service from the real config, so route stubs must use
# the configured Radarr URL rather than an invented one.
CONFIGURED_RADARR_URL = next(s["url"] for s in SERVICES if s["key"] == "radarr")
CONFIGURED_SONARR_URL = next(s["url"] for s in SERVICES if s["key"] == "sonarr")

# Shape captured from a real Radarr /api/v3/movie/{id} response.
MOVIE_PAYLOAD = {
    "id": 813,
    "title": "Your Name.",
    "originalTitle": "君の名は。",
    "year": 2016,
    "hasFile": False,
    "path": "/data/shared-media/movies/Your Name. (2016)",
    "movieFile": None,
    "alternateTitles": [
        {"sourceType": "tmdb", "movieMetadataId": 1083, "title": "Ton Nom", "id": 12496},
        {"sourceType": "tmdb", "movieMetadataId": 1083, "title": "你的名字", "id": 12499},
        {"sourceType": "tmdb", "movieMetadataId": 1083, "title": "Seu Nome", "id": 12493},
    ],
}

# Shape captured from a real Radarr /api/v3/wanted/missing response.
WANTED_PAYLOAD = {
    "records": [
        {
            "id": 813,
            "title": "Your Name.",
            "year": 2016,
            "hasFile": False,
            "alternateTitles": [
                {"sourceType": "tmdb", "movieMetadataId": 1083, "title": "Ton Nom", "id": 12496},
            ],
        }
    ],
    "totalRecords": 1,
}


def _service() -> dict:
    return {"key": "radarr", "kind": "arr", "url": RADARR_URL, "api_key": "test-key"}


@pytest.fixture
def transport():
    """Install a scripted HTTP transport keyed by URL substring."""
    def _install(routes: dict):
        def _factory(*args, **kwargs):
            return _StubSession(routes)

        return patch("aiohttp.ClientSession", _factory)

    return _install


# ── arr_movie_metadata ────────────────────────────────────────────────────────


def test_arr_movie_metadata_returns_alternate_titles(transport):
    routes = {f"{RADARR_URL}/api/v3/movie/813": (200, MOVIE_PAYLOAD)}

    with transport(routes):
        session = _StubSession(routes)
        meta = asyncio.run(arr_movie_metadata(session, _service(), 813))

    assert meta["title"] == "Your Name."
    assert meta["altTitles"] == ["Ton Nom", "你的名字", "Seu Nome"]


def test_arr_movie_metadata_tolerates_missing_alternate_titles(transport):
    payload = {k: v for k, v in MOVIE_PAYLOAD.items() if k != "alternateTitles"}
    routes = {f"{RADARR_URL}/api/v3/movie/813": (200, payload)}

    with transport(routes):
        session = _StubSession(routes)
        meta = asyncio.run(arr_movie_metadata(session, _service(), 813))

    assert meta["altTitles"] == []


# ── fetch_wanted_movies ───────────────────────────────────────────────────────


def test_fetch_wanted_movies_exposes_alternate_titles(transport):
    routes = {f"{RADARR_URL}/api/v3/wanted/missing": (200, WANTED_PAYLOAD)}

    with transport(routes):
        session = _StubSession(routes)
        result = asyncio.run(fetch_wanted_movies(session, _service(), page=1, page_size=50))

    assert result["items"][0]["altTitles"] == ["Ton Nom"]


# ── The scan itself ───────────────────────────────────────────────────────────


def _scan(tmp_path: Path, filename: str, movie_id: int = 813) -> dict:
    """Run the real scan over a folder containing one file."""
    folder = tmp_path / "downloads"
    folder.mkdir(exist_ok=True)
    (folder / filename).write_bytes(b"fake video")

    req = ActionRequest(
        source="radarr",
        remote_path=str(folder),
        ids={"movie_id": movie_id},
    )

    routes = {f"{CONFIGURED_RADARR_URL}/api/v3/movie/{movie_id}": (200, MOVIE_PAYLOAD)}

    with patch("aiohttp.ClientSession", lambda *a, **k: _StubSession(routes)):
        # Path validation is not under test; it only allows the real volumes.
        with patch("routes.wanted._validate_path", side_effect=lambda p: p):
            return asyncio.run(_scan_for_movies_inner(req))


def test_scan_matches_file_named_after_an_alternate_title(tmp_path):
    """The regression: this file is named in French, not after the primary title."""
    result = _scan(tmp_path, "Ton Nom (2016) 1080p BluRay.mkv")

    assert result["ok"] is True
    assert result["scanned_files"] == 1
    assert len(result["matches"]) == 1

    match = result["matches"][0]
    assert match["file_name"] == "Ton Nom (2016) 1080p BluRay.mkv"
    assert match["movie_id"] == 813
    assert match["matched_title"] == "Ton Nom"


def test_scan_matches_file_named_after_a_cjk_alternate_title(tmp_path):
    result = _scan(tmp_path, "你的名字 (2016).mkv")

    assert len(result["matches"]) == 1
    assert result["matches"][0]["matched_title"] == "你的名字"


def test_scan_still_matches_the_primary_title(tmp_path):
    result = _scan(tmp_path, "Your Name (2016) 1080p.mkv")

    assert len(result["matches"]) == 1


def test_scan_ignores_unrelated_files(tmp_path):
    result = _scan(tmp_path, "Completely Different Movie (1999).mkv")

    assert result["ok"] is True
    assert result["matches"] == []


def test_scan_reports_the_alternate_titles_it_used(tmp_path):
    """The matched title must come from the alternate list, not the primary one."""
    result = _scan(tmp_path, "Seu Nome (2016).mkv")

    assert len(result["matches"]) == 1
    assert result["matches"][0]["matched_title"] == "Seu Nome"
    assert result["matches"][0]["matched_title"] != MOVIE_PAYLOAD["title"]


# ── arr_series_episodes ───────────────────────────────────────────────────────
#
# The keys below (`seasonNumber`, `episodeNumber`, `title`, `airDateUtc`) are the
# Sonarr EpisodeResource that `fetch_wanted_episodes` already consumes in
# production, so this fixture pins a known shape rather than inventing one.


def _sonarr_service() -> dict:
    return {"key": "sonarr", "kind": "arr", "url": CONFIGURED_SONARR_URL, "api_key": "test-key"}


EPISODES_PAYLOAD = [
    {
        "id": 70,
        "seriesId": 3,
        "seasonNumber": 3,
        "episodeNumber": 7,
        "title": "Of Ice Men",
        "airDateUtc": "2006-11-27T00:00:00Z",
        "hasFile": True,
    }
]


def test_arr_series_episodes_maps_the_episode_resource(transport):
    routes = {f"{CONFIGURED_SONARR_URL}/api/v3/episode": (200, EPISODES_PAYLOAD)}

    with transport(routes):
        session = _StubSession(routes)
        result = asyncio.run(arr_series_episodes(session, _sonarr_service(), 3))

    assert result["episodes"] == [
        {
            "id": 70,
            "season_number": 3,
            "episode_number": 7,
            "title": "Of Ice Men",
            "air_date": "2006-11-27T00:00:00Z",
        }
    ]
    assert "error" not in result


def test_arr_series_episodes_asks_for_the_whole_series(transport):
    """No seasonNumber: the navigator can be browsing any season folder."""
    routes = {f"{CONFIGURED_SONARR_URL}/api/v3/episode": (200, EPISODES_PAYLOAD)}
    session = _StubSession(routes)

    with transport(routes):
        asyncio.run(arr_series_episodes(session, _sonarr_service(), 3))

    requested = session.calls[0][0]
    assert "seriesId=3" in requested
    assert "seasonNumber" not in requested


def test_arr_series_episodes_degrades_to_an_empty_list_with_the_reason(transport):
    """A failure must never look like "this series has no episodes"."""
    routes = {f"{CONFIGURED_SONARR_URL}/api/v3/episode": (401, {})}

    with transport(routes):
        session = _StubSession(routes)
        result = asyncio.run(arr_series_episodes(session, _sonarr_service(), 3))

    assert result["episodes"] == []
    assert result["error_kind"] == "auth"
    assert "401" in result["error"]
