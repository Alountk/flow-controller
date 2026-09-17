import asyncio
import logging
import os
import shutil
import time
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
    return {"developer": DEVELOPER}


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
