"""Wanted/missing content and scan routes."""

import asyncio
import os
import time
import unicodedata

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from application import gateways
from application.gateways import history
from application.use_cases.scan_wanted import normalize_title, scan_wanted_files
from config import configured_services, find_service, service_unavailable_reason
from traces import host_path
from application.gateways import (
    fetch_wanted_movies,
    fetch_wanted_episodes,
    arr_series_episodes,
    fetch_all_movies_detailed,
    fetch_all_series_detailed,
    arr_cancel_command,
    arr_search_missing_movies,
    arr_search_missing_episodes,
    arr_search_movie,
    arr_search_episode,
    arr_movie_metadata,
    arr_series_metadata,
)
from models import ActionRequest
from interfaces.http.deps import verify_api_key
from interfaces.http.route_helpers import attach_grabbed_at
from state import http_session
import config

router = APIRouter()

# Radarr paginates wanted/missing server-side, so asking for one page at a time
# is cheap but makes client-side filtering dishonest (it would only see what is
# loaded). When a text filter is present we pull everything in a single request
# instead — verified: pageSize=2000 returns all 95 movies / 1981 episodes.
ALL_ITEMS_PAGE_SIZE = 2000

# Pulling everything costs ~1.3 MB and ~1.4s for episodes, so cache it briefly.
# Without this, every keystroke would re-download the full wanted list.
_ALL_WANTED_TTL = 60.0
_all_wanted_cache: dict[str, tuple[float, list[dict]]] = {}


def normalize_for_search(value: str) -> str:
    """Lowercase and strip accents so "Seu Nome" matches "seu nome"."""
    decomposed = unicodedata.normalize("NFD", value or "")
    stripped = "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    return stripped.lower().strip()


def _searchable_fields(item: dict) -> list[str]:
    return [
        item.get("title", ""),
        item.get("series_title", ""),
        item.get("overview", ""),
        *(item.get("altTitles") or []),
    ]


def _matches(item: dict, needle: str) -> bool:
    return any(normalize_for_search(field).find(needle) != -1 for field in _searchable_fields(item))


def _paginate(items: list[dict], page: int, page_size: int) -> list[dict]:
    start = max(0, (page - 1) * page_size)
    return items[start:start + page_size]


async def _fetch_all_wanted(source_key: str) -> dict:
    """Everything Radarr/Sonarr report as wanted, cached for a short while.

    Returns the full result dict so a failure can be reported instead of being
    flattened into an empty list.
    """
    cached = _all_wanted_cache.get(source_key)
    if cached and time.time() - cached[0] < _ALL_WANTED_TTL:
        return {"items": cached[1]}

    service = find_service(source_key, "arr")
    if not service:
        return {"items": [], "total": 0, "error_kind": "unknown", "error": f"{source_key}: servicio no configurado"}

    async with http_session() as session:
        if source_key == "radarr":
            result = await fetch_wanted_movies(session, service, page=1, page_size=ALL_ITEMS_PAGE_SIZE)
        else:
            result = await fetch_wanted_episodes(session, service, page=1, page_size=ALL_ITEMS_PAGE_SIZE)

    if result.get("error"):
        # Never cache a failure: it would keep the UI broken for the whole TTL.
        return result

    _all_wanted_cache[source_key] = (time.time(), result.get("items", []))
    return result


@router.get("/api/wanted")
async def get_wanted(page: int = 1, page_size: int = 50, source: str = "", q: str = "", _key: str = Depends(verify_api_key)):
    """Películas y episodios faltantes (wanted), con filtro de texto opcional."""
    arr_services = configured_services("arr")
    if source:
        arr_services = [s for s in arr_services if s["key"] == source]

    needle = normalize_for_search(q)

    if needle:
        # Filter over EVERYTHING, then paginate here. The frontend keeps its
        # page/page_size contract, so infinite scroll is unaffected and `total`
        # reflects the filtered set rather than only the loaded pages.
        wanted = {}
        for service in arr_services:
            result = await _fetch_all_wanted(service["key"])
            if result.get("error"):
                wanted[service["key"]] = {
                    **_empty_page(page, page_size),
                    "error": result["error"],
                    "error_kind": result.get("error_kind", "unknown"),
                }
                continue
            matches = [item for item in result.get("items", []) if _matches(item, needle)]
            wanted[service["key"]] = {
                "items": _paginate(matches, page, page_size),
                "total": len(matches),
                "page": page,
                "page_size": page_size,
            }
        return await attach_grabbed_at(
            {"wanted": wanted, "updated_at": int(time.time()), "filtered": True}
        )

    async with http_session() as session:
        results = await asyncio.gather(
            *(
                fetch_wanted_movies(session, s, page, page_size)
                if s["key"] == "radarr"
                else fetch_wanted_episodes(session, s, page, page_size)
                for s in arr_services
            )
        )
    wanted = {}
    for service, result in zip(arr_services, results):
        wanted[service["key"]] = result
    return await attach_grabbed_at({
        "wanted": wanted,
        "updated_at": int(time.time()),
    })


def _empty_page(page: int, page_size: int) -> dict:
    return {"items": [], "total": 0, "page": page, "page_size": page_size}


def _failure_fields(result: dict) -> dict:
    """Carry a fetch failure through a route that reshapes the result."""
    if not result.get("error"):
        return {}
    return {"error": result["error"], "error_kind": result.get("error_kind", "unknown")}


def _filter_all_endpoint(result: dict, q: str, page: int, page_size: int) -> dict:
    """Apply the text filter to an endpoint that already holds the full list.

    Radarr's /api/v3/movie and Sonarr's /api/v3/series are fetched in full, but
    the client slices to the requested page before returning. Filtering that
    slice would only ever search the current page — the exact dishonesty this
    filter exists to avoid — so the caller asks for everything (page_size=0)
    when a filter is present.
    """
    failure = _failure_fields(result)
    if failure:
        # A failed fetch must not be reported as "no matches for your filter".
        return {**_empty_page(page, page_size), **failure, "filtered": True}

    needle = normalize_for_search(q)
    if not needle:
        return result

    matches = [item for item in result.get("items", []) if _matches(item, needle)]
    return {
        "items": _paginate(matches, page, page_size),
        "total": len(matches),
        "page": page,
        "page_size": page_size,
        "filtered": True,
    }


@router.get("/api/wanted/all")
async def get_all_movies(page: int = 1, page_size: int = 50, q: str = "", _key: str = Depends(verify_api_key)):
    """Todas las películas de Radarr con estado de archivo y ruta (paginado)."""
    service = find_service("radarr", "arr")
    if not service:
        # The same reason `/api/wanted` carries: an unconfigured arr and an
        # empty catalogue are different facts, and the Calidad view shows both.
        return {"items": [], "total": 0, "page": page, "page_size": page_size,
                "error_kind": "unknown", "error": "radarr: servicio no configurado"}
    # page_size=0 tells the client not to slice, so the filter sees everything.
    fetch_size = 0 if normalize_for_search(q) else page_size
    async with http_session() as session:
        result = await fetch_all_movies_detailed(session, service, page, fetch_size)
    # Every /api/wanted/all item is a Radarr movie, so the key is explicit.
    return await attach_grabbed_at(
        _filter_all_endpoint(result, q, page, page_size), source="radarr", kind="movie"
    )


@router.get("/api/wanted/series/all")
async def get_all_series(page: int = 1, page_size: int = 50, q: str = "", _key: str = Depends(verify_api_key)):
    """Todas las series de Sonarr con estado de archivo y ruta (paginado)."""
    service = find_service("sonarr", "arr")
    if not service:
        # See `get_all_movies`: "Sonarr no está configurado" must not read as
        # "ninguna serie en ninguna clase".
        return {"items": [], "total": 0, "page": page, "page_size": page_size,
                "error_kind": "unknown", "error": "sonarr: servicio no configurado"}
    fetch_size = 0 if normalize_for_search(q) else page_size
    async with http_session() as session:
        result = await fetch_all_series_detailed(session, service, page, fetch_size)
    # A series card is marked by any episode grab of that series.
    return await attach_grabbed_at(
        _filter_all_endpoint(result, q, page, page_size), source="sonarr", kind="series"
    )


@router.get("/api/wanted/series/{series_id}/episodes")
async def get_series_episodes(series_id: int, _key: str = Depends(verify_api_key)):
    """Episodios de una serie, para enriquecer la navegación de "En carpeta"."""
    service = find_service("sonarr", "arr")
    if not service:
        return {"episodes": [], "error": service_unavailable_reason("sonarr")}
    async with http_session() as session:
        return await arr_series_episodes(session, service, series_id)


@router.get("/api/grabs")
async def get_grabs(
    source: str = "",
    movie_id: int | None = None,
    episode_id: int | None = None,
    series_id: int | None = None,
    _key: str = Depends(verify_api_key),
):
    """Todas las descargas que hizo ESTA app para un título, de más antigua a
    más reciente.

    Para el panel de detalle de Calidad: distingue "ya lo tenemos en 4K y en
    1080p" de "nunca lo pedimos", que es lo que evita volver a descargar algo.
    A diferencia de las marcas de "Faltantes" (la fila más reciente por
    título), aquí NO se colapsa ni se limita el historial: cada descarga
    cuenta, porque una descarga ausente se leería como "nunca se pidió".

    `series_id` es la tercera llave, para la tarjeta de una serie: esa
    tarjeta viaja como episodio (lo único que Sonarr puede descargar) pero
    lleva el id de la SERIE, y preguntar `episode_id=<id de serie>` devolvería
    el episodio de OTRA serie que comparta número — una clase ajena contando
    como propia.
    """
    if movie_id is None and episode_id is None and series_id is None:
        raise HTTPException(
            status_code=400, detail="Se requiere movie_id, episode_id o series_id"
        )
    # Same answer as the neighbouring routes when the service cannot be used:
    # the normal body plus `error`, never an exception.
    if not find_service(source, "arr"):
        return {"grabs": [], "error": service_unavailable_reason(source)}
    # Precedence movie > episode > series, mirroring how the own-grab keying
    # resolves a row that somehow carries several ids: the caller gets the
    # kind it asked for FIRST, never another kind's rows.
    if movie_id is not None:
        kind, item_id = "movie", movie_id
    elif episode_id is not None:
        kind, item_id = "episode", episode_id
    else:
        kind, item_id = "series", series_id
    # `history.py`'s contract: the synchronous reader goes through a thread.
    rows = await asyncio.to_thread(history.own_grabs_for, source, kind, item_id)
    return {
        "grabs": [
            {
                # NULL stays null: a row older than those columns is unknown,
                # not "" — the frontend must not render an empty quality name.
                "quality": row["quality"],
                "destination": row["destination"],
                "grabbed_at": row["grabbed_at"],
            }
            for row in rows
        ]
    }


class BulkSearchRequest(BaseModel):
    """Body of the mass search. `confirm` is the whole contract.

    ``MissingMoviesSearch`` can fire grabs for every missing title at once,
    and until this route existed nothing could stop it (C-09, incident
    2026-10-07). An explicit ``confirm: true`` is the guard; the count shown
    before confirming belongs to whoever holds the list — the UI.
    """
    source: str = ""
    confirm: bool = False


class CommandCancelRequest(BaseModel):
    """The handle ``arr_command`` returned, handed back to be cancelled."""
    source: str
    command_id: int


@router.post("/api/wanted/search")
async def search_wanted(req: BulkSearchRequest, _key: str = Depends(verify_api_key)):
    """Busca TODO lo faltante en los indexadores — y solo si se confirma.

    Sin ``confirm: true`` no se lanza nada: la respuesta lleva
    ``needs_confirm`` (un aviso, no un error — algo pedía permiso) y el nombre
    del comando que SE LANZARÍA. Lanzada, devuelve el ``command_id`` de Radarr,
    el asidero para cancelarla en ``/api/wanted/search/cancel``.
    """
    service = find_service(req.source, "arr")
    if not service:
        return {"ok": False, "error": service_unavailable_reason(req.source)}
    command = "MissingMoviesSearch" if req.source == "radarr" else "MissingEpisodeSearch"
    if not req.confirm:
        return {
            "ok": False,
            "needs_confirm": True,
            "command": command,
            "detail": (
                "Búsqueda masiva no lanzada: reenvía con confirm=true "
                "(puede disparar muchos grabs de golpe)"
            ),
        }

    async with http_session() as session:
        if req.source == "radarr":
            result = await arr_search_missing_movies(session, service)
        elif req.source == "sonarr":
            result = await arr_search_missing_episodes(session, service)
        else:
            return {"ok": False, "error": f"servicio no soportado: {req.source}"}

    return {**result, "source": req.source, "command_id": result.get("command_id")}


@router.post("/api/wanted/search/cancel")
async def cancel_search(req: CommandCancelRequest, _key: str = Depends(verify_api_key)):
    """Cancela un comando en curso en el arr por su id.

    El uso previsto es el de arriba: el ``command_id`` que devolvió la búsqueda
    masiva. Si el comando ya terminó, el arr responde 404 y eso se devuelve tal
    cual — un comando que ya no existe no es un error nuestro.
    """
    service = find_service(req.source, "arr")
    if not service:
        return {"ok": False, "error": service_unavailable_reason(req.source)}
    async with http_session() as session:
        result = await arr_cancel_command(session, service, req.command_id)
    return {**result, "source": req.source, "command_id": req.command_id}


@router.post("/api/wanted/search/item")
async def search_wanted_item(req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Busca un item específico en los indexadores."""
    source = req.source
    service = find_service(source, "arr")
    if not service:
        return {"ok": False, "error": service_unavailable_reason(source)}

    ids = req.ids or {}
    async with http_session() as session:
        if source == "radarr" and ids.get("movie_id"):
            result = await arr_search_movie(session, service, ids["movie_id"])
        elif source == "sonarr" and ids.get("episode_id"):
            result = await arr_search_episode(session, service, ids["episode_id"])
        else:
            return {"ok": False, "error": "IDs insuficientes para búsqueda"}

    return {"ok": result.get("ok", False), "detail": result.get("detail", ""), "source": source}


# --- Wanted: Scan for misplaced files ---


def _validate_path(path: str) -> str:
    """Valida que la ruta esté dentro de los volúmenes permitidos."""
    if not path:
        return ""
    normalized = host_path(path)
    resolved = os.path.realpath(normalized)
    # The configured roots, not a copy: a root added in Configuración has to
    # be the one this validator accepts.
    for root in config.ALLOWED_ROOTS:
        if resolved == root or resolved.startswith(root + "/"):
            return resolved
    from fastapi import HTTPException
    raise HTTPException(status_code=403, detail=f"Ruta no permitida: {path}")


@router.post("/api/wanted/scan")
async def scan_for_movies(req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Escanea una carpeta buscando una película o serie específica desubicada."""
    try:
        return await _scan_for_movies_inner(req)
    except Exception as exc:
        import logging
        log = logging.getLogger("flow-controller")
        log.exception("scan_for_movies error: %s", exc)
        return {"ok": False, "detail": f"Error interno: {exc}", "matches": [], "scanned_files": 0}


async def _scan_for_movies_inner(req: ActionRequest) -> dict:
    """Lógica interna de escaneo de contenido faltante."""
    source = req.source
    folder_path = req.remote_path or ""
    ids = req.ids or {}
    movie_id = ids.get("movie_id")
    series_id = ids.get("series_id")

    custom_title = ids.get("custom_title", "").strip()

    if not folder_path:
        return {"ok": False, "detail": "Se requiere remote_path (carpeta a escanear)"}

    target = _validate_path(folder_path)
    if not os.path.isdir(target):
        return {"ok": False, "detail": f"No es un directorio: {target}"}

    service = find_service(source, "arr")
    if not service:
        return {"ok": False, "detail": "Servicio no encontrado"}

    # Modo selectivo: buscar solo un item específico
    if movie_id or series_id:
        movie_path = ""
        async with http_session() as session:
            if movie_id:
                meta = await arr_movie_metadata(session, service, int(movie_id))
                if not meta:
                    return {"ok": False, "detail": "Película no encontrada"}
                item_title = meta.get("title", "")
                item_year = meta.get("year")
                movie_path = host_path(meta.get("path", "")) if meta.get("path") else ""
                all_titles = [item_title] + [
                    (t.get("title") if isinstance(t, dict) else t)
                    for t in meta.get("altTitles", [])
                    if t
                ]
            elif series_id:
                meta = await arr_series_metadata(session, service, int(series_id))
                if not meta:
                    return {"ok": False, "detail": "Serie no encontrada"}
                item_title = meta.get("title", "")
                item_year = None
                movie_path = host_path(meta.get("path", "")) if meta.get("path") else ""
                all_titles = [item_title] + [
                    (t.get("title") if isinstance(t, dict) else t)
                    for t in meta.get("alternateTitles", [])
                    if t
                ]
            else:
                return {"ok": False, "detail": "IDs insuficientes"}

        # Si el usuario puso un título manual, usarlo como primer candidato
        if custom_title:
            all_titles.insert(0, custom_title)

        # Construir title_map con un solo item
        title_map = {}
        for title in all_titles:
            if not title:
                continue
            norm = normalize_title(title)
            if norm and norm not in title_map:
                title_map[norm] = {
                    "movie_id": movie_id or series_id,
                    "movie_title": item_title,
                    "movie_year": item_year,
                    "movie_path": movie_path,
                    "title_used": title,
                }
    else:
        # Modo legacy: buscar contra todas las wanted movies
        async with http_session() as session:
            result = await fetch_wanted_movies(session, service, page=1, page_size=200)
            wanted_movies = result.get("items", [])

        if not wanted_movies:
            return {"ok": True, "matches": [], "scanned_files": 0, "detail": "No hay películas faltantes"}

        title_map = {}
        for movie in wanted_movies:
            all_titles = [movie.get("title", "")]
            for alt in movie.get("altTitles", []):
                t = alt.get("title") if isinstance(alt, dict) else alt
                if t:
                    all_titles.append(t)
            for title in all_titles:
                if not title:
                    continue
                norm = normalize_title(title)
                if norm and norm not in title_map:
                    title_map[norm] = {
                        "movie_id": movie.get("id"),
                        "movie_title": movie.get("title", ""),
                        "movie_year": movie.get("year"),
                        "movie_path": host_path(movie.get("path", "")) if movie.get("path") else "",
                        "title_used": title,
                    }
        item_title = f"{len(wanted_movies)} películas faltantes"
        item_year = None

    # Walk + score off the loop: this is the O(videos x titles) CPU cost.
    matches, scanned_files = await asyncio.to_thread(
        scan_wanted_files, target, title_map, walk=gateways.scan
    )


    return {
        "ok": True,
        "matches": matches,
        "scanned_files": scanned_files,
        "item_title": item_title,
        "detail": f"Escaneados {scanned_files} archivos contra \"{item_title}\", {len(matches)} coincidencias",
    }
