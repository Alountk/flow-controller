"""Direct-add downloads must exist as traces — or the destination never gets them.

The arr was never told about a direct add (B-10), so its history will never
carry it: without a synthesised row the download is invisible to `/api/trace`,
to Seguimiento AND to the auto-copy sweep — the file would sit in the client
forever while the operator's chosen 4K/3D folder never receives it.

The join to the client's torrent is the identity recorded at add time —
`client_name` (exact) or `client_hash` (exact) — never fuzzy: an unmatched
grab produces no row rather than a wrong one.
"""

import asyncio

import traces as traces_module
from traces import _direct_traces


def _torrent(**over):
    base = {
        "hash": "abc123def456abc123def456abc123def456abcd",
        "name": "Movie.2024.2160p.UHD.BluRay.x265-GRP.mkv",
        "state": "downloading",
        "progress": 0.42,
        "category": "flow",
        "save_path": "/mnt/storage-6tb/shared-downloads",
        "size": 6_000_000_000,
    }
    base.update(over)
    return base


def _grab(**over):
    base = {
        "id": 1,
        "source": "radarr",
        "movie_id": 855,
        "episode_id": None,
        "series_id": None,
        "guid": "rel-1",
        "indexer_id": 1,
        "grabbed_at": 1_700_000_000.0,
        "destination": "/mnt/storage-6tb/Movies4K",
        "quality": "Bluray-2160p",
        "direct": 1,
        "client_name": "Movie.2024.2160p.UHD.BluRay.x265-GRP.mkv",
        "client_hash": None,
    }
    base.update(over)
    return base


# ── The join ────────────────────────────────────────────────────────────────


def test_a_direct_grab_becomes_a_trace_joined_by_exact_name():
    (row,) = _direct_traces([_grab()], [_torrent()])

    assert row["source"] == "radarr"
    assert row["title"] == "Movie.2024.2160p.UHD.BluRay.x265-GRP.mkv"
    assert row["download_id"] == "abc123def456abc123def456abc123def456abcd"
    assert row["matched_hash"] == row["download_id"]
    assert row["stage"] == "downloading"
    assert row["torrent"]["progress"] == 42.0
    assert row["destination"] == "/mnt/storage-6tb/Movies4K"
    assert row["ids"]["movie_id"] == 855
    assert row["ids"]["queue_id"] is None, "no arr queue exists for this download"
    assert row["queue"] is None
    # OUR category, not an arr expectation: no false "Cat. incorrecta" chip.
    assert row["expected_category"] is None and row["category_ok"] is None


def test_a_stored_hash_joins_even_when_the_client_renamed_the_torrent():
    (row,) = _direct_traces(
        [_grab(client_name="renamed-by-metadata.mkv", client_hash="ABC123DEF456ABC123DEF456ABC123DEF456ABCD")],
        [_torrent(name="completely-different.mkv")],
    )

    # Hash is matched case-insensitively; the name never had to agree.
    assert row["download_id"] == "abc123def456abc123def456abc123def456abcd"


def test_no_matching_torrent_produces_no_row_rather_than_a_guess():
    assert _direct_traces([_grab(client_name="gone.mkv")], [_torrent()]) == []


def test_an_arr_tracked_grab_is_not_synthesised():
    # direct=0 rows come from the arr's own history — the loop above already
    # built them; a second row would double every grab.
    assert _direct_traces([_grab(direct=0)], [_torrent()]) == []


def test_an_empty_registry_or_torrent_list_is_an_empty_answer():
    assert _direct_traces([], [_torrent()]) == []
    assert _direct_traces([_grab()], []) == []


def test_a_finished_download_reads_as_downloaded():
    (row,) = _direct_traces([_grab()], [_torrent(progress=1.0, state="uploading")])

    assert row["stage"] == "downloaded"


def test_the_date_is_the_grab_in_the_same_iso_shape_as_the_arrs():
    (row,) = _direct_traces([_grab(grabbed_at=1_700_000_000.0)], [_torrent()])

    assert row["date"] == "2023-11-14T22:13:20Z"


# ── The wiring: build_traces appends them ───────────────────────────────────


def test_build_traces_appends_the_direct_row(monkeypatch):
    """The full poll, with every I/O boundary stubbed: no arr history, one
    client torrent, one direct own-grab → exactly one trace, synthesised."""
    service = {"key": "radarr", "kind": "arr", "url": "http://radarr.test:7878", "api_key": "k"}

    async def _no_grabs(session, svc, limit):
        return []

    async def _no_queue(session, svc):
        return []

    async def _no_dc(session, svc):
        return []

    async def _no_paths(session, svc):
        return {}

    async def _torrents(session):
        return [_torrent()]

    monkeypatch.setattr(traces_module, "configured_services", lambda kind=None: [service])
    monkeypatch.setattr(traces_module, "fetch_arr_grabbed", _no_grabs)
    monkeypatch.setattr(traces_module, "fetch_arr_queue", _no_queue)
    monkeypatch.setattr(traces_module, "arr_download_clients", _no_dc)
    monkeypatch.setattr(traces_module, "fetch_arr_all_movies", _no_paths)
    monkeypatch.setattr(traces_module, "fetch_qbit_torrents", _torrents)
    monkeypatch.setattr(traces_module, "list_own_grabs", lambda since, limit=200: [_grab()])

    result = asyncio.run(traces_module.build_traces(None))

    assert len(result) == 1
    assert result[0]["download_id"] == "abc123def456abc123def456abc123def456abcd"
    assert result[0]["destination"] == "/mnt/storage-6tb/Movies4K"


def test_build_traces_survives_an_unreadable_registry(monkeypatch):
    service = {"key": "radarr", "kind": "arr", "url": "http://radarr.test:7878", "api_key": "k"}

    async def _no_grabs(session, svc, limit):
        return []

    async def _no_queue(session, svc):
        return []

    async def _no_dc(session, svc):
        return []

    async def _no_paths(session, svc):
        return {}

    async def _torrents(session):
        return [_torrent()]

    def _boom(since, limit=200):
        raise RuntimeError("db gone")

    monkeypatch.setattr(traces_module, "configured_services", lambda kind=None: [service])
    monkeypatch.setattr(traces_module, "fetch_arr_grabbed", _no_grabs)
    monkeypatch.setattr(traces_module, "fetch_arr_queue", _no_queue)
    monkeypatch.setattr(traces_module, "arr_download_clients", _no_dc)
    monkeypatch.setattr(traces_module, "fetch_arr_all_movies", _no_paths)
    monkeypatch.setattr(traces_module, "fetch_qbit_torrents", _torrents)
    monkeypatch.setattr(traces_module, "list_own_grabs", _boom)

    result = asyncio.run(traces_module.build_traces(None))

    # Degrades to the arr-side answer; the poll never dies.
    assert result == []
