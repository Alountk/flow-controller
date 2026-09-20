"""Shared post-move import service for Radarr/Sonarr.

Centralizes the logic for triggering imports after file moves:
- Radarr: manual import + rescan + refresh, or DownloadedMoviesScan
- Sonarr: rescan + refresh, or DownloadedEpisodesScan
"""

import logging
from pathlib import Path

import aiohttp

from clients import (
    arr_manual_import,
    arr_rescan_movie,
    arr_refresh_movie,
    arr_rescan_series,
    arr_refresh_series,
    arr_downloaded_scan,
    arr_downloaded_episodes_scan,
)

log = logging.getLogger("flow-controller")


async def post_move_import(
    session: aiohttp.ClientSession,
    service: dict,
    dst: str,
    movie_id: int | None = None,
    series_id: int | None = None,
) -> dict:
    """Trigger post-move import for Radarr or Sonarr.

    Returns:
        {"ok": bool, "imported": bool, "detail": str}
    """
    imported = False
    detail = ""

    try:
        if service["key"] == "radarr":
            imported, detail = await _import_radarr(session, service, dst, movie_id)
        elif service["key"] == "sonarr":
            imported, detail = await _import_sonarr(session, service, dst, series_id)
        else:
            detail = f"unknown service: {service['key']}"
    except Exception as exc:
        log.error("Post-move import failed for %s: %s", service["key"], exc)
        return {"ok": False, "imported": False, "detail": f"{type(exc).__name__}: {exc}"}

    return {"ok": True, "imported": imported, "detail": detail}


async def _import_radarr(
    session: aiohttp.ClientSession,
    service: dict,
    dst: str,
    movie_id: int | None,
) -> tuple[bool, str]:
    """Import logic for Radarr."""
    imported = False

    if movie_id:
        log.info("Trying Radarr manual import: dst=%s movie_id=%s", dst, movie_id)
        res_manual = await arr_manual_import(session, service, dst, movie_id)
        log.info("Radarr manual import result: %s", res_manual)
        if res_manual.get("ok"):
            imported = True

        log.info("Triggering RescanMovie + RefreshMovie: movie_id=%s", movie_id)
        res_rescan = await arr_rescan_movie(session, service, movie_id)
        res_refresh = await arr_refresh_movie(session, service, movie_id)
        log.info("Radarr Rescan/Refresh result: rescan=%s refresh=%s", res_rescan, res_refresh)
        if res_rescan.get("ok") or res_refresh.get("ok"):
            imported = True
    else:
        parent_dir = str(Path(dst).parent)
        log.info("Triggering DownloadedMoviesScan: path=%s", parent_dir)
        res_scan = await arr_downloaded_scan(session, service, parent_dir)
        log.info("Radarr DownloadedMoviesScan result: %s", res_scan)
        if res_scan.get("ok"):
            imported = True

    detail = "importado" if imported else "import pendiente"
    return imported, detail


async def _import_sonarr(
    session: aiohttp.ClientSession,
    service: dict,
    dst: str,
    series_id: int | None,
) -> tuple[bool, str]:
    """Import logic for Sonarr."""
    imported = False

    if series_id:
        log.info("Triggering Sonarr RescanSeries + RefreshSeries: series_id=%s", series_id)
        res_rescan = await arr_rescan_series(session, service, series_id)
        res_refresh = await arr_refresh_series(session, service, series_id)
        log.info("Sonarr Rescan/Refresh result: rescan=%s refresh=%s", res_rescan, res_refresh)
        if res_rescan.get("ok") or res_refresh.get("ok"):
            imported = True
    else:
        parent_dir = str(Path(dst).parent)
        log.info("Triggering DownloadedEpisodesScan: path=%s", parent_dir)
        res_scan = await arr_downloaded_episodes_scan(session, service, parent_dir)
        log.info("Sonarr DownloadedEpisodesScan result: %s", res_scan)
        if res_scan.get("ok"):
            imported = True

    detail = "importado" if imported else "import pendiente"
    return imported, detail
