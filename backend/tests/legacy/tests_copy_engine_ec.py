"""The copy engine's queue operations over the direct EC seam (T5 / S4-S5).

`do_action`'s pause/resume used to reach aMule through the aMuTorrent
WebSocket (`batchPause`/`batchResume`). The default path now goes through the
direct EC seam (`amule_pause`/`amule_resume`, S1-S2). `AMULE_EC_DIRECT=0` is
the mandated rollback to the EXACT aMuTorrent behavior.

These tests pin the EC path and the differential:

* pause/resume reach the EC seam with the 32-char MD4 hash and never touch the
  WebSocket seams;
* the blocking adapter never runs on the event loop (`asyncio.to_thread`, the
  `grab_release` precedent);
* a hash EC cannot address (a qBittorrent SHA1) keeps the EXACT aMuTorrent
  path even with the flag active — the mirror, never a guess; a padded MD4
  (40 chars, trailing zeros) is normalized exactly like `amu_ws_items` does;
* failures keep today's shapes: `sin hash correlacionado` is byte-identical on
  both paths, the unconfigured seam refuses with the shared
  `service_unavailable_reason("amule", "amule")` verbatim, and a typed
  transport error is classified (`Tipo: mensaje`), never a raw traceback;
* `AMULE_EC_DIRECT=0` is the byte-identical aMuTorrent path: same messages,
  same order, same step dicts.

`fix_category` and `delete_torrent`/`cancel_download`'s client half stay on
the aMuTorrent path pending the stop-condition decisions (category name→index
mapping; `deleteFiles` semantics) — their behavior is unchanged either way.
"""

from __future__ import annotations

import asyncio
import threading
from unittest.mock import AsyncMock, patch

import pytest

from application.use_cases.sweep_downloads import _first_detail
from config import service_unavailable_reason
from copy_engine import do_action
from infrastructure.amule_ec_client import AmuleECConnectionError

HASH = "cb5e7b266fc735a77132e8cd4f7fbc19"
PADDED = HASH + "00000000"
SHA1 = "0123456789abcdef0123456789abcdef01234567"

EC_OK = {"target": "amule", "ok": True, "detail": "aplicado vía EC"}
WS_OK = {"target": "amutorrent", "ok": True, "detail": "aplicado vía WebSocket"}
SIN_HASH = {"target": "amutorrent", "ok": False, "detail": "sin hash correlacionado"}


@pytest.fixture(autouse=True)
def _ec_transport(monkeypatch):
    """These tests pin the EC path with the flag ACTIVE (S4). The rollback
    tests override the env themselves; the default-semantics test deletes it.
    Pinning here keeps the file deterministic whatever the ambient
    environment says."""
    monkeypatch.setenv("AMULE_EC_DIRECT", "1")


def _ws_boom():
    """The aMuTorrent seams must not be reachable on the EC path."""
    return AsyncMock(side_effect=AssertionError("the aMuTorrent WS must not be touched"))


def _ws_recorder(log: list, result: dict | None = None):
    """Stand-ins for the WS seams that record every call, in order."""

    async def fake_find(matched_hash, **kwargs):
        log.append(("find_instance", matched_hash))
        return ("amule", "inst-9")

    async def fake_ws(action, payload, **kwargs):
        log.append((action, payload))
        return result or dict(WS_OK)

    return AsyncMock(side_effect=fake_find), AsyncMock(side_effect=fake_ws)


def _seam_recorder(log: list):
    def _record(file_hash):
        log.append(("call", file_hash, threading.get_ident()))

    return _record


# ── The EC path (flag default) ─────────────────────────────────────────────


def test_pause_goes_through_the_ec_seam_by_default(monkeypatch):
    monkeypatch.delenv("AMULE_EC_DIRECT", raising=False)
    calls: list = []

    with patch("copy_engine.amule_pause", _seam_recorder(calls)), \
            patch("copy_engine.amule_resume", side_effect=AssertionError("wrong seam")), \
            patch("infrastructure.arr_client.amu_ws_find_instance", _ws_boom()), \
            patch("infrastructure.arr_client.amu_ws", _ws_boom()):
        result = asyncio.run(do_action(None, "pause", {"matched_hash": HASH}))

    assert result == {"ok": True, "steps": [EC_OK]}
    assert calls == [("call", HASH, calls[0][2])]


def test_resume_goes_through_the_ec_seam_by_default(monkeypatch):
    calls: list = []

    with patch("copy_engine.amule_resume", _seam_recorder(calls)), \
            patch("copy_engine.amule_pause", side_effect=AssertionError("wrong seam")), \
            patch("infrastructure.arr_client.amu_ws_find_instance", _ws_boom()), \
            patch("infrastructure.arr_client.amu_ws", _ws_boom()):
        result = asyncio.run(do_action(None, "resume", {"matched_hash": HASH}))

    assert result == {"ok": True, "steps": [EC_OK]}
    assert calls == [("call", HASH, calls[0][2])]


def test_the_ec_adapter_never_blocks_the_event_loop(monkeypatch):
    """Both seam calls must ride `asyncio.to_thread`: a blocking EC adapter on
    the loop would stall every other request until amuled answers."""
    loop_thread = threading.get_ident()
    seen: list = []

    def fake_pause(file_hash):
        seen.append(threading.get_ident())

    def fake_resume(file_hash):
        seen.append(threading.get_ident())

    with patch("copy_engine.amule_pause", fake_pause), \
            patch("copy_engine.amule_resume", fake_resume), \
            patch("infrastructure.arr_client.amu_ws_find_instance", _ws_boom()), \
            patch("infrastructure.arr_client.amu_ws", _ws_boom()):
        asyncio.run(do_action(None, "pause", {"matched_hash": HASH}))
        asyncio.run(do_action(None, "resume", {"matched_hash": HASH}))

    assert len(seen) == 2
    assert all(ident != loop_thread for ident in seen), "the EC adapter ran ON the event loop"


# ── The rollback: AMULE_EC_DIRECT=0 is the exact aMuTorrent path ────────────


def test_amule_ec_direct_zero_is_the_exact_amutorrent_pause(monkeypatch):
    monkeypatch.setenv("AMULE_EC_DIRECT", "0")
    log: list = []

    with patch("copy_engine.amule_pause", side_effect=AssertionError("the EC seam must not be touched")), \
            patch("infrastructure.arr_client.amu_ws_find_instance", _ws_recorder(log)[0]), \
            patch("infrastructure.arr_client.amu_ws", _ws_recorder(log)[1]):
        result = asyncio.run(do_action(None, "pause", {"matched_hash": HASH}))

    assert result == {"ok": True, "steps": [WS_OK]}
    assert log == [
        ("find_instance", HASH),
        ("batchPause", {"items": [{"fileHash": HASH, "clientType": "amule", "instanceId": "inst-9"}]}),
    ], "byte-identical messages AND order"


def test_amule_ec_direct_zero_is_the_exact_amutorrent_resume(monkeypatch):
    monkeypatch.setenv("AMULE_EC_DIRECT", "0")
    log: list = []

    with patch("copy_engine.amule_resume", side_effect=AssertionError("the EC seam must not be touched")), \
            patch("infrastructure.arr_client.amu_ws_find_instance", _ws_recorder(log)[0]), \
            patch("infrastructure.arr_client.amu_ws", _ws_recorder(log)[1]):
        result = asyncio.run(do_action(None, "resume", {"matched_hash": HASH}))

    assert result == {"ok": True, "steps": [WS_OK]}
    assert log == [
        ("find_instance", HASH),
        ("batchResume", {"items": [{"fileHash": HASH, "clientType": "amule", "instanceId": "inst-9"}]}),
    ], "byte-identical messages AND order"


# ── The mirror: what EC cannot address keeps today's path ───────────────────


def test_a_qbittorrent_hash_keeps_the_amutorrent_path_on_the_ec_path(monkeypatch):
    """A SHA1 has no EC address at all: those items (qBittorrent instances)
    keep the exact aMuTorrent path even with the flag active."""
    log: list = []

    with patch("copy_engine.amule_pause", side_effect=AssertionError("EC cannot address a SHA1")), \
            patch("infrastructure.arr_client.amu_ws_find_instance", _ws_recorder(log)[0]), \
            patch("infrastructure.arr_client.amu_ws", _ws_recorder(log)[1]):
        result = asyncio.run(do_action(None, "pause", {"matched_hash": SHA1}))

    assert result == {"ok": True, "steps": [WS_OK]}
    assert log == [
        ("find_instance", SHA1),
        ("batchPause", {"items": [{"fileHash": SHA1, "clientType": "amule", "instanceId": "inst-9"}]}),
    ]


def test_a_padded_md4_hash_reaches_ec_in_its_32_char_form(monkeypatch):
    """40 chars with trailing zeros is the SAME MD4 `amu_ws_items` truncates;
    the EC seam must get the normalized 32-char hex (the client's `_hash16`
    accepts nothing else)."""
    calls: list = []

    with patch("copy_engine.amule_pause", _seam_recorder(calls)), \
            patch("infrastructure.arr_client.amu_ws_find_instance", _ws_boom()), \
            patch("infrastructure.arr_client.amu_ws", _ws_boom()):
        result = asyncio.run(do_action(None, "pause", {"matched_hash": PADDED}))

    assert result == {"ok": True, "steps": [EC_OK]}
    assert calls == [("call", HASH, calls[0][2])]


# ── Failure shapes (consumed by sweep_downloads._first_detail) ──────────────


@pytest.mark.parametrize("flag", ["1", "0"])
def test_sin_hash_is_the_same_refusal_on_both_paths(monkeypatch, flag):
    monkeypatch.setenv("AMULE_EC_DIRECT", flag)

    with patch("copy_engine.amule_pause", side_effect=AssertionError("nothing to address")), \
            patch("infrastructure.arr_client.amu_ws", _ws_boom()):
        result = asyncio.run(do_action(None, "pause", {"matched_hash": ""}))

    assert result == {"ok": False, "steps": [SIN_HASH]}


def test_the_unconfigured_seam_refuses_with_the_shared_reason(monkeypatch):
    reason = service_unavailable_reason("amule", "amule")

    def boom(file_hash):
        raise RuntimeError(reason)

    with patch("copy_engine.amule_pause", boom), \
            patch("infrastructure.arr_client.amu_ws", _ws_boom()):
        result = asyncio.run(do_action(None, "pause", {"matched_hash": HASH}))

    assert result == {"ok": False, "steps": [{"target": "amule", "ok": False, "detail": reason}]}
    assert _first_detail(result) == reason, "the sweep's failure-shape consumer must read it"


def test_an_ec_transport_error_is_classified_not_a_raw_traceback(monkeypatch):
    def boom(file_hash):
        raise AmuleECConnectionError("conexión EC con amuled caída")

    with patch("copy_engine.amule_resume", boom), \
            patch("infrastructure.arr_client.amu_ws", _ws_boom()):
        result = asyncio.run(do_action(None, "resume", {"matched_hash": HASH}))

    assert result == {
        "ok": False,
        "steps": [{
            "target": "amule",
            "ok": False,
            "detail": "AmuleECConnectionError: conexión EC con amuled caída",
        }],
    }
    assert _first_detail(result) == "AmuleECConnectionError: conexión EC con amuled caída"


def test_a_bare_error_keeps_the_type_message_shape_without_a_dangling_colon(monkeypatch):
    def boom(file_hash):
        raise Exception()

    with patch("copy_engine.amule_pause", boom), \
            patch("infrastructure.arr_client.amu_ws", _ws_boom()):
        result = asyncio.run(do_action(None, "pause", {"matched_hash": HASH}))

    assert result == {"ok": False, "steps": [{"target": "amule", "ok": False, "detail": "Exception"}]}


# ── fix_category: nombre→índice por EC (binding verificado en vivo) ──────────

#: Del binding índice↔título VERIFICADO EN VIVO el 2026-10-22 con dos fuentes
#: independientes (select de amuleweb + orden de GET_PREFERENCES) que concuerdan:
#: radarr=4, radarr-ru=5, tv-sonarr=6, tv-sonarr-ru=7 (0=all). Fixture completo
#: en `tests_amule_ec_client.CATEGORY_BINDING`.
CATEGORIES = {"radarr": 4, "radarr-ru": 5, "tv-sonarr": 6, "tv-sonarr-ru": 7}


def _set_recorder(log: list):
    def _set(file_hash, index):
        log.append(("set_category", file_hash, index, threading.get_ident()))

    return _set


def _del_recorder(log: list):
    def _delete(file_hash, delete_files=False):
        log.append(("delete", file_hash, delete_files, threading.get_ident()))

    return _delete


def _cats_stub(mapping: dict):
    def _categories():
        return dict(mapping)

    return _categories


def _arrless(monkeypatch):
    """Sin servicio arr: el paso `ProcessMonitoredDownloads` no procede."""
    monkeypatch.setattr("copy_engine.SERVICES", [])


def test_fix_category_resolves_the_name_over_ec(monkeypatch):
    _arrless(monkeypatch)
    calls: list = []

    with patch("copy_engine.amule_categories", _cats_stub(CATEGORIES)), \
            patch("copy_engine.amule_set_category", _set_recorder(calls)), \
            patch("infrastructure.arr_client.amu_ws_find_instance", _ws_boom()), \
            patch("infrastructure.arr_client.amu_ws", _ws_boom()):
        result = asyncio.run(do_action(
            None, "fix_category", {"source": "radarr", "matched_hash": HASH},
        ))

    assert result == {"ok": True, "steps": [EC_OK]}
    assert [(c[0], c[1], c[2]) for c in calls] == [("set_category", HASH, 4)]


def test_fix_category_resolves_tv_sonarr_to_the_verified_index(monkeypatch):
    _arrless(monkeypatch)
    calls: list = []

    with patch("copy_engine.amule_categories", _cats_stub(CATEGORIES)), \
            patch("copy_engine.amule_set_category", _set_recorder(calls)), \
            patch("infrastructure.arr_client.amu_ws_find_instance", _ws_boom()), \
            patch("infrastructure.arr_client.amu_ws", _ws_boom()):
        result = asyncio.run(do_action(
            None, "fix_category", {"source": "sonarr", "matched_hash": HASH},
        ))

    assert result == {"ok": True, "steps": [EC_OK]}
    assert [(c[0], c[1], c[2]) for c in calls] == [("set_category", HASH, 6)]


def test_fix_category_refuses_honestly_when_aMule_has_no_such_category(monkeypatch):
    _arrless(monkeypatch)

    with patch("copy_engine.amule_categories", _cats_stub({})), \
            patch("copy_engine.amule_set_category", side_effect=AssertionError("nothing to set")), \
            patch("infrastructure.arr_client.amu_ws", _ws_boom()):
        result = asyncio.run(do_action(
            None, "fix_category", {"source": "radarr", "matched_hash": HASH},
        ))

    assert result == {
        "ok": False,
        "steps": [{"target": "amule", "ok": False, "detail": "la categoría «radarr» no existe en aMule"}],
    }


def test_fix_category_keeps_the_amutorrent_path_for_a_qbittorrent_hash(monkeypatch):
    _arrless(monkeypatch)
    log: list = []

    with patch("copy_engine.amule_set_category", side_effect=AssertionError("EC cannot address a SHA1")), \
            patch("infrastructure.arr_client.amu_ws_find_instance", _ws_recorder(log)[0]), \
            patch("infrastructure.arr_client.amu_ws", _ws_recorder(log)[1]):
        result = asyncio.run(do_action(
            None, "fix_category", {"source": "radarr", "matched_hash": SHA1},
        ))

    assert result == {"ok": True, "steps": [WS_OK]}
    assert log == [
        ("find_instance", SHA1),
        ("batchSetFileCategory", {
            "items": [{"fileHash": SHA1, "clientType": "amule", "instanceId": "inst-9"}],
            "categoryName": "radarr",
            "moveFiles": False,
        }),
    ]


# ── delete: delete_files=True ⇒ disco (0x6A) sólo para completos; resto 0x1D ─


def test_delete_torrent_with_files_calls_the_ec_delete(monkeypatch):
    calls: list = []

    with patch("copy_engine.amule_delete", _del_recorder(calls)), \
            patch("infrastructure.arr_client.amu_ws_find_instance", _ws_boom()), \
            patch("infrastructure.arr_client.amu_ws", _ws_boom()):
        result = asyncio.run(do_action(
            None, "delete_torrent", {"matched_hash": HASH, "delete_files": True},
        ))

    assert result == {"ok": True, "steps": [EC_OK]}
    assert [(c[0], c[1], c[2]) for c in calls] == [("delete", HASH, True)]


def test_delete_torrent_without_files_forwards_the_flag(monkeypatch):
    calls: list = []

    with patch("copy_engine.amule_delete", _del_recorder(calls)), \
            patch("infrastructure.arr_client.amu_ws", _ws_boom()):
        result = asyncio.run(do_action(
            None, "delete_torrent", {"matched_hash": HASH, "delete_files": False},
        ))

    assert result == {"ok": True, "steps": [EC_OK]}
    assert [(c[0], c[1], c[2]) for c in calls] == [("delete", HASH, False)]


def test_cancel_download_deletes_with_files_over_ec(monkeypatch):
    calls: list = []

    with patch("copy_engine.amule_delete", _del_recorder(calls)), \
            patch("infrastructure.arr_client.amu_ws_find_instance", _ws_boom()), \
            patch("infrastructure.arr_client.amu_ws", _ws_boom()):
        result = asyncio.run(do_action(
            None, "cancel_download", {"matched_hash": HASH, "ids": {}},
        ))

    assert result == {"ok": True, "steps": [EC_OK]}
    assert [(c[0], c[1], c[2]) for c in calls] == [("delete", HASH, True)]


def test_delete_keeps_the_amutorrent_path_for_a_qbittorrent_hash(monkeypatch):
    log: list = []

    with patch("copy_engine.amule_delete", side_effect=AssertionError("EC cannot address a SHA1")), \
            patch("infrastructure.arr_client.amu_ws_find_instance", _ws_recorder(log)[0]), \
            patch("infrastructure.arr_client.amu_ws", _ws_recorder(log)[1]):
        result = asyncio.run(do_action(
            None, "delete_torrent", {"matched_hash": SHA1, "delete_files": True},
        ))

    assert result == {"ok": True, "steps": [WS_OK]}
    assert log == [
        ("find_instance", SHA1),
        ("batchDelete", {
            "items": [{"fileHash": SHA1, "clientType": "amule", "instanceId": "inst-9"}],
            "deleteFiles": True,
            "source": "downloads",
        }),
    ]


def test_delete_amule_ec_direct_zero_is_the_exact_amutorrent_message(monkeypatch):
    monkeypatch.setenv("AMULE_EC_DIRECT", "0")
    log: list = []

    with patch("copy_engine.amule_delete", side_effect=AssertionError("the EC seam must not be touched")), \
            patch("infrastructure.arr_client.amu_ws_find_instance", _ws_recorder(log)[0]), \
            patch("infrastructure.arr_client.amu_ws", _ws_recorder(log)[1]):
        result = asyncio.run(do_action(
            None, "delete_torrent", {"matched_hash": HASH, "delete_files": True},
        ))

    assert result == {"ok": True, "steps": [WS_OK]}
    assert log == [
        ("find_instance", HASH),
        ("batchDelete", {
            "items": [{"fileHash": HASH, "clientType": "amule", "instanceId": "inst-9"}],
            "deleteFiles": True,
            "source": "downloads",
        }),
    ], "byte-identical messages AND order"


def test_the_new_ec_calls_also_ride_to_thread(monkeypatch):
    """The blocking adapter never runs on the event loop — delete and the
    category lookup/set included."""
    _arrless(monkeypatch)
    loop_thread = threading.get_ident()
    seen: list = []

    def _note(*args):
        seen.append(threading.get_ident())

    with patch("copy_engine.amule_delete", _note), \
            patch("copy_engine.amule_categories", lambda: (seen.append(threading.get_ident()) or dict(CATEGORIES))), \
            patch("copy_engine.amule_set_category", _note), \
            patch("infrastructure.arr_client.amu_ws", _ws_boom()):
        asyncio.run(do_action(None, "delete_torrent", {"matched_hash": HASH, "delete_files": True}))
        asyncio.run(do_action(None, "fix_category", {"source": "radarr", "matched_hash": HASH}))

    assert len(seen) == 3
    assert all(ident != loop_thread for ident in seen), "the EC adapter ran ON the event loop"
