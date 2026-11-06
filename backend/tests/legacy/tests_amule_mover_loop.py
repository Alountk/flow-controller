"""Feedback loop for "the aMule download never reaches the folder I chose".

The reported symptom, end to end through the REAL sweep: the real direct-trace
synthesis (`_direct_traces`), the real policy, the real payload the sweep
builds, and a dispatcher that runs the engine's actual file move on that
payload — the hardlink-first transfer the user sees as "mover". Red means the
file never lands at the destination, whatever the summary says.

Two destinations are exercised because both were reported: a foreign quality
folder (4K, outside every arr root) and the library folder Radarr controls
(1080, an arr root itself — not foreign, so the arr probe must speak).

Also the S3 regression home: the 30-min grace is for downloads the arr could
import on its own, so a DIRECT add (which it never saw) moves on the first sweep.
"""

import asyncio
import time
from datetime import datetime, timezone
from pathlib import Path

import auto_copy_driver as driver
from copy_engine import copy_files_to_root
from traces import _direct_traces

GRAB_AT = 10_000.0
MOVIE = "Dune.2024.2160p.UHD.BluRay.x265-GRP.mkv"


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _arr_trace(content: Path):
    """A trace the way the ARR reports it — the non-direct shape used across the
    policy/sweep suites — pointing at the real downloaded file."""
    return {
        "source": "radarr",
        "title": MOVIE,
        "download_id": "a" * 40,
        "date": _iso(GRAB_AT + 3),
        "stage": "downloaded",
        "ids": {"movie_id": 855, "episode_id": None, "series_id": None, "queue_id": 1},
        "torrent": {"content_path": str(content)},
        "queue": {"state": "importPending", "status": "ok"},
    }


def _fixtures(tmp_path: Path, *, direct=1):
    """One completed aMule download plus both reported destinations."""
    library = tmp_path / "library1080"      # la 1080: la raíz que controla Radarr
    quality_4k = tmp_path / "4K"             # fuera de toda raíz del arr
    amule_dir = tmp_path / "amule"
    for folder in (library, quality_4k, amule_dir):
        folder.mkdir()
    content = amule_dir / MOVIE
    content.write_bytes(b"0" * 4096)

    torrent = {
        "hash": "a" * 40,
        "name": MOVIE,
        "state": "completed",
        "progress": 1.0,
        "category": "flow",
        "save_path": str(amule_dir),
        "size": 4096,
    }
    grab = {
        "id": 1,
        "source": "radarr",
        "movie_id": 855,
        "episode_id": None,
        "series_id": None,
        "guid": "rel-1",
        "indexer_id": 1,
        "grabbed_at": GRAB_AT,
        "destination": None,       # set per scenario
        "quality": "Bluray-2160p",
        "direct": direct,
        "client_name": MOVIE,
        "client_hash": "a" * 40,
    }
    return grab, torrent, library, quality_4k, content


def _install(monkeypatch, *, grab, torrent, roots, seen=GRAB_AT, traces=None):
    """Stub only the I/O boundaries; the sweep and the mover stay real."""
    moved: list[tuple[str, str]] = []

    async def build_traces(session):
        if traces is not None:
            return list(traces)
        return _direct_traces([grab], [torrent])

    async def arr_probe(session, service, *, movie_id=None, episode_id=None):
        return False

    async def arr_roots(session, source):
        return list(roots)

    # The grace window is measured from the first sighting of this stage: a
    # number is the stored instant (ancient ⇒ the 30 min already elapsed),
    # `None` returns "now" — a sighting so fresh the grace would still apply.
    monkeypatch.setattr(
        driver,
        "note_auto_copy_seen",
        lambda *a, **k: time.time() if seen is None else seen,
        raising=False,
    )

    async def do_action(session, action, payload):
        assert action == "copy_files"
        dst_root = payload.get("dest_root") or str(roots[0])
        result = copy_files_to_root(
            payload["output_path"], dst_root, is_host_path=True
        )
        moved.append((payload["output_path"], dst_root))
        return {**result, "task_id": "t1", "dst_path": dst_root}

    monkeypatch.setattr(driver, "build_traces", build_traces)
    monkeypatch.setattr(driver, "list_own_grabs", lambda *a, **k: [grab])
    monkeypatch.setattr(driver, "arr_has_file", arr_probe)
    monkeypatch.setattr(driver, "do_action", do_action)
    monkeypatch.setattr(driver, "_arr_roots", arr_roots, raising=False)
    return moved


def _sweep(**kwargs):
    return asyncio.run(driver.sweep(None, **kwargs))


def _assert_moved(summary, destination: Path, moved):
    entry = summary["entries"][0]
    assert entry["action"] == "copied", f"no se movió: {entry}"
    assert (destination / MOVIE).is_file(), f"el fichero no llegó a {destination}"
    assert moved and moved[0][1] == str(destination)


def test_completed_amule_download_reaches_the_chosen_quality_folder(
    monkeypatch, tmp_path
):
    grab, torrent, library, quality_4k, _ = _fixtures(tmp_path)
    grab["destination"] = str(quality_4k)
    moved = _install(monkeypatch, grab=grab, torrent=torrent, roots=[str(library)])

    summary = _sweep(safe_mode=False)

    _assert_moved(summary, quality_4k, moved)


def test_completed_amule_download_reaches_the_library_folder_radarr_controls(
    monkeypatch, tmp_path
):
    grab, torrent, library, _, _ = _fixtures(tmp_path)
    grab["destination"] = str(library)
    moved = _install(monkeypatch, grab=grab, torrent=torrent, roots=[str(library)])

    summary = _sweep(safe_mode=False)

    _assert_moved(summary, library, moved)


def test_a_direct_download_is_moved_by_the_first_available_sweep(monkeypatch, tmp_path):
    """S3: a DIRECT add is one the arr never saw — «el arr puede importarlo
    solo» is a lie there, so no grace applies and the first sweep moves it."""
    grab, torrent, library, quality_4k, _ = _fixtures(tmp_path)
    grab["destination"] = str(quality_4k)
    # `seen=None` is a sighting of "now": the grace WOULD apply today.
    moved = _install(
        monkeypatch, grab=grab, torrent=torrent, roots=[str(library)], seen=None
    )

    summary = _sweep(safe_mode=False)

    _assert_moved(summary, quality_4k, moved)


def test_a_sweep_after_the_grace_window_moves_the_file(monkeypatch, tmp_path):
    """The grace survives where it is honest: a NON-direct trace the arr could
    import on its own waits inside the window, and moves once it elapsed."""
    grab, torrent, library, quality_4k, content = _fixtures(tmp_path, direct=0)
    grab["destination"] = str(quality_4k)
    t0 = 1_700_000_000.0
    moved = _install(
        monkeypatch,
        grab=grab,
        torrent=torrent,
        roots=[str(library)],
        seen=t0,
        traces=[_arr_trace(content)],
    )

    first = _sweep(safe_mode=False, now=t0 + 60)        # 1 min: aún en gracia
    second = _sweep(safe_mode=False, now=t0 + 31 * 60)   # 31 min: fuera

    assert first["entries"][0]["decision"] == "wait"
    assert "gracia" in first["entries"][0]["reason"]
    _assert_moved(second, quality_4k, moved)
