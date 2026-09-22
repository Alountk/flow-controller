"""Wanted/missing content and scan routes."""

import asyncio
import os
import re
import time
import unicodedata

import aiohttp
from fastapi import APIRouter, Depends

import history
from config import configured_services, find_service, service_unavailable_reason
from traces import host_path
from clients import (
    fetch_wanted_movies,
    fetch_wanted_episodes,
    arr_series_episodes,
    fetch_all_movies_detailed,
    fetch_all_series_detailed,
    arr_search_missing_movies,
    arr_search_missing_episodes,
    arr_search_movie,
    arr_search_episode,
    arr_movie_metadata,
    arr_series_metadata,
)
from models import ActionRequest
from routes.status import verify_api_key

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

# How far back a grab is still worth showing as "Pedida el ...".
#
# The trade-off is what a too-long and a too-short window each get wrong. A mark
# persists only while the title is still missing, so it answers "I asked for
# this and it has not arrived". Too short and a genuinely stuck download loses
# its mark after a few days, which is exactly when the signal matters most. Too
# long and a mark from an old, superseded attempt claims the current missing
# state was requested when it was not. 90 days covers a slow season pack and a
# month of retries while staying a statement about the present missing state.
WANTED_GRAB_LOOKBACK = 90 * 24 * 60 * 60


def _attach_grabbed_at(response: dict, *, source: str = "", kind: str = "") -> dict:
    """Add ``grabbed_at`` to every item on a built response.

    Shared by every surface that shows the mark — ``/api/wanted``,
    ``/api/wanted/all``, ``/api/wanted/series/all`` and ``/api/calendar`` — so
    there is one enrichment rather than one per route. It handles both body
    shapes this app returns:

      - the grouped ``{"wanted": {service: {"items": [...]}}}`` shape, whose kind
        follows the service (``radarr`` → movie, ``sonarr`` → episode);
      - a flat ``{"items": [...]}`` shape, where the caller names the ``source``
        and ``kind`` because the items do not carry them — except the calendar,
        whose items already carry both ``source`` and ``type``, so it passes
        neither and the key is read per item.

    Called on the assembled body rather than inside either branch of
    ``/api/wanted`` on purpose: that route has a text-filtered branch and a plain
    one, and enriching only one of them would silently leave half the items
    unmarked. Do not move it back into a branch.

    The marks come from ``own_grabs``, re-read per request, and never from
    ``_fetch_all_wanted``'s cache: that cache holds the arr's data, and this mark
    is ours. Each item is copied so a cached or caller-owned dict is never
    mutated. An item with no mark gets ``grabbed_at: None`` — the field is always
    present, so the frontend never has to tell "absent" from "unknown".
    """
    marks = history.own_grabs_latest_map(time.time() - WANTED_GRAB_LOOKBACK)

    wanted = response.get("wanted")
    if wanted:
        for source_key, page in wanted.items():
            items = page.get("items")
            if not items:
                continue
            # Radarr wanted items are movies, Sonarr's are episodes; the own-grab
            # key records which kind, so the mapping is explicit rather than
            # guessed.
            item_kind = "movie" if source_key == "radarr" else "episode"
            page["items"] = [
                {**item, "grabbed_at": marks.get((source_key, item_kind, item.get("id")))}
                for item in items
            ]
        return response

    items = response.get("items")
    if items:
        response["items"] = [
            {
                **item,
                # The item's own source and type win when present (the calendar
                # carries both); otherwise the caller's explicit source/kind.
                "grabbed_at": marks.get((
                    item.get("source") or source,
                    item.get("type") or kind,
                    item.get("id"),
                )),
            }
            for item in items
        ]
    return response


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

    async with aiohttp.ClientSession() as session:
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
        return _attach_grabbed_at(
            {"wanted": wanted, "updated_at": int(time.time()), "filtered": True}
        )

    async with aiohttp.ClientSession() as session:
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
    return _attach_grabbed_at({
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
        return {"items": [], "total": 0, "page": page, "page_size": page_size}
    # page_size=0 tells the client not to slice, so the filter sees everything.
    fetch_size = 0 if normalize_for_search(q) else page_size
    async with aiohttp.ClientSession() as session:
        result = await fetch_all_movies_detailed(session, service, page, fetch_size)
    # Every /api/wanted/all item is a Radarr movie, so the key is explicit.
    return _attach_grabbed_at(
        _filter_all_endpoint(result, q, page, page_size), source="radarr", kind="movie"
    )


@router.get("/api/wanted/series/all")
async def get_all_series(page: int = 1, page_size: int = 50, q: str = "", _key: str = Depends(verify_api_key)):
    """Todas las series de Sonarr con estado de archivo y ruta (paginado)."""
    service = find_service("sonarr", "arr")
    if not service:
        return {"items": [], "total": 0, "page": page, "page_size": page_size}
    fetch_size = 0 if normalize_for_search(q) else page_size
    async with aiohttp.ClientSession() as session:
        result = await fetch_all_series_detailed(session, service, page, fetch_size)
    # A series card is marked by any episode grab of that series.
    return _attach_grabbed_at(
        _filter_all_endpoint(result, q, page, page_size), source="sonarr", kind="series"
    )


@router.get("/api/wanted/series/{series_id}/episodes")
async def get_series_episodes(series_id: int, _key: str = Depends(verify_api_key)):
    """Episodios de una serie, para enriquecer la navegación de "En carpeta"."""
    service = find_service("sonarr", "arr")
    if not service:
        return {"episodes": [], "error": service_unavailable_reason("sonarr")}
    async with aiohttp.ClientSession() as session:
        return await arr_series_episodes(session, service, series_id)


@router.post("/api/wanted/search")
async def search_wanted(req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Busca contenido faltante en los indexadores."""
    source = req.source
    service = find_service(source, "arr")
    if not service:
        return {"ok": False, "error": service_unavailable_reason(source)}

    async with aiohttp.ClientSession() as session:
        if source == "radarr":
            result = await arr_search_missing_movies(session, service)
        elif source == "sonarr":
            result = await arr_search_missing_episodes(session, service)
        else:
            return {"ok": False, "error": f"servicio no soportado: {source}"}

    return {"ok": result.get("ok", False), "detail": result.get("detail", ""), "source": source}


@router.post("/api/wanted/search/item")
async def search_wanted_item(req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Busca un item específico en los indexadores."""
    source = req.source
    service = find_service(source, "arr")
    if not service:
        return {"ok": False, "error": service_unavailable_reason(source)}

    ids = req.ids or {}
    async with aiohttp.ClientSession() as session:
        if source == "radarr" and ids.get("movie_id"):
            result = await arr_search_movie(session, service, ids["movie_id"])
        elif source == "sonarr" and ids.get("episode_id"):
            result = await arr_search_episode(session, service, ids["episode_id"])
        else:
            return {"ok": False, "error": "IDs insuficientes para búsqueda"}

    return {"ok": result.get("ok", False), "detail": result.get("detail", ""), "source": source}


# --- Wanted: Scan for misplaced files ---


def _normalize_title(name: str) -> str:
    """Normaliza un nombre de archivo para comparación fuzzy."""
    if not isinstance(name, str):
        name = str(name) if name else ""
    if not name:
        return ""
    # Quitar extensión
    name = re.sub(r'\.[a-zA-Z0-9]{2,4}$', '', name)
    # Reemplazar puntos y guiones bajos por espacios
    name = re.sub(r'[._]', ' ', name)
    # Quitar calidad: 1080p, 720p, 2160p, BluRay, WEB-DL, etc.
    name = re.sub(r'\b(2160p|1080p|720p|480p|4k|bluray|web-?dl|webrip|hdtv|dvdrip|h264|h265|x264|x265|hevc|aac|dts|ac3|remux)\b', '', name, flags=re.IGNORECASE)
    # Quitar year entre paréntesis o solo
    name = re.sub(r'[\(\[]?\d{4}[\)\]]?', '', name)
    # Quitar grupos de release
    name = re.sub(r'[-@][A-Za-z0-9]+$', '', name)
    # Normalizar unicode (quitar acentos)
    name = unicodedata.normalize('NFD', name)
    name = ''.join(c for c in name if unicodedata.category(c) != 'Mn')
    # Minúsculas y limpiar espacios
    name = name.lower().strip()
    name = re.sub(r'\s+', ' ', name)
    return name


def _match_score(filename: str, title: str) -> float:
    """Calcula similitud entre nombre de archivo y título. Retorna 0-1."""
    from difflib import SequenceMatcher
    norm_file = _normalize_title(filename)
    norm_title = _normalize_title(title)
    if not norm_file or not norm_title:
        return 0.0
    # Ratio básico
    ratio = SequenceMatcher(None, norm_file, norm_title).ratio()
    # Bonus si el título está contenido en el nombre del archivo
    if norm_title in norm_file:
        ratio = max(ratio, 0.85)
    # Bonus si el nombre del archivo está contenido en el título
    if norm_file in norm_title:
        ratio = max(ratio, 0.80)
    return round(ratio, 3)


def _validate_path(path: str) -> str:
    """Valida que la ruta esté dentro de los volúmenes permitidos."""
    if not path:
        return ""
    normalized = host_path(path)
    resolved = os.path.realpath(normalized)
    ALLOWED_ROOTS = ["/mnt/storage", "/mnt/storage-6tb"]
    for root in ALLOWED_ROOTS:
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
        async with aiohttp.ClientSession() as session:
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
            norm = _normalize_title(title)
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
        async with aiohttp.ClientSession() as session:
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
                norm = _normalize_title(title)
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

    # Escaneo recursivo de archivos de video
    video_exts = {'.mkv', '.mp4', '.avi', '.wmv', '.flv', '.mov', '.m4v', '.ts', '.mpg', '.mpeg'}
    scanned_files = 0
    matches = []

    for root, _dirs, files in os.walk(target):
        for fname in files:
            ext = os.path.splitext(fname)[1].lower()
            if ext not in video_exts:
                continue
            scanned_files += 1
            full_path = os.path.join(root, fname)

            best_score = 0.0
            best_match = None
            for norm_title, info in title_map.items():
                score = _match_score(fname, info["title_used"])
                if score > best_score:
                    best_score = score
                    best_match = info

            if best_match and best_score >= 0.5:
                target_path = best_match.get("movie_path", "")
                matches.append({
                    "file_path": full_path,
                    "file_name": fname,
                    "movie_id": best_match["movie_id"],
                    "movie_title": best_match["movie_title"],
                    "movie_year": best_match["movie_year"],
                    "target_path": target_path,
                    "score": best_score,
                    "matched_title": best_match["title_used"],
                })

    matches.sort(key=lambda m: m["score"], reverse=True)

    return {
        "ok": True,
        "matches": matches,
        "scanned_files": scanned_files,
        "item_title": item_title,
        "detail": f"Escaneados {scanned_files} archivos contra \"{item_title}\", {len(matches)} coincidencias",
    }
