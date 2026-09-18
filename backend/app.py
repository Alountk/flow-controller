import asyncio
import logging
import os
import re
import shutil
import time
import unicodedata
from contextlib import asynccontextmanager
from pathlib import Path

import aiohttp
from fastapi import FastAPI, Header, HTTPException, Depends
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config import (
    ACTIONS,
    AMUTORRENT_INDEXER,
    BASE_DIR,
    CHECK_INTERVAL,
    DEVELOPER,
    FRONTEND_DIST,
    SAFE_MODE,
    SERVICES,
    API_KEY,
)
from traces import build_traces
from clients import (
    check_service,
    check_arr,
    arr_command,
    fetch_wanted_movies,
    fetch_wanted_episodes,
    fetch_all_movies_detailed,
    fetch_all_series_detailed,
    fetch_radarr_calendar,
    fetch_sonarr_calendar,
    arr_search_missing_movies,
    arr_search_missing_episodes,
    arr_search_movie,
    arr_search_episode,
    arr_add_movie,
    arr_add_series,
    arr_fetch_releases,
    arr_grab_release,
    arr_movie_metadata,
    arr_series_metadata,
    arr_manual_import,
    arr_refresh_movie,
    arr_rescan_movie,
    arr_downloaded_scan,
)
from copy_engine import (
    _tasks,
    cleanup_tasks,
    do_action,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("flow-controller")

# Shared mutable state
status_cache: dict = {
    "radarr": "unknown",
    "sonarr": "unknown",
    "amutorrent": "unknown",
    "flow": "unknown",
    "updated_at": 0,
    "checking": False,
}

_http_session: aiohttp.ClientSession | None = None


async def verify_api_key(x_api_key: str | None = Header(default=None)):
    if not API_KEY:
        return
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="API key inválida")


class ActionRequest(BaseModel):
    source: str = ""
    download_id: str = ""
    matched_hash: str = ""
    ids: dict = {}
    output_path: str = ""
    blocklist: bool | None = None
    delete_files: bool | None = None
    host: str = ""
    remote_path: str = ""
    local_path: str = ""


class CalendarSearchRequest(BaseModel):
    source: str  # "radarr" or "sonarr"
    type: str  # "movie" or "episode"
    id: int  # Radarr movie ID or Sonarr episode ID


class CalendarAddRequest(BaseModel):
    source: str  # "radarr" or "sonarr"
    type: str  # "movie" or "episode"
    title: str
    year: int | None = None


class CalendarReleasesRequest(BaseModel):
    source: str  # "radarr" or "sonarr"
    type: str  # "movie" or "episode"
    id: int  # Radarr movie ID or Sonarr episode ID


class CalendarGrabRequest(BaseModel):
    source: str  # "radarr" or "sonarr"
    guid: str


async def check_all(session: aiohttp.ClientSession) -> None:
    status_cache["checking"] = True
    try:
        results = await asyncio.gather(*(check_service(session, s) for s in SERVICES))
        flow_ok = True
        for service, (state, reason, meta) in zip(SERVICES, results):
            status_cache[service["key"]] = f"{state}:{reason}"
            if meta:
                status_cache[f"{service['key']}_meta"] = meta
            if state != "online":
                flow_ok = False
        status_cache["flow"] = "running" if flow_ok else "stopped"
        status_cache["updated_at"] = int(time.time())
    finally:
        status_cache["checking"] = False


async def background_checker() -> None:
    async with aiohttp.ClientSession() as session:
        while True:
            try:
                await check_all(session)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                status_cache["flow"] = f"error:{exc}"
            await asyncio.sleep(CHECK_INTERVAL)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _http_session
    _http_session = aiohttp.ClientSession()
    task = asyncio.create_task(background_checker())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        await _http_session.close()


app = FastAPI(lifespan=lifespan)


# --- API Routes ---

@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/status")
async def get_status():
    return status_cache


@app.get("/api/status/refresh")
async def refresh_status():
    async with aiohttp.ClientSession() as session:
        await check_all(session)
    return status_cache


@app.get("/api/trace")
async def get_trace():
    async with aiohttp.ClientSession() as session:
        traces = await build_traces(session)
    summary = {
        "downloading": sum(1 for t in traces if t["stage"] == "downloading"),
        "downloaded": sum(1 for t in traces if t["stage"] == "downloaded"),
        "import_blocked": sum(1 for t in traces if t["stage"] == "import_blocked"),
        "failed": sum(1 for t in traces if t["stage"] == "failed"),
        "sent": sum(1 for t in traces if t["stage"] == "sent"),
        "category_mismatches": sum(
            1 for t in traces if t.get("category_ok") is False
        ),
    }
    return {
        "traces": traces,
        "summary": summary,
        "indexer": AMUTORRENT_INDEXER,
        "updated_at": int(time.time()),
    }


@app.get("/api/wanted")
async def get_wanted(page: int = 1, page_size: int = 50):
    """Contenido faltante (wanted/missing) de Radarr y Sonarr."""
    async with aiohttp.ClientSession() as session:
        arr_services = [s for s in SERVICES if s["kind"] == "arr"]
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
    return {
        "wanted": wanted,
        "updated_at": int(time.time()),
    }


@app.get("/api/wanted/all")
async def get_all_movies():
    """Todas las películas de Radarr con estado de archivo y ruta."""
    service = next((s for s in SERVICES if s["key"] == "radarr" and s["kind"] == "arr"), None)
    if not service:
        return {"items": [], "total": 0}
    async with aiohttp.ClientSession() as session:
        result = await fetch_all_movies_detailed(session, service)
    return result


@app.get("/api/wanted/series/all")
async def get_all_series():
    """Todas las series de Sonarr con estado de archivo y ruta."""
    service = next((s for s in SERVICES if s["key"] == "sonarr" and s["kind"] == "arr"), None)
    if not service:
        return {"items": [], "total": 0}
    async with aiohttp.ClientSession() as session:
        result = await fetch_all_series_detailed(session, service)
    return result


@app.get("/api/calendar")
async def get_calendar(start: str = "", end: str = ""):
    """Calendario de próximos episodios y películas."""
    from datetime import date, timedelta
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


@app.post("/api/calendar/search")
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


@app.post("/api/calendar/add")
async def calendar_add(req: CalendarAddRequest, _key: str = Depends(verify_api_key)):
    """Agrega una película/serie a Radarr/Sonarr y lanza búsqueda."""
    service = next((s for s in SERVICES if s["key"] == req.source and s["kind"] == "arr"), None)
    if not service:
        return {"ok": False, "id": None, "detail": f"Servicio desconocido: {req.source}"}

    async with aiohttp.ClientSession() as session:
        if req.type == "movie":
            movie_payload = {
                "title": req.title,
                "year": req.year or 0,
                "qualityProfileId": 1,
                "rootFolderPath": "/mnt/storage-6tb/shared-downloads/amule",
                "monitored": True,
            }
            add_result = await arr_add_movie(session, service, movie_payload)
            if add_result.get("ok") and add_result.get("id"):
                search_result = await arr_search_movie(session, service, add_result["id"])
                return {
                    "ok": True,
                    "id": add_result["id"],
                    "detail": f"Película agregada y búsqueda lanzada",
                }
            return {"ok": False, "id": None, "detail": add_result.get("detail", "Error desconocido")}

        elif req.type == "episode":
            series_payload = {
                "title": req.title,
                "year": req.year or 0,
                "qualityProfileId": 1,
                "rootFolderPath": "/mnt/storage-6tb/shared-downloads/amule",
                "monitored": True,
                "seasonFolder": True,
            }
            add_result = await arr_add_series(session, service, series_payload)
            if add_result.get("ok") and add_result.get("id"):
                return {
                    "ok": True,
                    "id": add_result["id"],
                    "detail": f"Serie agregada a Sonarr",
                }
            return {"ok": False, "id": None, "detail": add_result.get("detail", "Error desconocido")}

        else:
            return {"ok": False, "id": None, "detail": f"Tipo desconocido: {req.type}"}


@app.post("/api/calendar/releases")
async def calendar_releases(req: CalendarReleasesRequest, _key: str = Depends(verify_api_key)):
    """Obtiene releases disponibles para un movie/episode."""
    service = next((s for s in SERVICES if s["key"] == req.source and s["kind"] == "arr"), None)
    if not service:
        return {"releases": [], "detail": f"Servicio desconocido: {req.source}"}

    async with aiohttp.ClientSession() as session:
        if req.type == "movie":
            result = await arr_fetch_releases(session, service, movie_id=req.id)
        elif req.type == "episode":
            result = await arr_fetch_releases(session, service, episode_id=req.id)
        else:
            return {"releases": [], "detail": f"Tipo desconocido: {req.type}"}

    return result


@app.post("/api/calendar/grab")
async def calendar_grab(req: CalendarGrabRequest, _key: str = Depends(verify_api_key)):
    """Descarga un release específico."""
    service = next((s for s in SERVICES if s["key"] == req.source and s["kind"] == "arr"), None)
    if not service:
        return {"ok": False, "detail": f"Servicio desconocido: {req.source}"}

    async with aiohttp.ClientSession() as session:
        result = await arr_grab_release(session, service, req.guid)

    return result


@app.get("/api/disk")
async def get_disk_usage():
    """Uso de disco de cada volumen configurado."""
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


@app.post("/api/wanted/search")
async def search_wanted(req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Busca contenido faltante en los indexadores."""
    source = req.source
    service = next((s for s in SERVICES if s["key"] == source and s["kind"] == "arr"), None)
    if not service:
        return {"ok": False, "error": "servicio desconocido"}

    async with aiohttp.ClientSession() as session:
        if source == "radarr":
            result = await arr_search_missing_movies(session, service)
        elif source == "sonarr":
            result = await arr_search_missing_episodes(session, service)
        else:
            return {"ok": False, "error": f"servicio no soportado: {source}"}

    return {"ok": result.get("ok", False), "detail": result.get("detail", ""), "source": source}


@app.post("/api/wanted/search/item")
async def search_wanted_item(req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Busca un item específico en los indexadores."""
    source = req.source
    service = next((s for s in SERVICES if s["key"] == source and s["kind"] == "arr"), None)
    if not service:
        return {"ok": False, "error": "servicio desconocido"}

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


def _detect_languages_from_alt_titles(alt_titles: list) -> list[str]:
    """Detecta idiomas disponibles de los títulos alternativos usando prefijos comunes."""
    # Mapeo de prefijos de idioma comunes en títulos
    lang_prefixes = {
        "es": "Español", "en": "English", "fr": "Français", "de": "Deutsch",
        "it": "Italiano", "pt": "Português", "ja": "日本語", "ko": "한국어",
        "zh": "中文", "ru": "Русский", "pl": "Polski", "nl": "Nederlands",
        "sv": "Svenska", "da": "Dansk", "no": "Norsk", "fi": "Suomi",
        "tr": "Türkçe", "ar": "العربية", "hi": "हिन्दी", "th": "ไทย",
        "cs": "Čeština", "el": "Ελληνικά", "hu": "Magyar", "ro": "Română",
        "uk": "Українська", "vi": "Tiếng Việt", "id": "Bahasa Indonesia",
    }
    # Por ahora, devolver los prefijos únicos de los títulos
    # En una futura versión se podría usar un library de detección de idioma
    return sorted(set(lang_prefixes.keys()))


def _get_wanted_movies_with_alt_titles(wanted_data: dict) -> list[dict]:
    """Extrae películas faltantes con sus títulos alternativos."""
    radarr = wanted_data.get("wanted", {}).get("radarr", {})
    return radarr.get("items", [])


@app.post("/api/wanted/scan")
async def scan_for_movies(req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Escanea una carpeta buscando una película o serie específica desubicada."""
    source = req.source  # "radarr" o "sonarr"
    folder_path = req.remote_path or ""
    languages_str = req.local_path or "en"
    languages = [l.strip() for l in languages_str.split(",") if l.strip()]
    ids = req.ids or {}
    movie_id = ids.get("movie_id")
    series_id = ids.get("series_id")

    custom_title = ids.get("custom_title", "").strip()

    if not folder_path:
        return {"ok": False, "detail": "Se requiere remote_path (carpeta a escanear)"}

    target = _validate_path(folder_path)
    if not os.path.isdir(target):
        return {"ok": False, "detail": f"No es un directorio: {target}"}

    service = next((s for s in SERVICES if s["key"] == source and s["kind"] == "arr"), None)
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
                movie_path = meta.get("path", "")
                all_titles = [item_title] + [t for t in meta.get("altTitles", []) if t]
            elif series_id:
                meta = await arr_series_metadata(session, service, int(series_id))
                if not meta:
                    return {"ok": False, "detail": "Serie no encontrada"}
                item_title = meta.get("title", "")
                item_year = None
                movie_path = meta.get("path", "")
                all_titles = [item_title] + [t for t in meta.get("alternateTitles", []) if t]
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
                all_titles.append(alt)
            for title in all_titles:
                if not title:
                    continue
                norm = _normalize_title(title)
                if norm and norm not in title_map:
                    title_map[norm] = {
                        "movie_id": movie.get("id"),
                        "movie_title": movie.get("title", ""),
                        "movie_year": movie.get("year"),
                        "movie_path": movie.get("path", ""),
                        "title_used": title,
                    }
        item_title = f"{len(wanted_movies)} películas faltantes"
        item_year = None

    # Escaneo recursivo de archivos de video
    video_exts = {'.mkv', '.mp4', '.avi', '.wmv', '.flv', '.mov', '.m4v', '.ts', '.mpg', '.mpeg'}
    scanned_files = 0
    matches = []

    for root, dirs, files in os.walk(target):
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


# --- File Manager ---

ALLOWED_ROOTS = ["/mnt/storage", "/mnt/storage-6tb"]


def _validate_path(path: str) -> str:
    """Valida que la ruta esté dentro de los volúmenes permitidos."""
    resolved = os.path.realpath(path)
    for root in ALLOWED_ROOTS:
        if resolved == root or resolved.startswith(root + "/"):
            return resolved
    raise HTTPException(status_code=403, detail=f"Ruta no permitida: {path}")


def _file_entry(p: Path) -> dict:
    """Construye la información de un archivo/directorio."""
    stat = p.stat()
    is_dir = p.is_dir()
    return {
        "name": p.name,
        "path": str(p),
        "is_dir": is_dir,
        "size": 0 if is_dir else stat.st_size,
        "modified": int(stat.st_mtime),
    }


@app.get("/api/files/roots")
async def file_roots():
    """Devuelve las raíces de navegación disponibles."""
    roots = []
    for root in ALLOWED_ROOTS:
        if os.path.isdir(root):
            roots.append({"path": root, "name": os.path.basename(root) or root})
    return {"roots": roots}


@app.get("/api/files/browse")
async def file_browse(path: str = "/"):
    """Lista el contenido de un directorio."""
    target = _validate_path(path)
    if not os.path.isdir(target):
        return {"ok": False, "error": "No es un directorio", "items": [], "path": target}
    try:
        entries = sorted(Path(target).iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        items = [_file_entry(p) for p in entries]
        return {"ok": True, "items": items, "path": target}
    except PermissionError:
        return {"ok": False, "error": "Sin permisos de lectura", "items": [], "path": target}


@app.post("/api/files/mkdir")
async def file_mkdir(req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Crea un directorio."""
    target = _validate_path(req.remote_path or "")
    try:
        Path(target).mkdir(parents=True, exist_ok=True)
        return {"ok": True, "detail": f"Directorio creado: {target}"}
    except Exception as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


@app.post("/api/files/rename")
async def file_rename(req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Renombra un archivo o directorio."""
    src = _validate_path(req.remote_path or "")
    dst = _validate_path(req.local_path or "")
    try:
        os.rename(src, dst)
        return {"ok": True, "detail": f"Renombrado: {Path(src).name} → {Path(dst).name}"}
    except Exception as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


@app.post("/api/files/move")
async def file_move(req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Mueve un archivo o directorio."""
    src = _validate_path(req.remote_path or "")
    dst = _validate_path(req.local_path or "")
    try:
        shutil.move(src, dst)
        return {"ok": True, "detail": f"Movido: {Path(src).name} → {dst}"}
    except Exception as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


@app.post("/api/files/delete")
async def file_delete(req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Elimina un archivo o directorio."""
    target = _validate_path(req.remote_path or "")
    try:
        p = Path(target)
        if p.is_dir():
            shutil.rmtree(p)
        else:
            p.unlink()
        return {"ok": True, "detail": f"Eliminado: {p.name}"}
    except Exception as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


# --- File Manager: Copy + Queue ---


@app.post("/api/files/copy")
async def file_copy(req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Copia un archivo o directorio."""
    src = _validate_path(req.remote_path or "")
    dst = _validate_path(req.local_path or "")
    try:
        src_path = Path(src)
        if src_path.is_dir():
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
        return {"ok": True, "detail": f"Copiado: {src_path.name} → {dst}"}
    except Exception as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


_file_queue: list[dict] = []
_queue_lock = asyncio.Lock()
_queue_consumer_task: asyncio.Task | None = None

CHUNK_SIZE = 1024 * 1024  # 1MB


def _copy_with_progress(src: str, dst: str, op: dict) -> None:
    """Copia un archivo con progreso, actualizando op en un dict compartido."""
    src_path = Path(src)
    if src_path.is_dir():
        shutil.copytree(src, dst)
        return
    total = src_path.stat().st_size
    op["total_bytes"] = total
    op["copied_bytes"] = 0
    with open(src, "rb") as fin, open(dst, "wb") as fout:
        while True:
            if op.get("cancelled"):
                fout.close()
                os.remove(dst)
                raise InterruptedError("Cancelado por el usuario")
            chunk = fin.read(CHUNK_SIZE)
            if not chunk:
                break
            fout.write(chunk)
            op["copied_bytes"] += len(chunk)
            op["progress"] = round(op["copied_bytes"] / total * 100) if total else 100


def _copytree_with_progress(src: str, dst: str, op: dict) -> None:
    """Copia un directorio con progreso por archivos."""
    src_path = Path(src)
    all_files = [f for f in src_path.rglob("*") if f.is_file()]
    total_files = len(all_files)
    op["files_total"] = total_files
    op["files_done"] = 0
    op["total_bytes"] = sum(f.stat().st_size for f in all_files)
    op["copied_bytes"] = 0
    shutil.copytree(src, dst)
    op["files_done"] = total_files
    op["copied_bytes"] = op["total_bytes"]
    op["progress"] = 100


async def _consume_queue():
    """Ejecuta operaciones de la cola secuencialmente."""
    global _queue_consumer_task
    while True:
        async with _queue_lock:
            pending = [op for op in _file_queue if op["status"] == "pending"]
            if not pending:
                _queue_consumer_task = None
                return
            op = pending[0]
            op["status"] = "running"
            op["started_at"] = time.time()
            op["progress"] = 0
            op["copied_bytes"] = 0
            op["total_bytes"] = 0
            op["files_done"] = 0
            op["files_total"] = 0

        try:
            src = op["src"]
            dst = op["dst"]
            if op["type"] == "copy":
                src_path = Path(src)
                if src_path.is_dir():
                    await asyncio.to_thread(_copytree_with_progress, src, dst, op)
                else:
                    await asyncio.to_thread(_copy_with_progress, src, dst, op)
            else:
                # Move: try os.rename first (instant on same filesystem),
                # fall back to copy + delete for cross-filesystem
                src_path = Path(src)
                try:
                    # Ensure parent directory of dst exists
                    dst_parent = Path(dst).parent
                    if not dst_parent.exists():
                        await asyncio.to_thread(dst_parent.mkdir, parents=True, exist_ok=True)
                    await asyncio.to_thread(os.rename, src, dst)
                except OSError:
                    # Cross-filesystem or other OS error: copy + delete
                    if src_path.is_dir():
                        await asyncio.to_thread(_copytree_with_progress, src, dst, op)
                    else:
                        await asyncio.to_thread(_copy_with_progress, src, dst, op)
                    if not op.get("cancelled"):
                        await asyncio.to_thread(shutil.rmtree if src_path.is_dir() else os.remove, src)
            async with _queue_lock:
                if op.get("cancelled"):
                    op["status"] = "cancelled"
                    op["detail"] = "Cancelado por el usuario"
                else:
                    op["status"] = "done"
                    op["progress"] = 100
                    op["detail"] = f"Completado: {Path(src).name}"

            # Post-move import: tell Radarr/Sonarr to import the moved file
            if not op.get("cancelled") and op.get("arr_source"):
                service = next(
                    (s for s in SERVICES if s["key"] == op["arr_source"] and s["kind"] == "arr"),
                    None,
                )
                if service:
                    async with _queue_lock:
                        op["import_status"] = "importing"
                    try:
                        async with aiohttp.ClientSession() as session:
                            imported = False
                            movie_id = op.get("movie_id")

                            # Strategy 1: Manual Import (most reliable, needs movie_id)
                            if movie_id:
                                log.info("Trying manual import: dst=%s movie_id=%s", dst, movie_id)
                                result = await arr_manual_import(session, service, dst, int(movie_id))
                                log.info("Manual import result: %s", result)
                                if result.get("ok"):
                                    imported = True

                            # Strategy 2: RescanMovie (scan only this movie's folder)
                            if movie_id:
                                log.info("Trying RescanMovie: movie_id=%s", movie_id)
                                result = await arr_rescan_movie(session, service, int(movie_id))
                                log.info("RescanMovie result: %s", result)
                                if result.get("ok"):
                                    imported = True

                            async with _queue_lock:
                                op["import_status"] = "imported" if imported else "import_failed"
                                op["detail"] = (
                                    f"Completado + importado: {Path(src).name}"
                                    if imported
                                    else f"Movido (import pendiente): {Path(src).name}"
                                )
                    except Exception as exc:
                        log.error("Import failed: %s", exc)
                        async with _queue_lock:
                            op["import_status"] = "import_failed"
        except InterruptedError:
            async with _queue_lock:
                op["status"] = "cancelled"
                op["detail"] = "Cancelado por el usuario"
        except Exception as exc:
            async with _queue_lock:
                op["status"] = "failed"
                op["detail"] = f"{type(exc).__name__}: {exc}"


@app.post("/api/files/queue/add")
async def queue_add(req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Agrega una operación de copy/move a la cola."""
    global _queue_consumer_task
    op_type = req.source  # "copy" o "move"
    if op_type not in ("copy", "move"):
        return {"ok": False, "detail": "source debe ser 'copy' o 'move'"}
    src = _validate_path(req.remote_path or "")
    dst = _validate_path(req.local_path or "")
    if not src or not dst:
        return {"ok": False, "detail": "Se requieren remote_path y local_path"}

    op = {
        "id": str(int(time.time() * 1000)),
        "type": op_type,
        "src": src,
        "dst": dst,
        "name": Path(src).name,
        "status": "pending",
        "created_at": time.time(),
        "started_at": None,
        "detail": None,
        "progress": 0,
        "copied_bytes": 0,
        "total_bytes": 0,
        "files_done": 0,
        "files_total": 0,
        "cancelled": False,
        "arr_source": req.host or "",
        "movie_id": (req.ids or {}).get("movie_id"),
        "series_id": (req.ids or {}).get("series_id"),
    }
    async with _queue_lock:
        _file_queue.append(op)
        # Limpiar operaciones antiguas completadas (>50 en cola)
        if len(_file_queue) > 50:
            _file_queue[:] = [o for o in _file_queue if o["status"] in ("pending", "running")]

    if _queue_consumer_task is None or _queue_consumer_task.done():
        _queue_consumer_task = asyncio.create_task(_consume_queue())

    return {"ok": True, "detail": f"Agregado a la cola: {op['name']}", "op": op}


@app.get("/api/files/queue/status")
async def queue_status():
    """Estado actual de la cola de operaciones."""
    async with _queue_lock:
        ops = [
            {
                "id": o["id"],
                "type": o["type"],
                "name": o["name"],
                "src": o["src"],
                "dst": o["dst"],
                "status": o["status"],
                "detail": o["detail"],
                "progress": o.get("progress", 0),
                "copied_bytes": o.get("copied_bytes", 0),
                "total_bytes": o.get("total_bytes", 0),
                "files_done": o.get("files_done", 0),
                "files_total": o.get("files_total", 0),
                "import_status": o.get("import_status", ""),
            }
            for o in _file_queue
            if o["status"] in ("pending", "running")
        ]
        completed = [
            {
                "id": o["id"],
                "type": o["type"],
                "name": o["name"],
                "status": o["status"],
                "detail": o["detail"],
                "progress": o.get("progress", 0),
                "import_status": o.get("import_status", ""),
            }
            for o in _file_queue
            if o["status"] in ("done", "failed", "cancelled")
        ]
    return {"queue": ops, "completed": completed[-10:], "running": _queue_consumer_task is not None and not _queue_consumer_task.done()}


@app.post("/api/files/queue/cancel/{op_id}")
async def queue_cancel(op_id: str, _key: str = Depends(verify_api_key)):
    """Cancela una operación en la cola."""
    async with _queue_lock:
        for op in _file_queue:
            if op["id"] == op_id:
                if op["status"] == "pending":
                    op["status"] = "cancelled"
                    op["detail"] = "Cancelado por el usuario"
                    return {"ok": True, "detail": "Operación cancelada"}
                elif op["status"] == "running":
                    op["cancelled"] = True
                    return {"ok": True, "detail": "Cancelación en progreso..."}
                else:
                    return {"ok": False, "detail": f"Operación en estado: {op['status']}"}
    return {"ok": False, "detail": "Operación no encontrada"}


@app.get("/api/actions")
async def list_actions():
    return {
        "actions": [
            {"key": k, **v} for k, v in ACTIONS.items()
        ],
        "safe_mode": SAFE_MODE,
        "available": sorted(ACTIONS.keys()),
    }


@app.post("/api/actions/{action}")
async def run_action(action: str, req: ActionRequest, _key: str = Depends(verify_api_key)):
    if action not in ACTIONS:
        return {"ok": False, "error": f"acción desconocida: {action}"}

    meta = ACTIONS[action]
    if SAFE_MODE and meta["destructive"]:
        return {
            "ok": False,
            "error": (
                f"'{meta['label']}' es destructiva y el modo seguro está activo "
                "(SAFE_MODE=true). Desactívalo en backend/.env para habilitarla."
            ),
            "safe_mode": True,
        }

    payload = req.model_dump()
    result = await do_action(_http_session, action, payload)

    return {
        "action": action,
        "label": meta["label"],
        "destructive": meta["destructive"],
        **result,
        "at": int(time.time()),
    }


@app.get("/api/tasks/{task_id}")
async def get_task(task_id: str, _key: str = Depends(verify_api_key)):
    cleanup_tasks()
    task = _tasks.get(task_id)
    if not task:
        return {"ok": False, "error": "tarea no encontrada"}
    return {"ok": True, **task}


@app.post("/api/tasks/{task_id}/cancel")
async def cancel_task(task_id: str, _key: str = Depends(verify_api_key)):
    task = _tasks.get(task_id)
    if not task:
        return {"ok": False, "error": "tarea no encontrada"}
    if task.get("status") not in ("running", None):
        return {"ok": False, "error": f"tarea ya en estado: {task['status']}"}
    task["cancelled"] = True
    task["detail"] = "cancelación solicitada..."
    log.info("copy_files: cancelación solicitada para task %s", task_id)
    return {"ok": True}


@app.get("/api/config")
async def config():
    return {"developer": DEVELOPER, "api_key": API_KEY}


# --- Settings ---

from settings import get_settings, save_settings

RESTART_REQUIRED_FIELDS = {
    "services.radarr.url", "services.radarr.api_key",
    "services.sonarr.url", "services.sonarr.api_key",
    "services.amutorrent.url", "services.amutorrent.api_key",
    "services.amutorrent.user", "services.amutorrent.password",
    "security.api_key", "server.port",
}


def _mask_secrets(data: dict) -> dict:
    import copy
    masked = copy.deepcopy(data)
    for svc in ("radarr", "sonarr", "amutorrent"):
        key = masked.get("services", {}).get(svc, {}).get("api_key", "")
        if key:
            masked["services"][svc]["api_key"] = "****" + key[-4:] if len(key) > 4 else "****"
    ak = masked.get("security", {}).get("api_key", "")
    if ak:
        masked["security"]["api_key"] = "****" + ak[-4:] if len(ak) > 4 else "****"
    pw = masked.get("services", {}).get("amutorrent", {}).get("password", "")
    if pw:
        masked["services"]["amutorrent"]["password"] = "****"
    return masked


@app.get("/api/settings")
async def get_settings_endpoint(_key: str = Depends(verify_api_key)):
    return _mask_secrets(get_settings())


@app.post("/api/settings")
async def save_settings_endpoint(body: dict, _key: str = Depends(verify_api_key)):
    save_settings(body)
    restart_needed = []
    def _check(data: dict, prefix: str = "") -> None:
        for k, v in data.items():
            path = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict):
                _check(v, path)
            elif path in RESTART_REQUIRED_FIELDS:
                restart_needed.append(path)
    _check(body)
    return {"ok": True, "restart_required": restart_needed}


# --- Prototypes ---

PROTOTYPES_DIR = os.path.normpath(os.path.join(BASE_DIR, "..", "prototypes"))


@app.get("/api/prototypes")
async def list_prototypes():
    if not os.path.isdir(PROTOTYPES_DIR):
        return []
    files = sorted(
        f for f in os.listdir(PROTOTYPES_DIR) if f.endswith(".html")
    )
    return [
        {"name": f.removesuffix(".html"), "file": f}
        for f in files
    ]


# --- Static files ---

if os.path.isdir(FRONTEND_DIST):
    assets_dir = os.path.join(FRONTEND_DIST, "assets")
    if os.path.isdir(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

if os.path.isdir(PROTOTYPES_DIR):
    app.mount("/prototypes", StaticFiles(directory=PROTOTYPES_DIR), name="prototypes")


@app.get("/")
async def root():
    index = os.path.join(FRONTEND_DIST, "index.html")
    if os.path.isfile(index):
        return FileResponse(index)
    return {"detail": "Frontend no compilado. Ejecuta: cd frontend && npm run build"}


@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    if full_path.startswith("api/"):
        return {"detail": "Not Found"}
    if full_path.startswith("prototypes/"):
        return {"detail": "Not Found"}
    candidate = os.path.normpath(os.path.join(FRONTEND_DIST, full_path))
    if candidate.startswith(FRONTEND_DIST) and os.path.isfile(candidate):
        return FileResponse(candidate)
    return FileResponse(os.path.join(FRONTEND_DIST, "index.html"))
