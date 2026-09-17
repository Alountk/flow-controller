import asyncio
import logging
import os
import time

import aiohttp

from config import (
    EXPECTED_CATEGORY,
    FOLDER_DOWNLOAD_AMULE,
    FOLDER_DOWNLOAD_TORRENT,
    PAUSED_STATES,
    REQUEST_TIMEOUT,
    SERVICES,
    TRACE_LIMIT,
    _DOWNLOAD_CLIENT_PATHS,
    _VOLUME_MAP,
)
from clients import (
    arr_download_clients,
    fetch_arr_all_movies,
    fetch_arr_all_series,
    fetch_arr_grabbed,
    fetch_arr_queue,
    fetch_qbit_torrents,
)

log = logging.getLogger("flow-controller")


def host_path(container_path: str) -> str:
    for prefix, replacement in _VOLUME_MAP:
        if container_path.startswith(prefix):
            return replacement + container_path[len(prefix):]
    return container_path


def resolve_current_path(save_path: str, download_client: str | None) -> str:
    if save_path:
        if download_client:
            client_lower = download_client.lower()
            for key, host_folder in _DOWNLOAD_CLIENT_PATHS.items():
                if key in client_lower:
                    log.info("resolve_path: client='%s' match='%s' → %s", download_client, key, host_folder)
                    return host_folder
        if save_path.startswith("/downloads/incoming"):
            log.info("resolve_path: pattern match '/downloads/incoming' → %s", FOLDER_DOWNLOAD_AMULE)
            return FOLDER_DOWNLOAD_AMULE
        if save_path.startswith("/downloads"):
            log.info("resolve_path: pattern match '/downloads' → %s", FOLDER_DOWNLOAD_TORRENT)
            return FOLDER_DOWNLOAD_TORRENT
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


def derive_stage(grabbed: dict, torrent: dict | None, queue_item: dict | None) -> str:
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


async def build_traces(session: aiohttp.ClientSession) -> list[dict]:
    arr_services = [s for s in SERVICES if s["kind"] == "arr"]

    results = await asyncio.gather(
        *(fetch_arr_grabbed(session, s, TRACE_LIMIT) for s in arr_services),
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
                    "stage": derive_stage(record, torrent, queue_item),
                    "torrent": {
                        "state": torrent.get("state"),
                        "progress": round(torrent.get("progress", 0) * 100, 1),
                        "category": actual_cat,
                        "save_path": torrent.get("save_path"),
                        "current_path": resolve_current_path(
                            torrent.get("save_path", ""),
                            queue_item.get("downloadClient") if queue_item else None,
                        ) if torrent.get("save_path") else None,
                        "content_path": (
                            resolve_current_path(
                                torrent.get("save_path", ""),
                                queue_item.get("downloadClient") if queue_item else None,
                            ) + "/" + torrent.get("name", "")
                        ) if torrent.get("save_path") and torrent.get("name") else None,
                        "size": torrent.get("size"),
                    } if torrent else None,
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

    traces.sort(key=lambda t: t.get("date") or "", reverse=True)
    return traces
