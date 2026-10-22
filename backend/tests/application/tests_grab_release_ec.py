"""The grab's ED2K resolve/enqueue over the direct EC seam (T4 / S3).

`grab_release` used to resolve and enqueue ED2K through aMuTorrent
(`amutorrent_search_link` / `amutorrent_add_download`). The default path now
does it through the direct EC seam (`amule_search` / `amule_add_ed2k`,
S1-S2), still INSIDE the server-side worker task: ED2K is slow and must never
block the user's request. `AMULE_EC_DIRECT=0` is the mandated rollback to the
exact aMuTorrent behavior.

These tests pin the EC path (the flag active) and the differential:

* the three `guid` shapes keep their semantics — a direct `ed2k://`/`magnet:`
  link skips the search entirely, an `https://` guid refuses with the same
  honesty, and an indexer hash resolves by searching EC with the release
  title's short query and picking what the old matching logic would pick
  (exact hash first, Radarr-suffixed base next, size tiebreak, first of those);
* the enqueue mirrors today's observable outcome: one `amule_add_ed2k` with
  the constructed `ed2k://|file|<name>|<size>|<hash>|/` link and NO category
  (S5 — the current call passes no category either);
* failures surface the way they do today: a refusal settles `done`/`ok=False`
  with the detail and records nothing; the unconfigured seam refuses with
  `service_unavailable_reason("amule", "amule")`;
* the blocking EC adapter never runs on the event loop (`asyncio.to_thread`,
  the `record_own_grab` precedent in this worker);
* `AMULE_EC_DIRECT=0` takes the aMuTorrent seams and never touches the EC
  ones — the rollback this spec mandates.
"""

from __future__ import annotations

import asyncio
import threading
import time
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from application.use_cases.grab_release import grab_tasks, start_grab
from config import service_unavailable_reason
from infrastructure.amule_ec_client import AmuleECCommandError, AmuleECConnectionError, SearchResult
from infrastructure.arr_client import direct_link_identity

FOREIGN = "/mnt/storage-6tb/Movies4K"
LIBRARY_ROOT = "/mnt/storage/movies"

TITLE = "Your.Name.2016.1080p.BluRay.x264-GRP"
HASH = "cb5e7b266fc735a77132e8cd4f7fbc19"

#: The EC success payload is today's, minus the `(categoría flow)` label the
#: EC add cannot apply (no category is invented on this path).
DIRECT_DETAIL = "Descarga añadida — directa: el arr no la verá ni la importará"


@asynccontextmanager
async def _session():
    """A session stand-in: the EC path never needs an HTTP session."""
    yield object()


@pytest.fixture(autouse=True)
def _ec_transport(monkeypatch):
    """These tests pin the EC path with the flag ACTIVE (S3). The two
    rollback tests override the env themselves; the default-semantics test
    deletes it. Pinning here keeps the file deterministic whatever the
    ambient environment says."""
    monkeypatch.setenv("AMULE_EC_DIRECT", "1")


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


def _start(**kwargs) -> dict:
    kwargs.setdefault("source", "radarr")
    kwargs.setdefault("service", {"name": "Radarr"})
    kwargs.setdefault("guid", HASH)
    kwargs.setdefault("destination", FOREIGN)
    kwargs.setdefault("title", TITLE)
    return start_grab(
        **kwargs,
        session_factory=_session,
        resolve_series=_resolve_series_none,
    )


def _forget(task_id: str) -> None:
    grab_tasks._tasks.pop(task_id, None)


def _settle(**kwargs) -> dict:
    """Start the grab and wait for the worker's settle, all on one loop
    (`start_grab` schedules the worker with `asyncio.create_task`)."""

    async def scenario():
        started = _start(**kwargs)
        return await _await_settled(started["task_id"])

    task = asyncio.run(scenario())
    _forget(task["id"])
    return task


def _result(
    name="Your.Name.2016.1080p.BluRay.x264-GRP.mkv",
    size=8589934592,
    file_hash=HASH,
    sources=12,
):
    return SearchResult(
        name=name,
        size=size,
        file_hash=file_hash,
        sources=sources,
        sources_xfer=0,
        status=0,
    )


def _run(result=None, *, search=None, add=None, guid=HASH, size=0, title=TITLE):
    """One foreign grab through the worker with the EC seams scripted.

    `search`/`add` may be exceptions to raise instead of return values.
    """
    search_mock = MagicMock(
        side_effect=search if isinstance(search, BaseException) else None,
        return_value=result,
    )
    add_mock = MagicMock(side_effect=add if isinstance(add, BaseException) else None)
    with patch("application.use_cases.grab_release.arr_root_folders", new=AsyncMock(return_value=[LIBRARY_ROOT])), \
            patch("application.use_cases.grab_release.arr_grab_release", new=AsyncMock()) as arr, \
            patch("application.use_cases.grab_release.record_own_grab") as record, \
            patch("application.use_cases.grab_release.direct_link_identity", direct_link_identity), \
            patch("application.use_cases.grab_release.amule_search", search_mock), \
            patch("application.use_cases.grab_release.amule_add_ed2k", add_mock), \
            patch("application.use_cases.grab_release.amutorrent_search_link", new=AsyncMock()) as old_search, \
            patch("application.use_cases.grab_release.amutorrent_add_download", new=AsyncMock()) as old_add:
        task = _settle(guid=guid, size=size, title=title)
    return task, search_mock, add_mock, record, arr, old_search, old_add


# ── The EC path is the default ───────────────────────────────────────────────


def test_an_unsettled_flag_takes_the_ec_path_and_enqueues_the_constructed_link(monkeypatch):
    """Unset `AMULE_EC_DIRECT` = EC: search by the short query, then one
    `amule_add_ed2k` with the constructed link — no category, never the
    aMuTorrent seams, never the arr."""
    monkeypatch.delenv("AMULE_EC_DIRECT", raising=False)
    task, search, add, record, arr, old_search, old_add = _run([_result()])

    assert task["status"] == "done"
    assert task["ok"] is True
    assert task["direct"] is True
    assert task["detail"] == DIRECT_DETAIL

    search.assert_called_once_with("Your Name 2016")
    add.assert_called_once_with(
        f"ed2k://|file|{_result().name}|{_result().size}|{HASH}|/"
    )
    assert add.call_args.kwargs == {}, "S5: no category is invented on this path"
    old_search.assert_not_awaited()
    old_add.assert_not_awaited()
    arr.assert_not_awaited(), "the arr must never be told about this download"

    kwargs = record.call_args.kwargs
    assert record.call_args.args == ("radarr",)
    assert kwargs["direct"] is True
    assert kwargs["destination"] == FOREIGN
    assert kwargs["client_name"] == _result().name, (
        "tracking keeps the client's file name, not the release title"
    )
    assert kwargs["client_hash"] is None, "the ED2K hash is not the client's infohash"


def test_the_flag_set_to_anything_but_zero_is_still_the_ec_path():
    with patch.dict("os.environ", {"AMULE_EC_DIRECT": "1"}):
        task, search, add, *_ = _run([_result()])

    assert task["ok"] is True
    search.assert_called_once()
    add.assert_called_once()


def test_the_blocking_ec_adapter_never_runs_on_the_event_loop():
    """The EC adapter is synchronous: both seam calls must ride
    `asyncio.to_thread` (the `record_own_grab` precedent), or one slow ED2K
    search would freeze every other request."""
    loop_thread = threading.get_ident()
    seen = []

    def fake_search(query):
        seen.append(("search", threading.get_ident()))
        return [_result()]

    def fake_add(link):
        seen.append(("add", threading.get_ident()))

    with patch("application.use_cases.grab_release.arr_root_folders", new=AsyncMock(return_value=[LIBRARY_ROOT])), \
            patch("application.use_cases.grab_release.record_own_grab"), \
            patch("application.use_cases.grab_release.direct_link_identity", direct_link_identity), \
            patch("application.use_cases.grab_release.amule_search", fake_search), \
            patch("application.use_cases.grab_release.amule_add_ed2k", fake_add):
        task = _settle()

    assert task["ok"] is True
    assert [name for name, _ in seen] == ["search", "add"]
    assert all(tid != loop_thread for _, tid in seen), (
        "the blocking EC calls ran ON the event loop"
    )


# ── The three guid shapes keep their semantics ───────────────────────────────


def test_a_direct_ed2k_guid_skips_the_search_entirely():
    guid = "ed2k://|file X.mkv|1|AA|/"
    task, search, add, record, *_ = _run(guid=guid)

    assert task["ok"] is True and task["direct"] is True
    search.assert_not_called(), "a direct link has nothing to search"
    add.assert_called_once_with(guid)
    assert record.call_args.kwargs["client_name"] == "X.mkv"


def test_a_magnet_guid_is_enqueued_as_is_and_never_searched():
    guid = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"
    task, search, add, record, *_ = _run(guid=guid)

    assert task["ok"] is True and task["direct"] is True
    search.assert_not_called()
    add.assert_called_once_with(guid)


def test_an_https_guid_refuses_with_the_same_honesty():
    task, search, add, record, arr, *_ = _run(guid="https://knaben.example/details/42")

    assert task["status"] == "done"
    assert task["ok"] is False
    assert task["detail"] == (
        "Este release viene de otro indexador (su guid es una página web, "
        "no un enlace): el indexador de aMule no lo tiene. Elige "
        "Destino = Biblioteca para descargarlo con Radarr/Sonarr."
    )
    search.assert_not_called()
    add.assert_not_called()
    record.assert_not_called()
    arr.assert_not_awaited()


# ── The old matching rules, over EC results ──────────────────────────────────


def test_an_indexer_hash_picks_the_exact_hash_result():
    # The wanted hash is second: only the join can pick it, never the order.
    results = [
        _result(name="Noise.mkv", file_hash="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        _result(name="Wanted.mkv", file_hash=HASH),
    ]
    task, _, add, *_ = _run(results)

    assert task["ok"] is True
    assert "Wanted.mkv" in add.call_args.args[0]
    assert add.call_args.args[0] == f"ed2k://|file|Wanted.mkv|{8589934592}|{HASH}|/"


def test_a_suffixed_guid_matches_its_base_hash():
    results = [_result(name="User.Version.mkv", file_hash=HASH)]
    task, _, add, record, *_ = _run(results, guid=f"{HASH}-c9ff6af3")

    assert task["ok"] is True
    assert "User.Version.mkv" in add.call_args.args[0]
    assert record.call_args.kwargs["client_name"] == "User.Version.mkv"


def test_duplicate_hashes_are_told_apart_by_the_size_the_arr_recorded():
    results = [
        _result(name="Big.Version.mkv", size=8219420878, file_hash=HASH),
        _result(name="Small.Version.mkv", size=13753, file_hash=HASH),
    ]
    task, _, add, *_ = _run(results, size=13753)

    assert task["ok"] is True
    assert "Small.Version.mkv" in add.call_args.args[0]


def test_no_results_refuses_like_the_old_indexer_message():
    task, _, add, record, *_ = _run([])

    assert task["status"] == "done"
    assert task["ok"] is False
    assert task["detail"] == (
        f"el indexador de aMule no devolvió resultados para «{TITLE}»; "
        "elige Destino = Biblioteca para descargarlo con Radarr/Sonarr"
    )
    add.assert_not_called()
    record.assert_not_called()


def test_no_matching_hash_refuses_and_enqueues_nothing():
    results = [_result(file_hash="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    task, _, add, record, *_ = _run(results, guid="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")

    assert task["status"] == "done"
    assert task["ok"] is False
    assert task["detail"] == (
        f"No encontré «{TITLE}» en el indexador de aMule; no se envió nada "
        "al arr. Elige Destino = Biblioteca para descargarlo con Radarr/Sonarr."
    )
    add.assert_not_called()
    record.assert_not_called()


def test_the_ec_search_uses_the_same_short_query_normalization():
    """The mirror of `arr_client._search_query` must stay byte-for-byte: the
    ED2K network can only answer "Name Year", on either transport."""
    from application.use_cases.grab_release import _search_query

    assert _search_query(
        "Spider-Man.Brand.New.Day.(2026).(Spanish.English.Subs).Micro4K.2160p"
        ".HDR10.DV.x265.10Bits-AC3.by.lagartish.(hispashare.org).mkv"
    ) == "Spider-Man Brand New Day 2026"
    assert _search_query("Movie.2021.1080p.BluRay.x264-GRP.mkv") == "Movie 2021"


# ── Failures surface the way they do today ───────────────────────────────────


def test_the_unconfigured_seam_refuses_with_the_service_reason():
    reason = service_unavailable_reason("amule", "amule")
    task, _, add, record, *_ = _run(search=RuntimeError(reason))

    assert task["status"] == "done", "a refusal the worker produced, not a failed job"
    assert task["ok"] is False
    assert "no está configurado" in task["detail"]
    assert task["detail"] == reason
    add.assert_not_called()
    record.assert_not_called()


def test_a_transport_error_refuses_with_the_indexer_did_not_answer():
    task, _, add, record, *_ = _run(search=AmuleECConnectionError("went away"))

    assert task["status"] == "done"
    assert task["ok"] is False
    assert task["detail"] == (
        "el indexador de aMule no respondió (AmuleECConnectionError); "
        "puede estar buscando en ED2K — inténtalo de nuevo o elige "
        "Destino = Biblioteca"
    )
    record.assert_not_called()


def test_an_add_refusal_is_reported_and_not_recorded():
    task, _, _, record, arr, *_ = _run(
        [_result()], add=AmuleECCommandError("Invalid link or already on list.")
    )

    assert task["status"] == "done"
    assert task["ok"] is False
    assert task["detail"] == (
        "aMuTorrent no aceptó la descarga: "
        "AmuleECCommandError: Invalid link or already on list."
    )
    record.assert_not_called()
    arr.assert_not_awaited()


# ── The rollback: AMULE_EC_DIRECT=0 is the exact aMuTorrent path ─────────────


def test_flag_zero_takes_the_amutorrent_seams_and_never_the_ec_ones():
    with patch.dict("os.environ", {"AMULE_EC_DIRECT": "0"}):
        old_search = AsyncMock(
            return_value={"ok": True, "link": "ed2k://|file Old.mkv|1|AA|/", "detail": "query"}
        )
        old_add = AsyncMock(return_value={"ok": True, "detail": "Descarga añadida (categoría flow)"})
        ec_search = MagicMock()
        ec_add = MagicMock()
        with patch("application.use_cases.grab_release.arr_root_folders", new=AsyncMock(return_value=[LIBRARY_ROOT])), \
                patch("application.use_cases.grab_release.arr_grab_release", new=AsyncMock()), \
                patch("application.use_cases.grab_release.record_own_grab") as record, \
                patch("application.use_cases.grab_release.direct_link_identity", direct_link_identity), \
                patch("application.use_cases.grab_release.amutorrent_search_link", old_search), \
                patch("application.use_cases.grab_release.amutorrent_add_download", old_add), \
                patch("application.use_cases.grab_release.amule_search", ec_search), \
                patch("application.use_cases.grab_release.amule_add_ed2k", ec_add):
            task = _settle()

    # The exact aMuTorrent flow: same calls, same order, same payload.
    old_search.assert_awaited_once()
    assert old_search.await_args.args[1] == TITLE
    assert old_search.await_args.kwargs == {"guid": HASH, "size": 0}
    old_add.assert_awaited_once()
    assert old_add.await_args.args[1] == "ed2k://|file Old.mkv|1|AA|/"
    ec_search.assert_not_called()
    ec_add.assert_not_called()

    assert task["status"] == "done"
    assert task["ok"] is True
    assert task["direct"] is True
    assert task["detail"] == (
        "Descarga añadida (categoría flow) — directa: el arr no la verá ni la importará"
    )
    assert record.call_args.kwargs["client_name"] == "Old.mkv"


def test_flag_zero_keeps_the_old_refusals_byte_for_byte():
    detail = "aMuTorrent no está configurado"
    with patch.dict("os.environ", {"AMULE_EC_DIRECT": "0"}):
        old_search = AsyncMock(return_value={"ok": False, "detail": detail})
        old_add = AsyncMock()
        with patch("application.use_cases.grab_release.arr_root_folders", new=AsyncMock(return_value=[LIBRARY_ROOT])), \
                patch("application.use_cases.grab_release.arr_grab_release", new=AsyncMock()), \
                patch("application.use_cases.grab_release.record_own_grab") as record, \
                patch("application.use_cases.grab_release.direct_link_identity", direct_link_identity), \
                patch("application.use_cases.grab_release.amutorrent_search_link", old_search), \
                patch("application.use_cases.grab_release.amutorrent_add_download", old_add):
            task = _settle()

    assert task["status"] == "done"
    assert task["ok"] is False
    assert task["detail"] == detail
    old_add.assert_not_awaited()
    record.assert_not_called()


@pytest.mark.parametrize("guid", ["", "not-a-hash"])
def test_a_guid_that_matches_nothing_still_refuses_before_enqueuing(guid):
    task, _, add, record, *_ = _run([_result(file_hash=HASH)], guid=guid)

    assert task["ok"] is False
    assert "No encontré" in task["detail"]
    add.assert_not_called()
    record.assert_not_called()
