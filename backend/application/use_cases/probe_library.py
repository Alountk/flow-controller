"""Library-wide ffprobe sweep («ffprobe-masivo» T3/S3).

Walks the movie and routing folders, probes only what the cache does not
already answer, and reports progress. One run at a time: the sweep is a
30 s-subprocess fan-out, and two of them would fight for the same disk.
"""

import asyncio
import logging
import os

import config
import media_mixer
from application.gateways import fetch_all_movies_detailed, history
from state import http_session

log = logging.getLogger("flow-controller")

#: What ffprobe can actually read. A `.srt` or a poster in the same folder
#: proves nothing and would only burn subprocesses.
VIDEO_EXTENSIONS = frozenset({
    ".mkv", ".mp4", ".m4v", ".avi", ".mov", ".ts", ".m2ts", ".mpg",
    ".mpeg", ".webm", ".wmv", ".iso",
})

#: ffprobe spawns a process and reads the whole header: four at a time is
#: enough to keep a spinner alive without starving the request loop.
MAX_CONCURRENT_PROBES = 4

_EMPTY_STATUS = {
    "running": False,
    "total": 0,
    "analyzed": 0,
    "skipped": 0,
    "failed": 0,
    "started_at": 0.0,
    "finished_at": 0.0,
}

_active = False
_task: asyncio.Task | None = None
_status: dict = dict(_EMPTY_STATUS)
_status_lock = asyncio.Lock()


def status() -> dict:
    """A copy of the current job status — callers never mutate ours.

    `running` ORs with the single-flight gate: the gate is the truth, so a
    sweep that was admitted but has not ticked yet still reads as running.
    """
    snapshot = dict(_status)
    snapshot["running"] = bool(_status["running"] or _active)
    return snapshot


def collect_files(folders: list[str]) -> list[str]:
    """Every video file under `folders`, deduped and sorted.

    Empty and missing folders contribute nothing: an unconfigured routing
    folder means "not configured", never "everything".
    """
    found: set[str] = set()
    for folder in folders:
        if not folder or not os.path.isdir(folder):
            continue
        for root, _dirs, files in os.walk(folder):
            for name in files:
                if os.path.splitext(name)[1].lower() in VIDEO_EXTENSIONS:
                    found.add(os.path.realpath(os.path.join(root, name)))
    return sorted(found)


async def collect_universe() -> list[str]:
    """The whole file universe: Radarr's movie folders + the routing folders."""
    folders: list[str] = []
    service = config.find_service("radarr", "arr")
    if service:
        try:
            async with http_session() as session:
                result = await fetch_all_movies_detailed(session, service, 1, 0)
            folders = [m.get("path") or "" for m in result.get("items", [])]
        except Exception as exc:  # a broken arr must not stop the routing folders
            log.warning("probe-library: could not list movies: %s", exc)
    folders.extend([config.PATH_4K, config.PATH_3D])
    return await asyncio.to_thread(collect_files, folders)


async def run(paths: list[str], probe=None, cache_get=None, cache_save=None) -> dict:
    """Sweep `paths`: skip what the cache answers, probe and persist the rest."""
    probe = probe or media_mixer.probe_file
    cache_get = cache_get or history.get_probe_result
    cache_save = cache_save or history.save_probe_result

    _status.update(
        running=True, total=len(paths), analyzed=0, skipped=0, failed=0,
        started_at=_now(), finished_at=0.0,
    )
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_PROBES)

    async def one(path: str) -> None:
        async with semaphore:
            try:
                cached = await asyncio.to_thread(cache_get, path)
            except Exception:
                cached = None
            if cached is not None:
                await _bump("skipped")
                return
            try:
                data = await asyncio.to_thread(probe, path)
            except Exception as exc:  # one bad file never aborts the sweep
                log.debug("probe-library: %s failed: %s", path, exc)
                await _bump("failed")
                return
            try:
                await asyncio.to_thread(cache_save, path, data)
            except Exception as exc:
                log.warning("probe-library: could not persist %s: %s", path, exc)
            await _bump("analyzed")

    await asyncio.gather(*(one(p) for p in paths))
    _status.update(running=False, finished_at=_now())
    return status()


async def _bump(key: str) -> None:
    async with _status_lock:
        _status[key] += 1


def _now() -> float:
    import time

    return time.time()


def start(paths: list[str]) -> bool:
    """Begin a sweep; False when one is already running (the 409 case)."""
    global _active, _task
    if _active:
        return False
    _active = True
    _status.update(running=True)
    # Hold a reference on purpose: an unreferenced task may be collected
    # mid-execution, silently abandoning the sweep.
    _task = asyncio.create_task(_run_and_release(paths))
    return True


async def _run_and_release(paths: list[str]) -> None:
    global _active
    try:
        await run(paths)
    finally:
        _active = False
