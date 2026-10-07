"""Calendar routes — upcoming episodes and movies."""

import asyncio
import logging
import os
import shutil
import time
from datetime import date, timedelta

import aiohttp
from fastapi import APIRouter, Depends

from config import ALLOWED_ROOTS, destination_for_quality, find_service, path_is_allowed, service_unavailable_reason
from application.gateways import record_own_grab
from application.gateways import (
    fetch_radarr_calendar,
    fetch_sonarr_calendar,
    amutorrent_add_download,
    amutorrent_search_link,
    arr_search_movie,
    arr_search_episode,
    arr_episode_metadata,
    arr_add_movie,
    arr_add_series,
    arr_fetch_releases,
    arr_grab_release,
    direct_link_identity,
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
from interfaces.http.routes.status import verify_api_key
from interfaces.http.routes.wanted import _attach_grabbed_at
from state import http_session

log = logging.getLogger("flow-controller")
router = APIRouter()


@router.get("/api/calendar")
async def get_calendar(start: str = "", end: str = "", _key: str = Depends(verify_api_key)):
    """Calendario de próximos episodios y películas."""
    if not start:
        start = date.today().isoformat()
    if not end:
        end = (date.today() + timedelta(days=30)).isoformat()

    radarr = find_service("radarr", "arr")
    sonarr = find_service("sonarr", "arr")

    all_items = []
    async with http_session() as session:
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
    # Each item carries its own `source` and `type`, so the shared helper reads
    # the mark key from the item instead of being told which one it is.
    return await _attach_grabbed_at({"items": all_items, "start": start, "end": end})


@router.post("/api/calendar/search")
async def calendar_search(req: CalendarSearchRequest, _key: str = Depends(verify_api_key)):
    """Busca contenido en los indexadores de Radarr/Sonarr."""
    service = find_service(req.source, "arr")
    if not service:
        return {"ok": False, "detail": service_unavailable_reason(req.source)}

    async with http_session() as session:
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
    service = find_service(req.source, "arr")
    if not service:
        return {"ok": False, "id": None, "detail": f"Servicio desconocido: {req.source}"}

    try:
        async with http_session() as session:
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


# The indexers are a small, very stable list, and it is asked for on every modal
# open AND on every release search (to map indexer name → id). 300s is long
# enough that a list already fetched for Radarr is not fetched again a few
# minutes later — the point of the bug — and short enough that adding an indexer
# shows up without restarting anything. Failures are never cached: that would
# keep the modal broken for the whole TTL.
_INDEXERS_TTL = 300.0
_indexers_cache: dict[str, tuple[float, list[dict]]] = {}


async def _indexers_for(source: str) -> dict:
    """Indexadores de una fuente, cached per source, with the failure preserved."""
    cached = _indexers_cache.get(source)
    if cached and time.time() - cached[0] < _INDEXERS_TTL:
        return {"indexers": cached[1]}

    service = find_service(source, "arr")
    if not service:
        return {
            "indexers": [],
            "error_kind": "unknown",
            "error": f"{source}: servicio no configurado",
        }

    async with http_session() as session:
        result = await arr_indexers(session, service)

    if result.get("error"):
        return result

    _indexers_cache[source] = (time.time(), result.get("indexers", []))
    return result


@router.post("/api/calendar/releases")
async def calendar_releases(req: CalendarReleasesRequest, _key: str = Depends(verify_api_key)):
    """Obtiene releases disponibles para un movie/episode."""
    service = find_service(req.source, "arr")
    if not service:
        return {"releases": [], "detail": f"Servicio desconocido: {req.source}"}

    try:
        async with http_session() as session:
            if req.type == "movie":
                result = await arr_fetch_releases(session, service, movie_id=req.id)
            elif req.type == "episode":
                result = await arr_fetch_releases(session, service, episode_id=req.id)
            else:
                return {"releases": [], "detail": f"Tipo desconocido: {req.type}"}
            # Enrich releases with indexerId by matching indexer name → id. The
            # cached list is reused: re-asking the arr on every search was the
            # reason a Radarr indexer list was fetched twice in a row.
            if result.get("releases"):
                indexers = (await _indexers_for(req.source)).get("indexers", [])
                name_to_id = {idx["name"]: idx["id"] for idx in indexers if idx.get("name")}
                for r in result["releases"]:
                    if not r.get("indexerId"):
                        r["indexerId"] = name_to_id.get(r.get("indexer", ""), 0)
        return result
    except Exception as exc:
        log.exception("calendar_releases error: %s", exc)
        return {"releases": [], "detail": f"Error interno: {exc}"}


async def _resolve_series_id(
    session: aiohttp.ClientSession, service: dict, source: str, episode_id: int
) -> int | None:
    """Best-effort series id for a Sonarr episode grab.

    The "Todas" series card is marked from the `series_id` an own-grab row
    carries, so an episode grab has to resolve it while it still has the arr
    open. This runs AFTER a grab already succeeded, which fixes its failure
    contract: it must never raise, because a completed grab reaching the user as
    an error is a worse lie than a missing series mark. Any failure — timeout,
    malformed body, arr that does not know the episode — degrades to None, and
    that only skips the series mark; the grab itself is already recorded.
    """
    if source != "sonarr" or not episode_id:
        return None
    try:
        meta = await arr_episode_metadata(session, service, episode_id)
    except Exception as exc:
        log.warning("Series lookup failed for episode %s: %s", episode_id, exc)
        return None
    return meta.get("series_id")


class GrabBody(CalendarGrabRequest):
    """The grab body plus what a direct add needs.

    `title` is the release's own title — the key we ask aMuTorrent's Torznab
    for the link, because the arr's release payload carries only its guid. On
    the arr path it rides along unused; a foreign-destination grab without it
    fails loudly instead of guessing a query.

    `library` is the explicit "the arr's own path" choice of the per-card
    buttons: without it, an absent destination still means *derived* routing
    (a 2160p release would be sent to `path_4k` even though the operator
    pressed → Biblioteca). Library wins over any folder; quality and is3d
    still ride for the registry.
    """
    title: str = ""
    library: bool = False


def _inside(path: str, root: str) -> bool:
    """`path` is `root` or below it, without the `/a/b`-matches-`/a/bc` trap."""
    normalized_path = os.path.normpath(path)
    normalized_root = os.path.normpath(root)
    return normalized_path == normalized_root or normalized_path.startswith(
        normalized_root.rstrip("/") + "/"
    )


@router.post("/api/calendar/grab")
async def calendar_grab(req: GrabBody, _key: str = Depends(verify_api_key)):
    """Descarga un release: por el arr, o directa al cliente si tiene destino ajeno."""
    service = find_service(req.source, "arr")
    if not service:
        return {"ok": False, "detail": service_unavailable_reason(req.source)}

    # Resolve the destination BEFORE the grab, so nothing is sent to the arr
    # and no own-grab row is written. The explicit library choice of the
    # per-card buttons wins over everything (it IS the decision); then a folder
    # chosen by hand; then the release's own quality class picks one (`quality`
    # is only a hint — it must never override a decision the operator already
    # made). The effective path is then checked against the app's configured
    # allowed roots (`path_is_allowed`); it is never trusted to be safe. Absent
    # (None) is the library default and skips the check entirely.
    destination = None
    if not req.library:
        destination = req.destination or destination_for_quality(
            req.quality, is3d=req.is3d
        )
    if destination is not None and not path_is_allowed(destination):
        return {"ok": False, "detail": f"Destino no permitido: {destination}"}

    direct = False
    client_name = ""
    client_hash = None
    try:
        # The series lookup rides the grab's own session: it is a single GET to
        # the arr the grab just hit, so a second session would only add another
        # connection. `_resolve_series_id` cannot raise, so a failed lookup can
        # never turn this successful grab into the error response below.
        async with http_session() as session:
            # A destination OUTSIDE every arr root means the file is leaving
            # the library — and if the download goes through the arr, the arr
            # imports it on completion and REPLACES what the library already
            # holds (the 4K-cannibalises-the-1080p incident). Such a download
            # never touches the arr: straight to the client, our own category.
            # Fails closed: an unreadable root list proves nothing, so the grab
            # stays on the arr path it has always taken.
            foreign = False
            if destination is not None:
                roots = await arr_root_folders(session, service)
                foreign = bool(roots) and not any(
                    _inside(destination, root) for root in roots
                )

            if foreign:
                if not req.title:
                    return {
                        "ok": False,
                        "detail": "Falta el título del release para resolver el enlace directo",
                    }
                link = await amutorrent_search_link(session, req.title)
                if not link:
                    return {
                        "ok": False,
                        "detail": (
                            f"No encontré «{req.title}» en el indexador de aMule; no se "
                            "envió nada al arr. Elige Destino = Biblioteca para "
                            "descargarlo con Radarr/Sonarr."
                        ),
                    }
                added = await amutorrent_add_download(session, link)
                if not added.get("ok"):
                    return {
                        "ok": False,
                        "detail": f"aMuTorrent no aceptó la descarga: {added.get('detail')}",
                    }
                direct = True
                client_name, client_hash = direct_link_identity(link, req.title)
                series_id = (
                    await _resolve_series_id(session, service, req.source, req.episodeId)
                    if req.episodeId
                    else None
                )
                result = {
                    "ok": True,
                    "detail": f"{added.get('detail')} — directa: el arr no la verá ni la importará",
                    "direct": True,
                }
            else:
                result = await arr_grab_release(session, service, req.guid, req.indexerId, req.movieId, req.episodeId)
                series_id = (
                    await _resolve_series_id(session, service, req.source, req.episodeId)
                    if result.get("ok")
                    else None
                )
    except Exception as exc:
        log.exception("calendar_grab error: %s", exc)
        return {"ok": False, "detail": f"Error interno: {exc}"}

    # Only a grab that actually succeeded enters the own-grab registry (D3), and
    # the recording is best-effort: it must not change the response. `0` is the
    # request's "not this kind of title" default, so it becomes NULL rather than
    # a bogus id.
    if result.get("ok"):
        await asyncio.to_thread(record_own_grab, 
            req.source,
            movie_id=req.movieId or None,
            episode_id=req.episodeId or None,
            series_id=series_id,
            guid=req.guid,
            indexer_id=req.indexerId,
            destination=destination,
            quality=req.quality or None,
            direct=direct,
            client_name=client_name,
            client_hash=client_hash,
        )
    return result


@router.post("/api/calendar/grab-batch")
async def calendar_grab_batch(req: CalendarGrabBatchRequest, _key: str = Depends(verify_api_key)):
    """Descarga múltiples releases en lote."""
    service = find_service(req.source, "arr")
    if not service:
        return {"ok": False, "detail": service_unavailable_reason(req.source)}

    # Same resolution and guard as the single grab, applied once for the whole
    # batch: an invalid destination rejects the request before any guid is sent
    # to the arr, so no own-grab row is written either. The frontend groups
    # rows by destination and calls this once per group, so one value covers
    # the batch — and one quality covers it for the same reason, because the
    # derived destination is what put these rows in the same group.
    destination = req.destination or destination_for_quality(
        req.quality, is3d=req.is3d
    )
    if destination is not None and not path_is_allowed(destination):
        return {
            "ok": False,
            "detail": f"Destino no permitido: {destination}",
            "downloaded": [],
            "errors": [],
        }

    results = []
    errors = []
    # Every guid in one batch targets the same title, so the series is resolved
    # once for the request and reused. `series_resolved` is the "already asked"
    # flag on purpose: `series_id is None` would re-ask the arr per guid after a
    # lookup that legitimately found no series, turning a slow arr into N slow
    # lookups. A failed lookup still leaves every successful grab recorded.
    series_id: int | None = None
    series_resolved = False
    async with http_session() as session:
        # Same foreign gate as the single grab, and the same fail-closed
        # reading of an unreadable root list. Refusing is deliberate: a batch
        # through the arr would import and replace, and resolving each guid's
        # link needs a title the batch does not carry — one row at a time is
        # the honest answer until the per-card buttons land.
        if destination is not None:
            roots = await arr_root_folders(session, service)
            if roots and not any(_inside(destination, root) for root in roots):
                return {
                    "ok": False,
                    "detail": (
                        f"El lote con destino fuera de la biblioteca ({destination}) no "
                        "está soportado: descarga fila a fila, que va directa al "
                        "cliente sin pasar por el arr."
                    ),
                    "downloaded": [],
                    "errors": [],
                }
        for i, guid in enumerate(req.guids):
            idx_id = req.indexerIds[i] if i < len(req.indexerIds) else 0
            try:
                result = await arr_grab_release(session, service, guid, idx_id, req.movieId, req.episodeId)
                if result.get("ok"):
                    results.append(guid)
                    if not series_resolved:
                        series_id = await _resolve_series_id(
                            session, service, req.source, req.episodeId
                        )
                        series_resolved = True
                    # One row per guid that succeeded, not one per request.
                    await asyncio.to_thread(record_own_grab, 
                        req.source,
                        movie_id=req.movieId or None,
                        episode_id=req.episodeId or None,
                        series_id=series_id,
                        guid=guid,
                        indexer_id=idx_id,
                        destination=destination,
                        quality=req.quality or None,
                    )
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
async def calendar_indexers(source: str = "radarr", _key: str = Depends(verify_api_key)):
    """Lista de indexadores de una fuente, o el motivo de no haberla podido obtener.

    `radarr` y `sonarr` son dos listas distintas y se cachean por separado: una
    ya pedida para Radarr no se vuelve a pedir a los pocos minutos.
    """
    return await _indexers_for(source)


def _merge_destination_folders(arr_roots: list[str], app_roots: list[str]) -> list[str]:
    """Merge the arr's root folders and the app's allowed roots, in that order.

    The arr's own roots come first because that is the library the user already
    knows; the app's roots follow, but only when they were not already offered.
    Empty entries are dropped and duplicates collapse, so the combo never lists
    the same folder twice and never offers a blank value.
    """
    merged: list[str] = []
    seen: set[str] = set()
    for folder in (*arr_roots, *app_roots):
        name = (folder or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        merged.append(name)
    return merged


@router.get("/api/calendar/destinations")
async def calendar_destinations(source: str = "radarr", _key: str = Depends(verify_api_key)):
    """Carpetas destino que el usuario puede elegir para sus descargas.

    Combines the arr's real root folders (`/api/v3/rootfolder`) with the app's
    configured allowed roots. The arr's roots come first, then the app roots
    that were not already listed. Never invents a folder and never fails the
    modal: if the arr is unavailable it still returns the app's allowed roots
    and reports the degradation in `detail`.
    """
    service = find_service(source, "arr")
    if not service:
        return {
            "folders": _merge_destination_folders([], ALLOWED_ROOTS),
            "arr_available": False,
            "detail": service_unavailable_reason(source),
        }

    async with http_session() as session:
        arr_roots = await arr_root_folders(session, service)

    folders = _merge_destination_folders(arr_roots, ALLOWED_ROOTS)
    if not arr_roots:
        # Either the arr is unreachable or it has no root folder configured;
        # `arr_root_folders` cannot tell them apart and neither can we. Say what
        # actually happened instead of claiming success with a short list.
        return {
            "folders": folders,
            "arr_available": False,
            "detail": f"{source} no devolvió carpetas raíz; se muestran solo las raíces de la app.",
        }
    return {"folders": folders, "arr_available": True, "detail": ""}


def _is_foreign_filesystem(path: str) -> bool:
    """Whether ``path`` is NOT its own filesystem — i.e. is not a mount point.

    ``shutil.disk_usage`` measures the filesystem that *contains* a path, so a
    plain directory answers with whatever holds it. That is how a folder on the
    app's own 63 GB rootfs was served as a working "Storage (6TB)" volume: the
    number was real, the label was not, and nothing on the way told them apart.

    A path that does not exist is deliberately NOT foreign. It is a different
    failure with a different message — "no existe" and "no es un montaje" are
    not the same answer, and hiding one behind the other loses information.
    (`os.path.ismount` answers ``False`` for a missing path rather than
    raising, so existence has to be asked first.)
    """
    if not os.path.exists(path):
        return False
    try:
        return not os.path.ismount(path)
    except OSError:
        return False


def _volume_name(path: str) -> str:
    """A label that claims nothing.

    The old endpoint invented ``Storage (6TB)`` — a capacity the code never
    measured. The last path component is all we actually know.
    """
    return os.path.basename(path.rstrip(os.sep)) or path


@router.get("/api/disk")
async def get_disk_usage(_key: str = Depends(verify_api_key)):
    """Uso de disco de cada volumen configurado.

    The volumes are the deployment's own ``paths.allowed_roots``, not a list
    written down when this page was built: those roots are already the
    authority for which folders this app may write to, so they are also the
    answer to "which storages exist". Every volume is checked for being its
    own filesystem first — reporting usage for a path that merely *sits*
    somewhere would be confident and wrong, which is worse than reporting
    nothing.
    """
    result = []
    for path in ALLOWED_ROOTS:
        entry = {"name": _volume_name(path), "path": path}
        if _is_foreign_filesystem(path):
            entry.update({
                "total_bytes": 0,
                "used_bytes": 0,
                "free_bytes": 0,
                "percent": 0,
                "error": "no es un punto de montaje (las cifras serían las de otro disco)",
            })
            result.append(entry)
            continue
        try:
            usage = shutil.disk_usage(path)
        except (OSError, FileNotFoundError):
            entry.update({
                "total_bytes": 0,
                "used_bytes": 0,
                "free_bytes": 0,
                "percent": 0,
                "error": "no disponible",
            })
        else:
            entry.update({
                "total_bytes": usage.total,
                "used_bytes": usage.used,
                "free_bytes": usage.free,
                "percent": round(usage.used / usage.total * 100, 1) if usage.total > 0 else 0,
            })
        result.append(entry)
    return {"volumes": result}
