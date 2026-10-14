"""GET /api/activity — the dashboard's recent-activity table (Stitch 01, §3).

The endpoint composes two honest sources: the durable operations log
(copy/move, `recent_operations`) and the active-downloads snapshot. It
orders by recency, passes raw states through (labels are the frontend's
job) and degrades to whichever source still works — a missing database or a
failed snapshot must never take the whole table down.
"""

import time
from unittest.mock import AsyncMock, patch

from tests._stubs import client


def _op(**extra) -> dict:
    base = {
        "id": "op-1",
        "type": "copy",
        "name": "Dune.Part.Two.mkv",
        "src": "/downloads/x.mkv",
        "dst": "/media/peliculas/Dune (2024)",
        "status": "done",
        "detail": None,
        "import_status": "",
        "arr_source": "radarr",
        "movie_id": 1,
        "series_id": None,
        "size_bytes": 48_200_000_000,
        "created_at": time.time() - 600,
        "started_at": None,
        "finished_at": None,
    }
    base.update(extra)
    return base


def _downloads(*items, updated_at=None) -> dict:
    return {
        "downloads": list(items),
        "updated_at": updated_at if updated_at is not None else time.time(),
    }


def _download(**extra) -> dict:
    base = {
        "source": "sonarr",
        "title": "Severance.S02E01",
        "status": "downloading",
        "problem": False,
        "size": 920_000_000,
    }
    base.update(extra)
    return base


def _get(ops, snap, **params):
    with patch(
        "application.gateways.history.recent_operations", return_value=ops
    ), patch(
        "application.use_cases.downloads_cache.get_downloads",
        new=AsyncMock(return_value=snap),
    ):
        return client.get("/api/activity", params=params)


# ── merge + ordering ─────────────────────────────────────────────────────────


def test_merges_both_sources_newest_first():
    op = _op(created_at=time.time() - 600)
    snap = _downloads(_download(), updated_at=time.time())  # the snapshot is newer

    resp = _get([op], snap)

    assert resp.status_code == 200
    body = resp.json()
    assert [item["kind"] for item in body["items"]] == ["download", "operation"]
    assert body["items"][0]["at"] > body["items"][1]["at"]


def test_returns_a_float_updated_at_stamp():
    resp = _get([], _downloads())

    assert isinstance(resp.json()["updated_at"], float)


def test_honours_the_limit_after_merging():
    ops = [_op(id=f"op-{i}", created_at=time.time() - i) for i in range(5)]
    snap = _downloads(_download(), updated_at=time.time())

    resp = _get(ops, snap, limit=3)

    assert len(resp.json()["items"]) == 3


# ── shapes: raw states pass through, labels are the frontend's job ───────────


def test_operation_item_carries_the_raw_fields():
    op = _op(type="move", status="pending", import_status="importing", arr_source="Sonarr")
    snap = _downloads()

    items = _get([op], snap).json()["items"]

    (item,) = items
    assert item["kind"] == "operation"
    assert item["op_type"] == "move"
    assert item["name"] == "Dune.Part.Two.mkv"
    assert item["destination"] == "/media/peliculas/Dune (2024)"
    assert item["size_bytes"] == 48_200_000_000
    assert item["status"] == "pending"
    assert item["import_status"] == "importing"
    assert item["service"] == "sonarr"  # normalised, whatever case came in


def test_operation_service_is_null_when_arr_source_is_not_a_service():
    op = _op(arr_source="some-host.example")

    items = _get([op], _downloads()).json()["items"]

    assert items[0]["service"] is None


def test_download_item_has_no_destination_and_uses_the_snapshot_time():
    snap = _downloads(_download(problem=True, size=42), updated_at=1_700_000_000.0)

    items = _get([], snap).json()["items"]

    (item,) = items
    assert item["kind"] == "download"
    assert item["service"] == "sonarr"
    assert item["name"] == "Severance.S02E01"
    assert item["destination"] is None
    assert item["size_bytes"] == 42
    assert item["problem"] is True
    assert item["at"] == 1_700_000_000.0


# ── degradation: one dead source never kills the table ───────────────────────


def test_a_dead_sqlite_still_serves_the_downloads():
    snap = _downloads(_download())

    with patch(
        "application.gateways.history.recent_operations",
        side_effect=RuntimeError("db is gone"),
    ), patch(
        "application.use_cases.downloads_cache.get_downloads",
        new=AsyncMock(return_value=snap),
    ):
        resp = client.get("/api/activity")

    assert resp.status_code == 200
    assert [i["kind"] for i in resp.json()["items"]] == ["download"]


def test_a_failed_snapshot_still_serves_the_operations():
    with patch(
        "application.gateways.history.recent_operations", return_value=[_op()]
    ), patch(
        "application.use_cases.downloads_cache.get_downloads",
        new=AsyncMock(side_effect=RuntimeError("arr fan-out exploded")),
    ):
        resp = client.get("/api/activity")

    assert resp.status_code == 200
    assert [i["kind"] for i in resp.json()["items"]] == ["operation"]
