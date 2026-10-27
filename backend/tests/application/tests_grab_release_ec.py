"""The grab's transport IS the dispatch: the row's link goes as-is (T2 / S2).

This file used to pin the ED2K RESOLVE/enqueue the worker ran over the direct
EC seam (`_ec_search_link` / `_ec_add_link` / `_search_query`) — the step that
asked aMule's indexer for the link behind a hash-id guid and joined on the
result's file hash. calendario-directo T2/S2 deletes that machinery from
`run_grab` verbatim: «no se re-busca el enlace — la fila ya trae
`link`/`guid`». What survives is the SHAPE dispatch of
`interfaces.http.routes.indexers.dispatch_direct`, which the route injects
into the worker, and these tests pin the grab-level contract of it:

* the row's own target (`link or guid`) reaches the right seam AS-IS — ed2k
  → `amule_add_ed2k` (EC, AMULE_EC_DIRECT default), 32-hex aMule hash →
  `amule_download_search_result`, magnet → the native qBittorrent client —
  and NOT ONE search seam is ever called (the no-re-search proof);
* the category is chosen by destination (S3): library → the arr's watched
  category (`tv-sonarr` for sonarr), explicit destination → `flow`;
* `AMULE_EC_DIRECT=0` is the exact aMuTorrent rollback (S7) at the grab level
  too: the legacy bridge receives the link and the category, never the EC
  seams.

The transport-level rules of the dispatch itself (refusals, redaction,
`_BAD_SCHEME`, the off-the-loop EC adapter) are covered endpoint-side by
`tests/interfaces/routes/tests_indexers_download.py`; the retired resolve
matching (exact hash / Radarr-suffixed base / size tiebreak) lives on in
`tests/infrastructure/tests_direct_add.py` against `arr_client.
amutorrent_search_link`, the one copy of that rule still standing.
"""

from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

from application import gateways
from application.use_cases.grab_release import grab_tasks, start_grab
from infrastructure.arr_client import direct_link_identity

FOREIGN = "/mnt/storage-6tb/Movies4K"
LIBRARY_ROOT = "/mnt/storage/movies"

TITLE = "Your.Name.2016.1080p.BluRay.x264-GRP"
HASH = "cb5e7b266fc735a77132e8cd4f7fbc19"
ED2K_LINK = (
    "ed2k://|file Your.Name.2016.1080p.BluRay.x264-GRP.mkv"
    "|8589934592|ABCDEF0123456789ABCDEF0123456789|/"
)
MAGNET = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Your.Name.2016"


@asynccontextmanager
async def _session():
    """A session stand-in: the EC seams never need one, and the bridge seam
    is faked at the gateways level below."""
    yield object()


async def _resolve_series_none(session, service, source, episode_id):
    return None


async def _await_settled(task_id: str, *, timeout: float = 2.0) -> dict:
    """Poll the registry until the worker settles the job, or explain why not."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        task = grab_tasks.get(task_id)
        if task and task.get("status") in ("done", "error"):
            return task
        await asyncio.sleep(0.01)
    raise AssertionError(f"grab {task_id} never settled: {grab_tasks.get(task_id)}")


def _settle(**kwargs) -> dict:
    """Start a grab with the REAL dispatch and wait for the worker's settle,
    all on one loop (`start_grab` schedules the worker with `create_task`).

    The dispatch import is LAZY on purpose (app.py:35-37): route modules
    snapshot `gateways`' adapter names at import, so importing one before the
    composition root ran `gateways.bind()` would hand it a module full of None
    for the WHOLE pytest session (this file is collected long before `app`).
    """
    from interfaces.http.routes.indexers import dispatch_direct

    kwargs.setdefault("source", "radarr")
    kwargs.setdefault("service", {"name": "Radarr"})
    kwargs.setdefault("guid", HASH)
    kwargs.setdefault("title", TITLE)

    async def scenario():
        started = start_grab(
            **kwargs,
            session_factory=_session,
            resolve_series=_resolve_series_none,
            dispatch=dispatch_direct,
        )
        return await _await_settled(started["task_id"])

    task = asyncio.run(scenario())
    grab_tasks._tasks.pop(task["id"], None)
    return task


def _transport():
    """Every client seam faked at the GATEWAYS level, recording every call.

    `search` is the re-search seam S2 deleted from the flow: it must never be
    called, and the fake proves it from the transport side. `identity` is the
    pure `arr_client` rule (the gateway seam is unbound in this module).
    """
    seams = MagicMock()
    seams.add = MagicMock()
    seams.hash_add = MagicMock()
    seams.search = MagicMock(return_value=[])
    seams.qbit = AsyncMock(return_value={"ok": True, "detail": "Descarga añadida en qBittorrent (stub), categoría flow"})
    seams.bridge = AsyncMock(return_value={"ok": True, "detail": "Descarga añadida (categoría flow)"})
    seams.record = MagicMock()
    patches = (
        patch.object(gateways, "amule_add_ed2k", seams.add),
        patch.object(gateways, "amule_download_search_result", seams.hash_add),
        patch.object(gateways, "amule_search", seams.search),
        patch.object(gateways, "qbit_add_download", seams.qbit),
        patch.object(gateways, "amutorrent_add_download", seams.bridge),
        patch("application.use_cases.grab_release.record_own_grab", seams.record),
        patch("application.use_cases.grab_release.direct_link_identity", direct_link_identity),
    )
    return patches, seams


def _run_seams(**kwargs):
    """One grab through the worker with the transport scripted; returns the
    settled task and the recording seams."""
    patches, seams = _transport()
    with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6]:
        task = _settle(**kwargs)
    return task, seams


# ── The row's own link is dispatched as-is — there is no resolve step ────────


def test_an_ed2k_link_is_enqueued_by_the_ec_seam_and_never_searched(monkeypatch):
    """S2: «no se re-busca el enlace» — the ed2k link goes to `amule_add_ed2k`
    AS-IS (AMULE_EC_DIRECT default) and the search seam is never touched."""
    monkeypatch.delenv("AMULE_EC_DIRECT", raising=False)
    task, seams = _run_seams(guid=ED2K_LINK)

    assert task["status"] == "done"
    assert task["ok"] is True
    seams.add.assert_called_once_with(ED2K_LINK)
    seams.search.assert_not_called(), "S2: no hay re-busca en este flujo"
    assert seams.record.call_args.kwargs["direct"] is True
    assert seams.record.call_args.kwargs["client_name"] == "Your.Name.2016.1080p.BluRay.x264-GRP.mkv"
    assert seams.record.call_args.kwargs["client_hash"] is None, "the ED2K hash is not the client's infohash"


def test_a_magnet_is_added_by_the_native_client_under_the_arrs_watched_category(monkeypatch):
    """S2/S3: `magnet:` → the native qBittorrent client, and a library grab
    takes the category the arr watches — literal `tv-sonarr` for sonarr."""
    monkeypatch.delenv("AMULE_EC_DIRECT", raising=False)
    task, seams = _run_seams(source="sonarr", guid=MAGNET)

    assert task["status"] == "done"
    assert task["ok"] is True
    assert seams.qbit.await_args.args[1] == MAGNET
    assert seams.qbit.await_args.args[2] == "tv-sonarr"
    seams.search.assert_not_called()
    seams.add.assert_not_called()


def test_a_32_hex_hash_is_added_via_download_search_result(monkeypatch):
    """S2: a 32-hex aMule hash-id (rows without a buildable link) → the EC
    `DOWNLOAD_SEARCH_RESULT` entry point, no search, no join."""
    monkeypatch.delenv("AMULE_EC_DIRECT", raising=False)
    task, seams = _run_seams(guid=HASH)

    assert task["status"] == "done"
    assert task["ok"] is True
    seams.hash_add.assert_called_once_with(HASH)
    seams.search.assert_not_called()
    seams.add.assert_not_called()


def test_the_rollback_takes_the_legacy_bridge_and_keeps_the_category():
    """S2/S7: `AMULE_EC_DIRECT=0` is the exact aMuTorrent rollback at the grab
    level too — the legacy bridge receives the row's link and the category
    (S3: an explicit destination is `flow`), and the EC seams stay shut."""
    with patch.dict("os.environ", {"AMULE_EC_DIRECT": "0"}):
        task, seams = _run_seams(guid=ED2K_LINK, destination=FOREIGN)

    assert task["status"] == "done"
    assert task["ok"] is True
    assert seams.bridge.await_args.args[1] == ED2K_LINK
    assert seams.bridge.await_args.args[2] == "flow"
    seams.add.assert_not_called()
    seams.hash_add.assert_not_called()
    assert task["detail"] == (
        "Descarga añadida (categoría flow) — directa: el arr no la verá ni la importará"
    )


def test_the_row_link_wins_over_the_guid_and_the_guid_is_the_fallback():
    """S2: the target is `link or guid` — the `link ?? guid` precedent. A row
    that carries both dispatches the link; a row with no link dispatches its
    guid."""
    task, seams = _run_seams(guid="g1", link=MAGNET)
    assert task["ok"] is True
    assert seams.qbit.await_args.args[1] == MAGNET, "the link wins over the guid"

    task, seams = _run_seams(guid=MAGNET)
    assert task["ok"] is True
    assert seams.qbit.await_args.args[1] == MAGNET, "no link: the guid IS the target"
