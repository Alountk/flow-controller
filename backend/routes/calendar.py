"""Calendar routes — upcoming episodes and movies."""

import asyncio
import logging
from datetime import date, timedelta

import aiohttp
from fastapi import APIRouter, Depends

from config import SERVICES
from clients import (
    fetch_radarr_calendar,
    fetch_sonarr_calendar,
    arr_search_movie,
    arr_search_episode,
    arr_add_movie,
    arr_add_series,
    arr_fetch_releases,
    arr_grab_release,
    arr_indexers,
    arr_root_folders,
    arr_movie_lookup,
    arr_series_lookup,
    arr_movie_exists,
    arr_series_exists,
)
from models import (
    CalendarSearchRequest,
    CalendarAddRequest,
    CalendarReleasesRequest,
    CalendarGrabRequest,
    CalendarGrabBatchRequest,
)
from routes.status import verify_api_key

log = logging.getLogger("flow-controller")
router = APIRouter()


@router.get("/api/calendar")
async def get_calendar(start: str = "", end: str = ""):
    """Calendario de próximos episodios y películas."""
    if not start:
        start = date.today().isoformat()
    if not end:
        end = (date.today() + timedelta(days=30)).isoformat()

    radarr = next((s for s in SERVICES if s["key"] == "radarr" and s["kind"] == "arr"), None)
    sonarr = next((s for s in SERVICES if s["key"] == "sonarr" and s["kind"] == "arr"), None)

    all_items = []
    async with aiohttp.ClientSession() as session:
        tasks = []
        if radarr:
            tasks.append(fetch_radarr_calendar(session, radarr, start, end))
        if sonarr:
            tasks.append(fetch_sonarr_calendar(session, sonarr, start, end))
        if tasks:
            results = await asyncio.gather(*tasks)
            for r in results:
                all_items.extend(r)

    all_items.sort(key=lambda x: x.get("date") or "9999")
    return {"items": all_items, "start": start, "end": end}


@router.post("/api/calendar/search")
async def calendar_search(req: CalendarSearchRequest, _key: str = Depends(verify_api_key)):
    """Busca contenido en los indexadores de Radarr/Sonarr."""
    service = next((s for s in SERVICES if s["key"] == req.source and s["kind"] == "arr"), None)
    if not service:
        return {"ok": False, "detail": f"Servicio desconocido: {req.source}"}

    async with aiohttp.ClientSession() as session:
        if req.type == "movie":
            result = await arr_search_movie(session, service, req.id)
        elif req.type == "episode":
            result = await arr_search_episode(session, service, req.id)
        else:
            return {"ok": False, "detail": f"Tipo desconocido: {req.type}"}

    return {"ok": result.get("ok", False), "detail": result.get("detail", "")}


@router.post("/api/calendar/add")
async def calendar_add(req: CalendarAddRequest, _key: str = Depends(verify_api_key)):
    """Agrega una película/serie a Radarr/Sonarr y lanza búsqueda."""
    service = next((s for s in SERVICES if s["key"] == req.source and s["kind"] == "arr"), None)
    if not service:
        return {"ok": False, "id": None, "detail": f"Servicio desconocido: {req.source}"}

    try:
        async with aiohttp.ClientSession() as session:
            root_folders = await arr_root_folders(session, service)
            root_path = root_folders[0] if root_folders else ""

            if not root_path:
                return {"ok": False, "id": None, "detail": "No hay carpetas raíz configuradas en Radarr/Sonarr. Configúralas en Settings > Media Management."}

            if req.type == "movie":
                lookup = await arr_movie_lookup(session, service, req.title)
                tmdb_id = lookup.get("tmdbId", 0)
                if not tmdb_id:
                    return {"ok": False, "id": None, "detail": f"No se encontró '{req.title}' en Radarr. Verifica el título."}

                existing_id = await arr_movie_exists(session, service, tmdb_id)
                if existing_id:
                    await arr_search_movie(session, service, existing_id)
                    return {
                        "ok": True,
                        "id": existing_id,
                        "detail": "Película ya está en Radarr. Búsqueda lanzada.",
                    }

                movie_payload = {
                    "title": lookup.get("title") or req.title,
                    "tmdbId": tmdb_id,
                    "year": lookup.get("year") or req.year or 0,
                    "qualityProfileId": lookup.get("qualityProfileId", 1),
                    "rootFolderPath": root_path,
                    "monitored": True,
                }
                add_result = await arr_add_movie(session, service, movie_payload)
                if add_result.get("ok") and add_result.get("id"):
                    await arr_search_movie(session, service, add_result["id"])
                    return {
                        "ok": True,
                        "id": add_result["id"],
                        "detail": "Película agregada y búsqueda lanzada",
                    }
                return {"ok": False, "id": None, "detail": add_result.get("detail", "Error desconocido")}

            elif req.type == "episode":
                lookup = await arr_series_lookup(session, service, req.title)
                tvdb_id = lookup.get("tvdbId", 0)
                if not tvdb_id:
                    return {"ok": False, "id": None, "detail": f"No se encontró '{req.title}' en Sonarr. Verifica el título."}

                existing_id = await arr_series_exists(session, service, tvdb_id)
                if existing_id:
                    return {
                        "ok": True,
                        "id": existing_id,
                        "detail": "Serie ya está en Sonarr. Puedes buscar releases directamente.",
                    }

                series_payload = {
                    "title": lookup.get("title") or req.title,
                    "tvdbId": tvdb_id,
                    "year": lookup.get("year") or req.year or 0,
                    "qualityProfileId": lookup.get("qualityProfileId", 1),
                    "rootFolderPath": root_path,
                    "monitored": True,
                    "seasonFolder": lookup.get("seasonFolder", True),
                }
                add_result = await arr_add_series(session, service, series_payload)
                if add_result.get("ok") and add_result.get("id"):
                    return {
                        "ok": True,
                        "id": add_result["id"],
                        "detail": "Serie agregada a Sonarr",
                    }
                return {"ok": False, "id": None, "detail": add_result.get("detail", "Error desconocido")}

            else:
                return {"ok": False, "id": None, "detail": f"Tipo desconocido: {req.type}"}
    except Exception as exc:
        log.exception("calendar_add error: %s", exc)
        return {"ok": False, "id": None, "detail": f"Error interno: {exc}"}


@router.post("/api/calendar/releases")
async def calendar_releases(req: CalendarReleasesRequest, _key: str = Depends(verify_api_key)):
    """Obtiene releases disponibles para un movie/episode."""
    service = next((s for s in SERVICES if s["key"] == req.source and s["kind"] == "arr"), None)
    if not service:
        return {"releases": [], "detail": f"Servicio desconocido: {req.source}"}

    try:
        async with aiohttp.ClientSession() as session:
            if req.type == "movie":
                result = await arr_fetch_releases(session, service, movie_id=req.id)
            elif req.type == "episode":
                result = await arr_fetch_releases(session, service, episode_id=req.id)
            else:
                return {"releases": [], "detail": f"Tipo desconocido: {req.type}"}
            # Enrich releases with indexerId by matching indexer name → id
            if result.get("releases"):
                indexers = await arr_indexers(session, service)
                name_to_id = {idx["name"]: idx["id"] for idx in indexers if idx.get("name")}
                for r in result["releases"]:
                    if not r.get("indexerId"):
                        r["indexerId"] = name_to_id.get(r.get("indexer", ""), 0)
        return result
    except Exception as exc:
        log.exception("calendar_releases error: %s", exc)
        return {"releases": [], "detail": f"Error interno: {exc}"}


@router.post("/api/calendar/grab")
async def calendar_grab(req: CalendarGrabRequest, _key: str = Depends(verify_api_key)):
    """Descarga un release específico."""
    service = next((s for s in SERVICES if s["key"] == req.source and s["kind"] == "arr"), None)
    if not service:
        return {"ok": False, "detail": f"Servicio desconocido: {req.source}"}

    try:
        async with aiohttp.ClientSession() as session:
            result = await arr_grab_release(session, service, req.guid, req.indexerId, req.movieId, req.episodeId)
        return result
    except Exception as exc:
        log.exception("calendar_grab error: %s", exc)
        return {"ok": False, "detail": f"Error interno: {exc}"}


@router.post("/api/calendar/grab-batch")
async def calendar_grab_batch(req: CalendarGrabBatchRequest, _key: str = Depends(verify_api_key)):
    """Descarga múltiples releases en lote."""
    service = next((s for s in SERVICES if s["key"] == req.source and s["kind"] == "arr"), None)
    if not service:
        return {"ok": False, "detail": f"Servicio desconocido: {req.source}"}

    results = []
    errors = []
    async with aiohttp.ClientSession() as session:
        for i, guid in enumerate(req.guids):
            idx_id = req.indexerIds[i] if i < len(req.indexerIds) else 0
            try:
                result = await arr_grab_release(session, service, guid, idx_id, req.movieId, req.episodeId)
                if result.get("ok"):
                    results.append(guid)
                else:
                    errors.append({"guid": guid, "detail": result.get("detail", "Error desconocido")})
            except Exception as exc:
                errors.append({"guid": guid, "detail": str(exc)})

    ok = len(errors) == 0
    if ok:
        detail = f"{len(results)} descargados"
    else:
        # Surface the actual reason, not just a count. "0 OK, 1 errores" tells the
        # user nothing about what went wrong.
        first = errors[0].get("detail", "Error desconocido") if errors else "Error desconocido"
        detail = f"{len(results)} OK, {len(errors)} errores: {first}"
        if len(errors) > 1:
            detail += f" (+{len(errors) - 1} más)"
    return {"ok": ok, "detail": detail, "downloaded": results, "errors": errors}


@router.get("/api/calendar/indexers")
async def calendar_indexers(source: str = "radarr"):
    """Lista de indexadores configurados en Radarr/Sonarr."""
    service = next((s for s in SERVICES if s["key"] == source and s["kind"] == "arr"), None)
    if not service:
        return {"indexers": []}
    async with aiohttp.ClientSession() as session:
        indexers = await arr_indexers(session, service)
    return {"indexers": indexers}


@router.get("/api/disk")
async def get_disk_usage():
    """Uso de disco de cada volumen configurado."""
    import shutil
    volumes = [
        {"name": "Storage (6TB)", "path": "/mnt/storage-6tb"},
        {"name": "Storage", "path": "/mnt/storage"},
    ]
    result = []
    for vol in volumes:
        try:
            usage = shutil.disk_usage(vol["path"])
            result.append({
                "name": vol["name"],
                "path": vol["path"],
                "total_bytes": usage.total,
                "used_bytes": usage.used,
                "free_bytes": usage.free,
                "percent": round(usage.used / usage.total * 100, 1) if usage.total > 0 else 0,
            })
        except (OSError, FileNotFoundError):
            result.append({
                "name": vol["name"],
                "path": vol["path"],
                "total_bytes": 0,
                "used_bytes": 0,
                "free_bytes": 0,
                "percent": 0,
                "error": "no disponible",
            })
    return {"volumes": result}
