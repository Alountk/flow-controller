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
    arr_search_missing_movies,
    arr_search_missing_episodes,
    arr_search_movie,
    arr_search_episode,
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
    """Escanea una carpeta buscando películas desubicadas."""
    source = req.source  # "radarr"
    folder_path = req.remote_path or ""
    languages_str = req.local_path or "en"  # comma-separated language codes
    languages = [l.strip() for l in languages_str.split(",") if l.strip()]

    if not folder_path:
        return {"ok": False, "detail": "Se requiere remote_path (carpeta a escanear)"}

    target = _validate_path(folder_path)
    if not os.path.isdir(target):
        return {"ok": False, "detail": f"No es un directorio: {target}"}

    # Obtener películas faltantes de Radarr
    service = next((s for s in SERVICES if s["key"] == source and s["kind"] == "arr"), None)
    if not service:
        return {"ok": False, "detail": "Servicio no encontrado"}

    wanted_movies = []
    async with aiohttp.ClientSession() as session:
        # Obtener todas las wanted movies (hasta 200)
        result = await fetch_wanted_movies(session, service, page=1, page_size=200)
        wanted_movies = result.get("items", [])

    if not wanted_movies:
        return {"ok": True, "matches": [], "scanned_files": 0, "detail": "No hay películas faltantes"}

    # Construir lista de títulos para buscar
    title_map = {}  # normalized_title -> {movie_id, movie_title, movie_path, language}
    for movie in wanted_movies:
        all_titles = [movie.get("title", "")]
        # Agregar altTitles filtrados por idioma
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
                    "title_used": title,
                }

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

            # Calcular score contra cada título
            best_score = 0.0
            best_match = None
            for norm_title, info in title_map.items():
                score = _match_score(fname, info["title_used"])
                if score > best_score:
                    best_score = score
                    best_match = info

            if best_match and best_score >= 0.5:
                matches.append({
                    "file_path": full_path,
                    "file_name": fname,
                    "movie_id": best_match["movie_id"],
                    "movie_title": best_match["movie_title"],
                    "movie_year": best_match["movie_year"],
                    "score": best_score,
                    "matched_title": best_match["title_used"],
                })

    # Ordenar por score descendente
    matches.sort(key=lambda m: m["score"], reverse=True)

    return {
        "ok": True,
        "matches": matches,
        "scanned_files": scanned_files,
        "total_wanted": len(wanted_movies),
        "detail": f"Escaneados {scanned_files} archivos, {len(matches)} coincidencias",
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

        try:
            src = op["src"]
            dst = op["dst"]
            if op["type"] == "copy":
                src_path = Path(src)
                if src_path.is_dir():
                    await asyncio.to_thread(shutil.copytree, src, dst)
                else:
                    await asyncio.to_thread(shutil.copy2, src, dst)
            else:
                await asyncio.to_thread(shutil.move, src, dst)
            async with _queue_lock:
                op["status"] = "done"
                op["detail"] = f"Completado: {Path(src).name}"
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
            }
            for o in _file_queue
            if o["status"] in ("done", "failed")
        ]
    return {"queue": ops, "completed": completed[-10:], "running": _queue_consumer_task is not None and not _queue_consumer_task.done()}


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
