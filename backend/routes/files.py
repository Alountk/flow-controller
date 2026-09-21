"""File browser, queue, copy/move routes."""

import asyncio
import logging
import os
import shutil
import time
from pathlib import Path

import aiohttp
from fastapi import APIRouter, Depends, HTTPException

import state
from config import SERVICES
from traces import host_path
import history
from import_service import post_move_import
from models import ActionRequest
from routes.status import verify_api_key
from state import file_queue, queue_lock

log = logging.getLogger("flow-controller")
router = APIRouter()

ALLOWED_ROOTS = ["/mnt/storage", "/mnt/storage-6tb"]
CHUNK_SIZE = 1024 * 1024  # 1MB


def _validate_path(path: str) -> str:
    """Valida que la ruta esté dentro de los volúmenes permitidos."""
    if not path:
        return ""
    normalized = host_path(path)
    resolved = os.path.realpath(normalized)
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


# ── File Manager ──────────────────────────────────────────────────────────────

@router.get("/api/files/roots")
async def file_roots(_key: str = Depends(verify_api_key)):
    """Devuelve las raíces de navegación disponibles."""
    roots = []
    for root in ALLOWED_ROOTS:
        if os.path.isdir(root):
            roots.append({"path": root, "name": os.path.basename(root) or root})
    return {"roots": roots}


@router.get("/api/files/browse")
async def file_browse(path: str = "/", _key: str = Depends(verify_api_key)):
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


@router.post("/api/files/mkdir")
async def file_mkdir(req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Crea un directorio."""
    target = _validate_path(req.remote_path or "")
    try:
        Path(target).mkdir(parents=True, exist_ok=True)
        return {"ok": True, "detail": f"Directorio creado: {target}"}
    except Exception as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


@router.post("/api/files/rename")
async def file_rename(req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Renombra un archivo o directorio."""
    src = _validate_path(req.remote_path or "")
    dst = _validate_path(req.local_path or "")
    try:
        os.rename(src, dst)
        return {"ok": True, "detail": f"Renombrado: {Path(src).name} → {Path(dst).name}"}
    except Exception as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


@router.post("/api/files/move")
async def file_move(req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Mueve un archivo o directorio."""
    src = _validate_path(req.remote_path or "")
    dst = _validate_path(req.local_path or "")
    try:
        shutil.move(src, dst)
        return {"ok": True, "detail": f"Movido: {Path(src).name} → {dst}"}
    except Exception as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


@router.post("/api/files/delete")
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


@router.post("/api/files/copy")
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


# ── Copy + Queue ──────────────────────────────────────────────────────────────

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
    while True:
        async with queue_lock:
            pending = [op for op in file_queue if op["status"] == "pending"]
            if not pending:
                return
            op = pending[0]
            op["status"] = "running"
            op["started_at"] = time.time()
            op["progress"] = 0
            op["copied_bytes"] = 0
            op["total_bytes"] = 0
            op["files_done"] = 0
            op["files_total"] = 0

        await asyncio.to_thread(history.record_operation, op)

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
                src_path = Path(src)
                try:
                    dst_parent = Path(dst).parent
                    if not dst_parent.exists():
                        await asyncio.to_thread(dst_parent.mkdir, parents=True, exist_ok=True)
                    await asyncio.to_thread(os.rename, src, dst)
                except OSError:
                    if src_path.is_dir():
                        await asyncio.to_thread(_copytree_with_progress, src, dst, op)
                    else:
                        await asyncio.to_thread(_copy_with_progress, src, dst, op)
                    if not op.get("cancelled"):
                        await asyncio.to_thread(shutil.rmtree if src_path.is_dir() else os.remove, src)
            async with queue_lock:
                if op.get("cancelled"):
                    op["status"] = "cancelled"
                    op["detail"] = "Cancelado por el usuario"
                else:
                    op["status"] = "done"
                    op["progress"] = 100
                    op["detail"] = f"Completado: {Path(src).name}"

            await asyncio.to_thread(history.record_operation, op)

            # Post-move import: tell Radarr/Sonarr to import the moved file
            if not op.get("cancelled") and op.get("arr_source"):
                service = next(
                    (s for s in SERVICES if s["key"] == op["arr_source"] and s["kind"] == "arr"),
                    None,
                )
                if service:
                    async with queue_lock:
                        op["import_status"] = "importing"
                    try:
                        async with aiohttp.ClientSession() as session:
                            movie_id = int(op["movie_id"]) if op.get("movie_id") else None
                            series_id = int(op.get("series_id") or op.get("movie_id")) if (op.get("series_id") or (service["key"] == "sonarr" and op.get("movie_id"))) else None
                            res = await post_move_import(
                                session,
                                service,
                                dst,
                                movie_id=movie_id,
                                series_id=series_id,
                            )
                            imported = res.get("imported", False)
                            async with queue_lock:
                                op["import_status"] = "imported" if imported else "import_failed"
                                op["detail"] = (
                                    f"Completado + importado: {Path(src).name}"
                                    if imported
                                    else f"Movido (import pendiente): {Path(src).name}"
                                )
                            await asyncio.to_thread(history.record_operation, op)
                    except Exception as exc:
                        log.error("Import failed: %s", exc)
                        async with queue_lock:
                            op["import_status"] = "import_failed"
        except InterruptedError:
            async with queue_lock:
                op["status"] = "cancelled"
                op["detail"] = "Cancelado por el usuario"
        except Exception as exc:
            async with queue_lock:
                op["status"] = "failed"
                op["detail"] = f"{type(exc).__name__}: {exc}"
            await asyncio.to_thread(history.record_operation, op)


@router.post("/api/files/queue/add")
async def queue_add(req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Agrega una operación de copy/move a la cola."""
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
    async with queue_lock:
        file_queue.append(op)
        if len(file_queue) > 50:
            file_queue[:] = [o for o in file_queue if o["status"] in ("pending", "running")]

    # Durable from the moment it is accepted, so a restart still shows it.
    await asyncio.to_thread(history.record_operation, op)

    # Hold a reference on the shared state object: an unreferenced asyncio task
    # may be garbage-collected mid-execution, silently aborting the queue.
    state.queue_consumer_task = asyncio.create_task(_consume_queue())

    return {"ok": True, "detail": f"Agregado a la cola: {op['name']}", "op": op}


@router.get("/api/files/queue/status")
async def queue_status(_key: str = Depends(verify_api_key)):
    """Estado actual de la cola de operaciones."""
    async with queue_lock:
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
            for o in file_queue
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
            for o in file_queue
            if o["status"] in ("done", "failed", "cancelled")
        ]

    # Prefer the durable record so history survives a restart; fall back to the
    # in-memory list if the database is unavailable.
    durable = await asyncio.to_thread(history.recent_operations, 10)
    if durable:
        completed = [
            {
                "id": row["id"],
                "type": row["type"],
                "name": row["name"],
                "status": row["status"],
                "detail": row["detail"],
                "progress": 100 if row["status"] == "done" else 0,
                "import_status": row["import_status"] or "",
            }
            for row in durable
        ]

    return {"queue": ops, "completed": completed[-10:], "running": False}


@router.post("/api/files/queue/cancel/{op_id}")
async def queue_cancel(op_id: str, _key: str = Depends(verify_api_key)):
    """Cancela una operación en la cola."""
    async with queue_lock:
        for op in file_queue:
            if op["id"] == op_id:
                if op["status"] == "pending":
                    op["status"] = "cancelled"
                    op["detail"] = "Cancelado por el usuario"
                    await asyncio.to_thread(history.record_operation, op)
                    return {"ok": True, "detail": "Operación cancelada"}
                elif op["status"] == "running":
                    op["cancelled"] = True
                    return {"ok": True, "detail": "Cancelación en progreso..."}
                else:
                    return {"ok": False, "detail": f"Operación en estado: {op['status']}"}
    return {"ok": False, "detail": "Operación no encontrada"}
