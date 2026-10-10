"""The downloads snapshot behind `/api/downloads` (F-06(e)).

Radarr and Sonarr know what the *arr* is tracking (state, import status, size
left). aMuTorrent knows how the download is actually going (speed, ETA,
seeds). Neither alone answers "where is this download", so the two are joined
by ``downloadId`` <-> ``hash`` using the same normalization the trace view
uses.

Failures are reported per source. A download client that cannot be reached
must never look like "no downloads".

Why this module exists: `/api/downloads` was the only one of the three
pollers with no cache at all — four upstream calls per request, 60/min per
open tab against three LAN services that do not change that fast
(`f06-amule-local.md` §1). The chosen option is the local mirror (e): ONE
background poller refreshes this snapshot every `DOWNLOADS_TTL` and every
reader is served from memory — the `background_checker` loop pattern with
the `_trace_cache` TTL discipline. Cost then scales with the window, never
with how many tabs are open.

Failure semantics — stale-last, the `status_cache` precedent: a failed
refresh keeps serving the last good snapshot with its frozen `updated_at`
(an unreachable service must not empty the screen), and the poller absorbs
the error, sleeps, and retries on the next tick. Only a failure BEFORE any
snapshot exists propagates: with nothing to serve, the reader sees the error
rather than a fabricated "no downloads".

What (e) deliberately does NOT do: decide where the downloaded file lands —
that needs option (a) or (b), and (b) waits on the GPL question (study §5).
"""

from __future__ import annotations

import asyncio
import time

from application.gateways import (
    arr_categories_for,
    amu_torrent_categories,
    fetch_amu_torrents_by_category,
    fetch_arr_queue,
)
from config import configured_services
from traces import normalize_hash
from state import http_session

#: Seconds a snapshot stays good for. The study proposes ~3 s
#: (`f06-amule-local.md:103`, repeated by flecos T7): below the 4 s an active
#: tab used to poll, tight enough that the screen barely notices the window.
DOWNLOADS_TTL = 3.0

#: `(fetched_at, snapshot)`. Module state on purpose: the window is shared by
#: every reader AND by the poller — that sharing is the whole saving. No
#: lock: a lost race builds the same snapshot twice, never a wrong one.
_downloads_cache: tuple[float, dict] | None = None

# States worth shouting about: the download is done or stuck and the import
# did not complete. Surfacing these is the point of this app.
PROBLEM_STATES = {"importBlocked", "failed", "downloadFailed"}
WARNING_STATUSES = {"warning", "error"}


def _progress_percent(queue_item: dict, torrent: dict | None) -> float:
    """Prefer the download client's own progress; fall back to arr bookkeeping."""
    if torrent and isinstance(torrent.get("progress"), (int, float)):
        return round(torrent["progress"] * 100, 1)

    size = queue_item.get("size") or 0
    sizeleft = queue_item.get("sizeleft") or 0
    if size > 0:
        return round(max(0.0, (size - sizeleft) / size) * 100, 1)
    return 0.0


def _build_download(service_key: str, queue_item: dict, torrent: dict | None) -> dict:
    state = queue_item.get("trackedDownloadState") or ""
    status = queue_item.get("trackedDownloadStatus") or ""

    messages: list[str] = []
    for entry in queue_item.get("statusMessages") or []:
        messages.extend(entry.get("messages") or [])

    return {
        "id": str(queue_item.get("id", "")),
        "source": service_key,
        "title": queue_item.get("title", ""),
        "status": queue_item.get("status", ""),
        "tracked_state": state,
        "tracked_status": status,
        "problem": state in PROBLEM_STATES or status in WARNING_STATUSES,
        "messages": messages,
        "progress": _progress_percent(queue_item, torrent),
        "size": queue_item.get("size") or 0,
        "sizeleft": queue_item.get("sizeleft") or 0,
        "timeleft": queue_item.get("timeleft") or "",
        "download_client": queue_item.get("downloadClient") or "",
        "indexer": queue_item.get("indexer") or "",
        # Only the download client knows these; absent when the join failed.
        "matched": torrent is not None,
        "speed": torrent.get("dlspeed") if torrent else None,
        "eta_seconds": torrent.get("eta") if torrent else None,
        "seeders": torrent.get("num_seeds") if torrent else None,
        "leechers": torrent.get("num_leechs") if torrent else None,
        "torrent_state": torrent.get("state") if torrent else None,
    }


async def collect_downloads() -> dict:
    """Every active download across the arr services, with per-source failures."""
    arr_services = configured_services("arr")
    errors: list[dict] = []

    async with http_session() as session:
        queues = await asyncio.gather(
            *(fetch_arr_queue(session, service) for service in arr_services)
        )

        queue_items: list[tuple[str, dict]] = []
        for service, result in zip(arr_services, queues):
            queue_items.extend((service["key"], item) for item in result)

        # Nothing downloading means nothing to ask the download client: idle
        # cost is zero, and the unfiltered endpoint is ~1 MB.
        if not queue_items:
            return {"downloads": [], "errors": errors, "updated_at": int(time.time())}

        available = await amu_torrent_categories(session)
        categories: list[str] = []
        for service in arr_services:
            categories.extend(arr_categories_for(service["key"], available))

        torrents, failure = await fetch_amu_torrents_by_category(session, categories)
        if failure:
            errors.append({"source": "amutorrent", **failure})

        torrents_by_hash = {
            normalize_hash(t.get("hash", "")): t for t in torrents if t.get("hash")
        }

    downloads = []
    for service_key, item in queue_items:
        torrent = torrents_by_hash.get(normalize_hash(item.get("downloadId", "")))
        downloads.append(_build_download(service_key, item, torrent))

    # Problems first, then the most advanced downloads.
    downloads.sort(key=lambda d: (not d["problem"], -d["progress"]))

    return {"downloads": downloads, "errors": errors, "updated_at": int(time.time())}


async def get_downloads() -> dict:
    """The snapshot, refreshed at most once per `DOWNLOADS_TTL`.

    Reads inside the window are memory: the arr fan-out happens once per
    window no matter how many readers arrive in it. A stale or missing
    snapshot triggers one refresh shared with whoever else is racing in
    (same rule as `_trace_cache`: a lost race builds the snapshot twice, it
    never builds it wrong). On a failed refresh the last snapshot keeps
    serving; with no snapshot at all the failure propagates instead of
    inventing "no downloads".
    """
    global _downloads_cache
    cached = _downloads_cache
    if cached and time.time() - cached[0] < DOWNLOADS_TTL:
        return cached[1]
    try:
        snapshot = await collect_downloads()
    except Exception:
        if cached is None:
            raise
        return cached[1]
    _downloads_cache = (time.time(), snapshot)
    return snapshot


async def downloads_poller() -> None:
    """Refresh the snapshot every `DOWNLOADS_TTL` until cancelled.

    Started once, from the lifespan — the `background_checker` pattern: a
    reader must not find a cold cache because nobody had asked yet. A failed
    tick is absorbed and retried on the next one, exactly like
    `background_checker`: a poller that dies on the first error would freeze
    every reader on whatever was last collected, silently.
    """
    while True:
        try:
            await get_downloads()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — a failed tick must not kill the loop
            pass  # the last snapshot (if any) keeps serving; next tick retries
        await asyncio.sleep(DOWNLOADS_TTL)
