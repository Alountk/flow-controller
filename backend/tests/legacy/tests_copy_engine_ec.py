"""The copy engine's queue operations over the direct EC seam.

pause/resume/delete/fix_category reach aMule only through `amule_*` over EC:
the 32-char MD4 (a padded 40-char form is normalized), off the event loop,
with classified failures and a refusal for a hash EC cannot address.
"""

from __future__ import annotations

import asyncio
import threading
from unittest.mock import patch

import pytest

from application.use_cases.sweep_downloads import _first_detail
from config import service_unavailable_reason
from copy_engine import do_action
from infrastructure.amule_ec_client import AmuleECConnectionError

HASH = "cb5e7b266fc735a77132e8cd4f7fbc19"
PADDED = HASH + "00000000"
SHA1 = "0123456789abcdef0123456789abcdef01234567"

EC_OK = {"target": "amule", "ok": True, "detail": "aplicado vía EC"}
SIN_HASH = {"target": "amule", "ok": False, "detail": "sin hash correlacionado"}


def _seam_recorder(log: list):
    def _record(file_hash):
        log.append(("call", file_hash, threading.get_ident()))

    return _record


# ── The EC path (flag default) ─────────────────────────────────────────────


def test_pause_goes_through_the_ec_seam_by_default(monkeypatch):
    calls: list = []

    with patch("copy_engine.amule_pause", _seam_recorder(calls)), \
            patch("copy_engine.amule_resume", side_effect=AssertionError("wrong seam")):
        result = asyncio.run(do_action(None, "pause", {"matched_hash": HASH}))

    assert result == {"ok": True, "steps": [EC_OK]}
    assert calls == [("call", HASH, calls[0][2])]


def test_resume_goes_through_the_ec_seam_by_default(monkeypatch):
    calls: list = []

    with patch("copy_engine.amule_resume", _seam_recorder(calls)), \
            patch("copy_engine.amule_pause", side_effect=AssertionError("wrong seam")):
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
            patch("copy_engine.amule_resume", fake_resume):
        asyncio.run(do_action(None, "pause", {"matched_hash": HASH}))
        asyncio.run(do_action(None, "resume", {"matched_hash": HASH}))

    assert len(seen) == 2
    assert all(ident != loop_thread for ident in seen), "the EC adapter ran ON the event loop"








# ── The mirror: what EC cannot address keeps today's path ───────────────────





def test_a_padded_md4_hash_reaches_ec_in_its_32_char_form(monkeypatch):
    """40 chars with trailing zeros is the SAME MD4 `amu_ws_items` truncates;
    the EC seam must get the normalized 32-char hex (the client's `_hash16`
    accepts nothing else)."""
    calls: list = []

    with patch("copy_engine.amule_pause", _seam_recorder(calls)):
        result = asyncio.run(do_action(None, "pause", {"matched_hash": PADDED}))

    assert result == {"ok": True, "steps": [EC_OK]}
    assert calls == [("call", HASH, calls[0][2])]


# ── Failure shapes (consumed by sweep_downloads._first_detail) ──────────────


def test_sin_hash_is_refused_before_touching_aMule(monkeypatch):
    with patch("copy_engine.amule_pause", side_effect=AssertionError("nothing to address")):
        result = asyncio.run(do_action(None, "pause", {"matched_hash": ""}))

    assert result == {"ok": False, "steps": [SIN_HASH]}


def test_the_unconfigured_seam_refuses_with_the_shared_reason(monkeypatch):
    reason = service_unavailable_reason("amule", "amule")

    def boom(file_hash):
        raise RuntimeError(reason)

    with patch("copy_engine.amule_pause", boom):
        result = asyncio.run(do_action(None, "pause", {"matched_hash": HASH}))

    assert result == {"ok": False, "steps": [{"target": "amule", "ok": False, "detail": reason}]}
    assert _first_detail(result) == reason, "the sweep's failure-shape consumer must read it"


def test_an_ec_transport_error_is_classified_not_a_raw_traceback(monkeypatch):
    def boom(file_hash):
        raise AmuleECConnectionError("conexión EC con amuled caída")

    with patch("copy_engine.amule_resume", boom):
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

    with patch("copy_engine.amule_pause", boom):
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
            patch("copy_engine.amule_set_category", _set_recorder(calls)):
        result = asyncio.run(do_action(
            None, "fix_category", {"source": "radarr", "matched_hash": HASH},
        ))

    assert result == {"ok": True, "steps": [EC_OK]}
    assert [(c[0], c[1], c[2]) for c in calls] == [("set_category", HASH, 4)]


def test_fix_category_resolves_tv_sonarr_to_the_verified_index(monkeypatch):
    _arrless(monkeypatch)
    calls: list = []

    with patch("copy_engine.amule_categories", _cats_stub(CATEGORIES)), \
            patch("copy_engine.amule_set_category", _set_recorder(calls)):
        result = asyncio.run(do_action(
            None, "fix_category", {"source": "sonarr", "matched_hash": HASH},
        ))

    assert result == {"ok": True, "steps": [EC_OK]}
    assert [(c[0], c[1], c[2]) for c in calls] == [("set_category", HASH, 6)]


def test_fix_category_refuses_honestly_when_aMule_has_no_such_category(monkeypatch):
    _arrless(monkeypatch)

    with patch("copy_engine.amule_categories", _cats_stub({})), \
            patch("copy_engine.amule_set_category", side_effect=AssertionError("nothing to set")):
        result = asyncio.run(do_action(
            None, "fix_category", {"source": "radarr", "matched_hash": HASH},
        ))

    assert result == {
        "ok": False,
        "steps": [{"target": "amule", "ok": False, "detail": "la categoría «radarr» no existe en aMule"}],
    }





# ── delete: delete_files=True ⇒ disco (0x6A) sólo para completos; resto 0x1D ─


def test_delete_torrent_with_files_calls_the_ec_delete(monkeypatch):
    calls: list = []

    with patch("copy_engine.amule_delete", _del_recorder(calls)):
        result = asyncio.run(do_action(
            None, "delete_torrent", {"matched_hash": HASH, "delete_files": True},
        ))

    assert result == {"ok": True, "steps": [EC_OK]}
    assert [(c[0], c[1], c[2]) for c in calls] == [("delete", HASH, True)]


def test_delete_torrent_without_files_forwards_the_flag(monkeypatch):
    calls: list = []

    with patch("copy_engine.amule_delete", _del_recorder(calls)):
        result = asyncio.run(do_action(
            None, "delete_torrent", {"matched_hash": HASH, "delete_files": False},
        ))

    assert result == {"ok": True, "steps": [EC_OK]}
    assert [(c[0], c[1], c[2]) for c in calls] == [("delete", HASH, False)]


def test_cancel_download_deletes_with_files_over_ec(monkeypatch):
    calls: list = []

    with patch("copy_engine.amule_delete", _del_recorder(calls)):
        result = asyncio.run(do_action(
            None, "cancel_download", {"matched_hash": HASH, "ids": {}},
        ))

    assert result == {"ok": True, "steps": [EC_OK]}
    assert [(c[0], c[1], c[2]) for c in calls] == [("delete", HASH, True)]








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
            patch("copy_engine.amule_set_category", _note):
        asyncio.run(do_action(None, "delete_torrent", {"matched_hash": HASH, "delete_files": True}))
        asyncio.run(do_action(None, "fix_category", {"source": "radarr", "matched_hash": HASH}))

    assert len(seen) == 3
    assert all(ident != loop_thread for ident in seen), "the EC adapter ran ON the event loop"



# ── A hash EC cannot address is refused, never guessed ───────────────────────


@pytest.mark.parametrize("action,payload", [
    ("pause", {"matched_hash": SHA1}),
    ("delete_torrent", {"matched_hash": SHA1, "delete_files": True}),
])
def test_a_sha1_is_refused_because_ec_has_no_address_for_it(action, payload):
    with patch("copy_engine.amule_pause", side_effect=AssertionError("no EC address")), \
            patch("copy_engine.amule_delete", side_effect=AssertionError("no EC address")):
        result = asyncio.run(do_action(None, action, payload))

    assert result == {
        "ok": False,
        "steps": [{"target": "amule", "ok": False, "detail": "hash no direccionable en aMule"}],
    }
