"""Active downloads, joined across Radarr/Sonarr and the download client.

Radarr and Sonarr know what the *arr* is tracking (state, import status, size
left). aMuTorrent knows how the download is actually going (speed, ETA, seeds).
Neither alone answers "where is this download", so the two are joined by
``downloadId`` <-> ``hash`` using the same normalization the trace view uses.

Failures are reported per source. A download client that cannot be reached must
never look like "no downloads".
"""

import asyncio
import time

import aiohttp
from fastapi import APIRouter

from clients import (
    arr_categories_for,
    amu_torrent_categories,
    fetch_amu_torrents_by_category,
    fetch_arr_queue,
)
from config import SERVICES
from traces import normalize_hash

router = APIRouter()

# States worth shouting about: the download is done or stuck and the import did
# not complete. Surfacing these is the point of this app.
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
    arr_services = [s for s in SERVICES if s["kind"] == "arr"]
    errors: list[dict] = []

    async with aiohttp.ClientSession() as session:
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


@router.get("/api/downloads")
async def get_downloads():
    """Descargas activas, con progreso unido desde el cliente de descargas."""
    return await collect_downloads()
