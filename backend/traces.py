import config
import asyncio
import logging
import time

import aiohttp

from application.use_cases.sweep_downloads import OWN_GRAB_LOOKBACK_SECONDS
from infrastructure.sqlite_history import list_own_grabs

from config import (
    EXPECTED_CATEGORY,
    PAUSED_STATES,
    configured_services,
    _DOWNLOAD_CLIENT_PATHS,
    host_path,  # lives in config now (next to _VOLUME_MAP); re-exported here
)
from infrastructure.arr_client import (
    arr_download_clients,
    fetch_arr_all_movies,
    fetch_arr_all_series,
    fetch_arr_grabbed,
    fetch_arr_queue,
    fetch_qbit_torrents,
)

log = logging.getLogger("flow-controller")


def resolve_current_path(save_path: str, download_client: str | None) -> str:
    if save_path:
        if download_client:
            client_lower = download_client.lower()
            for key, host_folder in _DOWNLOAD_CLIENT_PATHS.items():
                if key in client_lower:
                    log.info("resolve_path: client='%s' match='%s' → %s", download_client, key, host_folder)
                    return host_folder
        if save_path.startswith("/downloads/incoming"):
            log.info("resolve_path: pattern match '/downloads/incoming' → %s", config.FOLDER_DOWNLOAD_AMULE)
            return config.FOLDER_DOWNLOAD_AMULE
        if save_path.startswith("/downloads"):
            log.info("resolve_path: pattern match '/downloads' → %s", config.FOLDER_DOWNLOAD_TORRENT)
            return config.FOLDER_DOWNLOAD_TORRENT
    result = host_path(save_path) if save_path else ""
    log.info("resolve_path: fallback '%s' → '%s'", save_path, result)
    return result


def dc_host_map(clients: list[dict]) -> dict[str, str]:
    result: dict[str, str] = {}
    for dc in clients:
        name = dc.get("name", "")
        fields = {f["name"]: f.get("value") for f in dc.get("fields", []) if isinstance(f, dict)}
        host = fields.get("host")
        if name and host:
            result[name] = str(host)
    return result


def normalize_hash(value: str) -> str:
    return (value or "").strip().lower()


def hash_matches(download_id: str, amu_hashes: set[str]) -> str | None:
    did = normalize_hash(download_id)
    if not did:
        return None
    if did in amu_hashes:
        return did
    core = did.rstrip("0")
    if core and core in amu_hashes:
        return core
    for h in amu_hashes:
        if h.startswith(core) or did.startswith(h):
            return h
    return None


def derive_stage(torrent: dict | None, queue_item: dict | None) -> str:
    if queue_item:
        state = queue_item.get("trackedDownloadState")
        status = queue_item.get("trackedDownloadStatus")
        if state == "importPending" or status == "warning":
            return "import_blocked"
        if state == "importing":
            return "importing"
        if state in ("failed", "downloadFailed"):
            return "failed"
    if torrent is None:
        return "sent"
    if torrent.get("state") == "error":
        return "failed"
    if torrent.get("progress", 0) >= 1:
        return "downloaded"
    return "downloading"


def _torrent_view(torrent: dict, download_client: str | None = None) -> dict:
    """The trace's `torrent` view of one client torrent.

    One mapping, two callers: the arr-joined trace (the client name comes from
    its queue item) and the direct-add trace (B-10 — no queue, no name). The
    paths resolve the same way in both: `resolve_current_path` owns the
    container→host mapping either way.
    """
    save_path = torrent.get("save_path")
    name = torrent.get("name")
    resolved = resolve_current_path(save_path, download_client) if save_path else None
    return {
        "state": torrent.get("state"),
        "progress": round(torrent.get("progress", 0) * 100, 1),
        "category": torrent.get("category"),
        "save_path": save_path,
        "current_path": resolved,
        "content_path": (resolved + "/" + name) if resolved and name else None,
        "size": torrent.get("size"),
    }


def _direct_traces(own_grabs: list[dict], torrents: list[dict]) -> list[dict]:
    """Trace rows for downloads this app added straight to the client (B-10).

    The arr was never told about them, so its history will never carry them —
    without this the download would be invisible HERE and to the sweep: no
    trace, no decision, no copy to the destination the operator chose.

    The join is the exact identity recorded at add time (the client's name;
    the hash when the link carried one) — never fuzzy: an unmatched grab
    produces NO row rather than a wrong one, and the operator sees an absent
    download, not a mislabelled one.
    """
    if not own_grabs or not torrents:
        return []
    by_hash = {(t.get("hash") or "").lower(): t for t in torrents if t.get("hash")}
    by_name = {t.get("name"): t for t in torrents if t.get("name")}
    rows: list[dict] = []
    for grab in own_grabs:
        if not grab.get("direct"):
            continue
        torrent = None
        if grab.get("client_hash"):
            torrent = by_hash.get(str(grab["client_hash"]).lower())
        if torrent is None and grab.get("client_name"):
            torrent = by_name.get(grab["client_name"])
        if torrent is None:
            # The client does not know this download (never started, already
            # removed): no row and no guess.
            continue
        grabbed_at = grab.get("grabbed_at") or time.time()
        rows.append({
            "source": grab.get("source") or "",
            "title": torrent.get("name") or grab.get("client_name") or "",
            "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(grabbed_at)),
            "indexer": None,
            "download_client": None,
            "download_client_host": None,
            "download_id": torrent.get("hash") or "",
            "matched_hash": torrent.get("hash") or "",
            "stage": derive_stage(torrent, None),
            "torrent": _torrent_view(torrent),
            # OUR category, not an arr expectation: an unknown answer — the
            # "Cat. incorrecta" chip would be a lie on a download the arr
            # has never seen.
            "expected_category": None,
            "category_ok": None,
            "paused": torrent.get("state") in PAUSED_STATES,
            "ids": {
                "queue_id": None,
                "episode_id": grab.get("episode_id"),
                "movie_id": grab.get("movie_id"),
                "series_id": grab.get("series_id"),
            },
            # OUR destination, the whole point of the direct grab — never the
            # arr-derived library path.
            "destination": grab.get("destination"),
            "queue": None,
        })
    return rows


async def build_traces(session: aiohttp.ClientSession) -> list[dict]:
    arr_services = configured_services("arr")

    results = await asyncio.gather(
        *(fetch_arr_grabbed(session, s, config.TRACE_LIMIT) for s in arr_services),
        *(fetch_arr_queue(session, s) for s in arr_services),
        *(arr_download_clients(session, s) for s in arr_services),
        *(fetch_arr_all_series(session, s) for s in arr_services if s["key"] == "sonarr"),
        *(fetch_arr_all_movies(session, s) for s in arr_services if s["key"] == "radarr"),
    )
    n = len(arr_services)
    grabs_by_service = dict(zip((s["key"] for s in arr_services), results[:n]))
    queues_by_service = dict(zip((s["key"] for s in arr_services), results[n:2*n]))
    dc_by_service = dict(zip((s["key"] for s in arr_services), results[2*n:3*n]))
    dc_hosts = {k: dc_host_map(v) for k, v in dc_by_service.items()}

    paths_by_id: dict[str, dict[int, str]] = {}
    idx = 3 * n
    for s in arr_services:
        if s["key"] == "sonarr":
            paths_by_id["sonarr"] = results[idx] if idx < len(results) else {}
            idx += 1
    for s in arr_services:
        if s["key"] == "radarr":
            paths_by_id["radarr"] = results[idx] if idx < len(results) else {}
            idx += 1

    torrents = await fetch_qbit_torrents(session)
    amu_hashes = {normalize_hash(t.get("hash", "")) for t in torrents}
    torrents_by_hash = {normalize_hash(t.get("hash", "")): t for t in torrents}

    traces: list[dict] = []
    for service in arr_services:
        key = service["key"]
        queue_by_download = {}
        for item in queues_by_service.get(key, []):
            did = normalize_hash(item.get("downloadId", ""))
            if did:
                queue_by_download[did] = item

        for record in grabs_by_service.get(key, []):
            data = record.get("data") or {}
            download_id = record.get("downloadId", "")
            norm = normalize_hash(download_id)
            matched = hash_matches(download_id, amu_hashes)
            torrent = torrents_by_hash.get(matched) if matched else None
            queue_item = queue_by_download.get(norm) or (
                queue_by_download.get(normalize_hash(matched)) if matched else None
            )

            expected_cat = EXPECTED_CATEGORY.get(key)
            actual_cat = torrent.get("category") if torrent else None
            category_ok = (
                actual_cat == expected_cat if actual_cat is not None else None
            )

            messages: list[str] = []
            if queue_item:
                for sm in queue_item.get("statusMessages", []):
                    messages.extend(sm.get("messages", []))

            traces.append(
                {
                    "source": key,
                    "title": record.get("sourceTitle") or record.get("title") or "",
                    "date": record.get("date"),
                    "indexer": data.get("indexer"),
                    "download_client": queue_item.get("downloadClient") if queue_item else None,
                    "download_client_host": dc_hosts.get(key, {}).get(
                        queue_item.get("downloadClient", "") if queue_item else "", ""
                    ),
                    "download_id": download_id,
                    "matched_hash": matched,
                    "stage": derive_stage(torrent, queue_item),
                    "torrent": _torrent_view(
                        torrent,
                        queue_item.get("downloadClient") if queue_item else None,
                    ) if torrent else None,
                    "expected_category": expected_cat,
                    "category_ok": category_ok,
                    "paused": bool(
                        torrent and torrent.get("state") in PAUSED_STATES
                    ),
                    "ids": {
                        "queue_id": queue_item.get("id") if queue_item else None,
                        "episode_id": record.get("episodeId"),
                        "movie_id": record.get("movieId"),
                        "series_id": record.get("seriesId"),
                    },
                    "destination": (
                        paths_by_id.get(key, {}).get(record.get("seriesId"))
                        if key == "sonarr"
                        else paths_by_id.get(key, {}).get(record.get("movieId"))
                        if key == "radarr"
                        else None
                    ),
                    "queue": {
                        "state": queue_item.get("trackedDownloadState"),
                        "status": queue_item.get("trackedDownloadStatus"),
                        "output_path": queue_item.get("outputPath"),
                        "messages": messages,
                    } if queue_item else None,
                }
            )

    # Direct adds (B-10): the arr was never told, so its history will never
    # carry them — without these rows the operator's chosen destination would
    # never be reached (no trace, no sweep decision, no copy). Best-effort:
    # an unreadable registry degrades to "nothing provably ours", the same
    # answer the sweep treats as "act on nothing".
    try:
        own_grabs = await asyncio.to_thread(
            list_own_grabs, time.time() - OWN_GRAB_LOOKBACK_SECONDS
        )
    except Exception as exc:  # noqa: BLE001 — one bad read, not a dead poll
        log.warning("direct traces: own_grabs no disponibles: %s", exc)
        own_grabs = []
    traces.extend(_direct_traces(own_grabs, torrents))

    traces.sort(key=lambda t: t.get("date") or "", reverse=True)
    return traces
