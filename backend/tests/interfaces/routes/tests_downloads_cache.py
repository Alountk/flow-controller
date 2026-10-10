"""F-06(e) at the endpoint seam: `/api/downloads` serves the snapshot.

The handler used to call `collect_downloads()` per request — four upstream
calls per poll, 60/min per open tab. Since (e) it asks the application layer
for THE snapshot: one fetch per TTL window shared by every reader, a stale
last good answer when a refresh fails, and the payload itself untouched —
the join is the contract, only where it is served from changed.

The golden below was captured from the pre-change handler running the REAL
collector against stubbed HTTP: if the endpoint ever reshapes what the
collector built, this fails.
"""

import asyncio
import time
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

import app as app_module
from app import app
from application.use_cases import downloads_cache
from tests._stubs import _StubSession

client = TestClient(app, raise_server_exceptions=False)

RADARR_URL = "http://radarr.test:7878"
SONARR_URL = "http://sonarr.test:8989"
AMU_URL = "http://amu.test:4000"
HASH_UPPER = "35B9CD21161D24D8E5A958094375098700000000"

#: Captured from the pre-change `/api/downloads` (real collector, stubbed
#: transport), `updated_at` excluded — it is the snapshot's own clock.
_GOLDEN = {
    "downloads": [
        {
            "id": "1",
            "source": "radarr",
            "title": "Transformers El ultimo caballero (2017).BDrip 2160p.mkv",
            "status": "downloading",
            "tracked_state": "downloading",
            "tracked_status": "ok",
            "problem": False,
            "messages": ["algo"],
            "progress": 31.0,
            "size": 200,
            "sizeleft": 120,
            "timeleft": "00:45:19",
            "download_client": "aMuTorrent",
            "indexer": "Knaben",
            "matched": True,
            "speed": 4196000,
            "eta_seconds": 3177,
            "seeders": 1,
            "leechers": 0,
            "torrent_state": "downloading",
        }
    ],
    "errors": [],
}

_SNAPSHOT = {
    "downloads": list(_GOLDEN["downloads"]),
    "errors": [{"source": "amutorrent", "detail": "boom", "status": 500}],
    "updated_at": 1728000000,
}


def _cold():
    downloads_cache._downloads_cache = None


def _queue_item() -> dict:
    return {
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


def _torrent() -> dict:
    return {
        "hash": HASH_UPPER.lower(),
        "name": "Transformers",
        "state": "downloading",
        "progress": 0.3098,
        "dlspeed": 4196000,
        "eta": 3177,
        "num_seeds": 1,
        "num_leechs": 0,
        "category": "radarr",
    }


def _arr_services() -> list[dict]:
    return [
        {"key": "radarr", "kind": "arr", "url": RADARR_URL, "api_key": "k"},
        {"key": "sonarr", "kind": "arr", "url": SONARR_URL, "api_key": "k"},
    ]


def _routes() -> dict:
    return {
        f"{RADARR_URL}/api/v3/queue": (200, {"records": [_queue_item()]}),
        f"{SONARR_URL}/api/v3/queue": (200, {"records": []}),
        f"{AMU_URL}/api/v2/torrents/categories": (
            200,
            {c: {} for c in ("radarr", "radarr-ru", "tv-sonarr", "tv-sonarr-ru")},
        ),
        "category=radarr": (200, [_torrent()]),
    }


class TestTheEndpointServesTheSnapshot:
    def test_repeated_polls_inside_the_ttl_fetch_once(self):
        _cold()
        with patch.object(
            downloads_cache, "collect_downloads", new_callable=AsyncMock
        ) as collect:
            collect.return_value = dict(_SNAPSHOT)
            first = client.get("/api/downloads")
            second = client.get("/api/downloads")

        assert first.status_code == 200 and second.status_code == 200
        assert first.json() == second.json()
        assert collect.call_count == 1, (
            "the second poll inside the TTL paid for the arr fan-out again"
        )

    def test_an_expired_snapshot_is_refetched(self):
        """Age the entry out by hand rather than sleeping past the TTL."""
        _cold()
        with patch.object(
            downloads_cache, "collect_downloads", new_callable=AsyncMock
        ) as collect:
            collect.return_value = dict(_SNAPSHOT)
            client.get("/api/downloads")
            cached = downloads_cache._downloads_cache
            assert cached is not None, "the first poll must have cached something"
            downloads_cache._downloads_cache = (
                time.time() - downloads_cache.DOWNLOADS_TTL - 1,
                cached[1],
            )
            client.get("/api/downloads")

        assert collect.call_count == 2, "an expired snapshot must be rebuilt"

    def test_the_last_snapshot_is_served_when_the_fetch_fails(self):
        """stale-last: the screen keeps the last known board (and its frozen
        `updated_at`) instead of 500-ing — `status_cache` precedent."""
        _cold()
        with patch.object(
            downloads_cache, "collect_downloads", new_callable=AsyncMock
        ) as collect:
            collect.return_value = dict(_SNAPSHOT)
            warm = client.get("/api/downloads")
            collect.side_effect = ConnectionError("arr unreachable")
            served = client.get("/api/downloads")

        assert warm.status_code == 200
        assert served.status_code == 200, "a failed refresh must not break the reader"
        assert served.json() == _SNAPSHOT


class TestThePayloadShapeIsUntouched:
    def test_the_response_is_the_collectors_snapshot_untouched(self):
        """Pass-through pin: whatever the collector built — items, error
        entries, timestamp — reaches the client byte for byte."""
        _cold()
        with patch.object(
            downloads_cache, "collect_downloads", new_callable=AsyncMock
        ) as collect:
            collect.return_value = dict(_SNAPSHOT)
            resp = client.get("/api/downloads")

        assert resp.status_code == 200
        assert resp.json() == _SNAPSHOT

    def test_the_join_payload_still_matches_the_pre_change_golden(self):
        """The real collector, through the endpoint, against the golden
        captured BEFORE the cache existed: same join, same fields, same
        values — only the serving path moved."""
        _cold()
        routes = _routes()
        with patch.object(
            downloads_cache, "configured_services", return_value=_arr_services()
        ), patch(
            "infrastructure.arr_client.AMUTORRENT_URL", AMU_URL
        ), patch(
            "aiohttp.ClientSession", lambda *a, **k: _StubSession(routes)
        ):
            resp = client.get("/api/downloads")

        assert resp.status_code == 200
        body = resp.json()
        updated_at = body.pop("updated_at")
        assert isinstance(updated_at, int) and updated_at > 0
        assert body == _GOLDEN


class TestThePollersLifecycle:
    def test_the_composition_root_starts_one_poller_and_stops_it_on_shutdown(self):
        """One poller, born in the lifespan and cancelled by it: two instances
        would double the upstream rate the study measured, and one outliving
        the lifespan would keep polling over a closed session."""
        started: list[str] = []
        stopped: list[str] = []

        async def fake_downloads_poller():
            started.append("downloads")
            try:
                await asyncio.Event().wait()
            finally:
                stopped.append("downloads")

        async def fake_status_checker():
            started.append("status")
            await asyncio.Event().wait()

        async def run_lifespan():
            gen = app_module.lifespan(None)
            await gen.__anext__()
            await asyncio.sleep(0)  # let the created tasks reach their first await
            await gen.aclose()

        with patch.object(
            app_module.status_routes, "background_checker", fake_status_checker
        ), patch.object(
            app_module.downloads_cache, "downloads_poller", fake_downloads_poller
        ), patch.object(
            app_module, "history"
        ), patch.object(
            app_module, "open_shared_session"
        ), patch.object(
            app_module, "close_shared_session", AsyncMock()
        ):
            asyncio.run(run_lifespan())

        assert started.count("downloads") == 1, "exactly one downloads poller"
        assert stopped == ["downloads"], "the shutdown path must cancel it"
