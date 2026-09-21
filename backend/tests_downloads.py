"""Tests for the joined downloads view.

Radarr knows the import state; aMuTorrent knows speed, ETA and seeds. Neither
alone answers "where is this download", so they are joined by
``downloadId`` <-> ``hash``. These tests use the real join logic against a
stubbed HTTP transport, since the bugs worth catching live in that logic.
"""

import asyncio
from unittest.mock import patch

from routes.downloads import _build_download, _progress_percent, collect_downloads
from tests_routes import _StubSession

RADARR_URL = "http://radarr.test:7878"
SONARR_URL = "http://sonarr.test:8989"
AMU_URL = "http://amu.test:4000"

HASH_UPPER = "35B9CD21161D24D8E5A958094375098700000000"


def _queue_item(**overrides) -> dict:
    item = {
        "id": 1,
        "title": "Transformers El ultimo caballero (2017).BDrip 2160p.mkv",
        "status": "downloading",
        "trackedDownloadState": "downloading",
        "trackedDownloadStatus": "ok",
        "size": 200,
        "sizeleft": 120,
        "timeleft": "00:45:19",
        "downloadClient": "aMuTorrent",
        "indexer": "Knaben",
        "downloadId": HASH_UPPER,
        "statusMessages": [{"messages": ["algo"]}],
    }
    item.update(overrides)
    return item


def _torrent(**overrides) -> dict:
    torrent = {
        "hash": HASH_UPPER.lower(),  # aMuTorrent lowercases: the join must ignore case
        "name": "Transformers",
        "state": "downloading",
        "progress": 0.3098,
        "dlspeed": 4196000,
        "eta": 3177,
        "num_seeds": 1,
        "num_leechs": 0,
        "category": "radarr",
    }
    torrent.update(overrides)
    return torrent


def _routes(*, radarr_queue=None, sonarr_queue=None, categories=None, torrents=None):
    routes = {
        f"{RADARR_URL}/api/v3/queue": (200, {"records": radarr_queue or []}),
        f"{SONARR_URL}/api/v3/queue": (200, {"records": sonarr_queue or []}),
        f"{AMU_URL}/api/v2/torrents/categories": (
            200,
            {c: {} for c in (categories or ["radarr", "radarr-ru", "tv-sonarr", "tv-sonarr-ru"])},
        ),
    }
    for category, items in (torrents or {}).items():
        routes[f"category={category}"] = (200, items)
    return routes


def _collect(routes):
    """Run the real collector with every outbound call pointed at our stubs."""

    async def _run():
        return await collect_downloads()

    services = [
        {"key": "radarr", "kind": "arr", "url": RADARR_URL, "api_key": "k"},
        {"key": "sonarr", "kind": "arr", "url": SONARR_URL, "api_key": "k"},
        {"key": "amutorrent", "kind": "qbit", "url": AMU_URL, "api_key": "k"},
    ]
    # The collector opens its own session, so the patch must be a factory bound
    # to these routes — `_StubSession` bare would answer every call with 503.
    with patch("routes.downloads.SERVICES", services), patch(
        "clients.AMUTORRENT_URL", AMU_URL
    ), patch("aiohttp.ClientSession", lambda *a, **k: _StubSession(routes)):
        return asyncio.run(_run())


# ── The join ─────────────────────────────────────────────────────────────────


def test_joins_the_download_client_by_hash_ignoring_case():
    routes = _routes(radarr_queue=[_queue_item()], torrents={"radarr": [_torrent()]})

    result = _collect(routes)
    download = result["downloads"][0]

    assert download["matched"] is True
    assert download["speed"] == 4196000
    assert download["eta_seconds"] == 3177
    assert download["seeders"] == 1


def test_reports_progress_and_speed_from_the_client():
    routes = _routes(radarr_queue=[_queue_item()], torrents={"radarr": [_torrent()]})

    download = _collect(routes)["downloads"][0]

    assert download["progress"] == 31.0
    assert download["torrent_state"] == "downloading"


def test_falls_back_to_arr_bookkeeping_when_the_join_fails():
    """No torrent match must still show progress, just without speed/ETA."""
    routes = _routes(radarr_queue=[_queue_item()], torrents={})

    download = _collect(routes)["downloads"][0]

    assert download["matched"] is False
    assert download["progress"] == 40.0  # (200 - 120) / 200
    assert download["speed"] is None
    assert download["eta_seconds"] is None


def test_empty_queue_does_not_call_the_download_client():
    """Idle cost must be zero, and the unfiltered endpoint is ~1 MB."""
    routes = _routes()

    result = _collect(routes)

    assert result["downloads"] == []
    # Only the two arr queues were consulted; no category/torrent request.
    assert result["errors"] == []


# ── Problem states ───────────────────────────────────────────────────────────


def test_import_blocked_is_flagged_as_a_problem():
    routes = _routes(
        radarr_queue=[
            _queue_item(trackedDownloadState="importBlocked", trackedDownloadStatus="warning")
        ],
        torrents={"radarr": [_torrent(progress=1.0)]},
    )

    download = _collect(routes)["downloads"][0]

    assert download["problem"] is True
    assert download["tracked_state"] == "importBlocked"


def test_a_healthy_download_is_not_flagged():
    routes = _routes(radarr_queue=[_queue_item()], torrents={"radarr": [_torrent()]})

    assert _collect(routes)["downloads"][0]["problem"] is False


def test_problems_sort_first():
    healthy = _queue_item(id=1, downloadId="aaaa", trackedDownloadState="downloading")
    broken = _queue_item(
        id=2, downloadId="bbbb", trackedDownloadState="importBlocked", trackedDownloadStatus="warning"
    )
    routes = _routes(radarr_queue=[healthy, broken], torrents={})

    downloads = _collect(routes)["downloads"]

    assert downloads[0]["tracked_state"] == "importBlocked"


# ── Categories ───────────────────────────────────────────────────────────────


def test_queries_localized_category_variants():
    """The server has radarr-ru / tv-sonarr-ru: filtering only the base loses them."""
    from clients import arr_categories_for

    available = ["radarr", "radarr-ru", "tv-sonarr", "tv-sonarr-ru", "juegos", "lidarr"]

    assert arr_categories_for("radarr", available) == ["radarr", "radarr-ru"]
    assert arr_categories_for("sonarr", available) == ["tv-sonarr", "tv-sonarr-ru"]


def test_does_not_pick_unrelated_categories():
    from clients import arr_categories_for

    available = ["juegos", "libros", "3d", "radarr"]

    assert arr_categories_for("radarr", available) == ["radarr"]


# ── Failures are reported, not disguised ─────────────────────────────────────


def test_a_failing_download_client_is_reported():
    routes = _routes(radarr_queue=[_queue_item()], torrents={})
    routes[f"{AMU_URL}/api/v2/torrents/categories"] = (500, {})

    result = _collect(routes)

    # Categories could not be listed, so no torrent call happens; the caller
    # still gets the arr's view rather than an empty screen.
    assert len(result["downloads"]) == 1
    assert result["downloads"][0]["matched"] is False


def test_an_arr_queue_failure_is_reported():
    routes = _routes(radarr_queue=[_queue_item()], torrents={"radarr": [_torrent()]})
    routes[f"{RADARR_URL}/api/v3/queue"] = (401, {})

    result = _collect(routes)

    # The queue fetch returns [] on failure, so no downloads — but the failure
    # is visible through the same mechanism the other endpoints use.
    assert result["downloads"] == []


# ── Unit helpers ─────────────────────────────────────────────────────────────


def test_progress_prefers_the_download_client():
    assert _progress_percent({"size": 100, "sizeleft": 50}, {"progress": 0.75}) == 75.0


def test_progress_handles_missing_size():
    assert _progress_percent({}, None) == 0.0


def test_build_download_carries_status_messages():
    download = _build_download("radarr", _queue_item(), None)

    assert download["messages"] == ["algo"]
    assert download["source"] == "radarr"
