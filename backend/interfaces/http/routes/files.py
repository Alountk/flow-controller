"""File browser, queue, copy/move routes.

Placement policy (hardlink-first, rename-or-fallback, the seed guard, the
queue trim) lives in `domain.policy.placement`; the filesystem orchestration
lives in `application.use_cases.place_file`. What remains here is HTTP: parse
the request, call, map the result.
"""

import asyncio
import logging
import os
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

import state
from config import find_service
from traces import host_path
from application.gateways import arr_root_folders, history
from application.use_cases import place_file
from import_service import post_move_import
from models import ActionRequest
from domain.naming import MEDIA_EXTENSIONS
from interfaces.http.routes.status import verify_api_key
from state import file_queue, queue_lock, http_session
import config

log = logging.getLogger("flow-controller")
router = APIRouter()


def _validate_path(path: str) -> str:
    """Valida que la ruta esté dentro de los volúmenes permitidos."""
    if not path:
        return ""
    normalized = host_path(path)
    resolved = os.path.realpath(normalized)
    # The configured roots, not a copy: a root added in Configuración has
    # to be the one this validator accepts.
    for root in config.ALLOWED_ROOTS:
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
        # `naming.MEDIA_EXTENSIONS` is the repo's single definition of "this
        # file is a video" (promoted public in #128 so a second list cannot
        # drift): a `.srt`/`.nfo` sitting in path_4k must not read as "we
        # have the 4K copy" — the Dune false positive. A directory is never a
        # video: the nested layout is proved by `is_dir` alone.
        "is_video": (not is_dir) and p.suffix.lower() in MEDIA_EXTENSIONS,
        "size": 0 if is_dir else stat.st_size,
        "modified": int(stat.st_mtime),
    }


# ── File Manager ──────────────────────────────────────────────────────────────

#: Why the library label is per-service: the picker offers Radarr's movies and
#: Sonarr's series side by side, and "Biblioteca" alone would not say WHICH
#: library an option points at.
LIBRARY_LABELS = {
    "radarr": "Biblioteca (películas) · 1080 y por debajo",
    "sonarr": "Biblioteca (series) · 1080 y por debajo",
}


@router.get("/api/files/roots")
async def file_roots(_key: str = Depends(verify_api_key)):
    """Raíces del explorador: navegación, bibliotecas de los arrs y destinos.

    Three kinds of root, each labelled: the allowed mounts to navigate, every
    configured arr's library, and the quality folders (4K / 3D). A path is
    offered only when it exists on disk, and no path is ever listed twice.

    **Order is behaviour**: the dual pane defaults to `roots[0]`/`roots[1]`,
    so the mounts have to stay first. The quality folders are skipped in the
    navigation pass on purpose — `config.rebuild()` puts them INSIDE
    `ALLOWED_ROOTS` (the copy engine must be allowed to write there), and
    without the exclusion they would render as plain navigation and their
    destination entry would be deduplicated away.

    The configured arrs are asked in parallel: two dead arrs cost one
    `REQUEST_TIMEOUT`, not two. `detail` names every configured arr that
    answered with no root folders — `arr_root_folders` returns `[]` both when
    the arr is unreachable and when it genuinely has none, and claiming success
    with a short list would be the same lie `calendar_destinations` refuses to
    tell. No arr configured at all means nothing failed: `detail` stays empty.
    """
    arrs = [s for s in config.SERVICES if s.get("kind") == "arr" and s.get("configured")]
    libraries: list[tuple[str, str, list[str]]] = []  # (key, label, root folders)
    failed: list[str] = []
    if arrs:
        async with http_session() as session:
            results = await asyncio.gather(*(arr_root_folders(session, s) for s in arrs))
        for service, paths in zip(arrs, results):
            key = service["key"]
            if not paths:
                failed.append(key)
                continue
            label = LIBRARY_LABELS.get(key, f"Biblioteca ({key}) · 1080 y por debajo")
            libraries.append((key, label, paths))

    # Claimed by the destination passes below, so navigation never lists them.
    destinations = {p for p in (config.PATH_4K, config.PATH_3D) if p}
    for _, _, paths in libraries:
        destinations.update(paths)

    roots: list[dict] = []
    seen: set[str] = set()

    def _add(path: str, entry: dict) -> None:
        """Append `path` once, and only while it exists on disk."""
        if not path or path in seen or not os.path.isdir(path):
            return
        seen.add(path)
        roots.append({**entry, "path": path})

    # Navigation first — the two mounts the panes start from.
    for root in config.ALLOWED_ROOTS:
        if root in destinations:
            continue
        name = os.path.basename(root) or root
        _add(root, {"name": name, "label": name, "role": "navigation"})

    for key, label, paths in libraries:
        for path in paths:
            _add(path, {
                "name": os.path.basename(path.rstrip("/")) or path,
                "role": "library",
                "service": key,
                "label": label,
            })

    for path, entry in (
        (config.PATH_4K, {"role": "4k", "label": "4K · 2160p"}),
        (config.PATH_3D, {"role": "3d", "label": "3D"}),
    ):
        _add(path, {"name": os.path.basename(path.rstrip("/")) or path, **entry})

    detail = ""
    if failed:
        detail = "; ".join(f"{key} no devolvió carpetas raíz" for key in failed)
        detail += "; se muestran solo los destinos disponibles."

    return {"roots": roots, "detail": detail}


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


@router.get("/api/files/retention")
async def file_retention(path: str = "/", _key: str = Depends(verify_api_key)):
    """How long each file in `path` has been here, and is it past the window.

    **Marking only — this endpoint never deletes anything.** Deletion is the
    maintainer's decision, taken behind an explicit irreversible-data warning
    in the UI; a read endpoint that also cleaned up would take that decision
    by itself.

    The clock is persisted the first time a file is observed and never
    refreshed: recomputing it per sweep would mean nothing ever expires. Rows
    whose file has disappeared are pruned here so the table tracks the disk.
    """
    target = _validate_path(path)
    if not os.path.isdir(target):
        return {"ok": False, "detail": f"No es un directorio: {target}",
                "path": target, "days": config.RETENTION_AMULE_DAYS, "files": []}

    entries = sorted(
        (e for e in Path(target).iterdir() if e.is_file()),
        key=lambda p: p.name.lower(),
    )
    full = [str(e) for e in entries]
    seen = await asyncio.to_thread(history.remember_downloads, full)
    await asyncio.to_thread(history.prune_downloads, target, set(full))

    now = time.time()
    days = config.RETENTION_AMULE_DAYS
    files = []
    for entry in entries:
        first = seen.get(str(entry))
        if first is None:
            # The store is unavailable: report the file without an age rather
            # than inventing one — a made-up age could justify a deletion.
            files.append({"name": entry.name, "first_seen_at": None,
                          "age_days": None, "expired": False})
            continue
        age_days = max(0.0, (now - first) / 86400.0)
        files.append({
            "name": entry.name,
            "first_seen_at": first,
            "age_days": round(age_days, 2),
            "expired": age_days >= days,
        })

    return {"ok": True, "path": target, "days": days, "files": files}


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
    blocked = place_file.seed_block_reason(src, config.FOLDER_DOWNLOAD_TORRENT, "renombrar")
    if blocked:
        return {"ok": False, "detail": blocked}
    return await asyncio.to_thread(place_file.rename_path, src, dst)


@router.post("/api/files/delete")
async def file_delete(req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Elimina un archivo o directorio."""
    target = _validate_path(req.remote_path or "")
    return await asyncio.to_thread(place_file.delete_path, target)


@router.post("/api/files/copy")
async def file_copy(req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Copia un archivo o directorio."""
    src = _validate_path(req.remote_path or "")
    dst = _validate_path(req.local_path or "")
    return await asyncio.to_thread(place_file.copy_path, src, dst)


# ── Copy + Queue ──────────────────────────────────────────────────────────────


async def _ensure_consumer() -> None:
    """Arranca el consumidor de la cola solo si no hay uno vivo.

    Sin esto, cada POST lanzaba un consumidor nuevo: al elegir, cada uno tomaba
    una operación distinta (la pone en `running` bajo el lock) y las copiaban
    **a la vez**, contradiciendo el propio docstring de `_consume_queue`.

    Dos señales en lugar de una, ambas bajo `queue_lock`:
    - `consumer_active` despejado *dentro* del lock por el propio consumidor →
      un POST que llega justo cuando la cola se vacía no se pierde.
    - `task.done()` → un consumidor que murió sin despejar la bandera (o una
      bandera huérfana sin tarea) no deja la cola bloqueada para siempre.
    """
    async with queue_lock:
        task = state.queue_consumer_task
        if state.consumer_active and task is not None and not task.done():
            return
        state.consumer_active = True
        # Hold a reference on the shared state object: an unreferenced asyncio
        # task may be garbage-collected mid-execution, silently aborting the
        # queue.
        state.queue_consumer_task = asyncio.create_task(_consume_queue())


async def _consume_queue():
    """Ejecuta operaciones de la cola secuencialmente."""
    while True:
        async with queue_lock:
            pending = [op for op in file_queue if op["status"] == "pending"]
            if not pending:
                # Cleared under the lock on purpose: a POST holding the same
                # lock either appends before we look (we see it) or after we
                # release (it sees the flag already down and starts us again).
                state.consumer_active = False
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
                await asyncio.to_thread(place_file.place_path, src, dst, op)
            else:
                await asyncio.to_thread(place_file.move_path, src, dst, op)
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
                service = find_service(op["arr_source"], "arr")
                if service:
                    async with queue_lock:
                        op["import_status"] = "importing"
                    try:
                        async with http_session() as session:
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
                            verb = "Copiado" if op["type"] == "copy" else "Movido"
                            async with queue_lock:
                                op["import_status"] = "imported" if imported else "import_failed"
                                op["detail"] = (
                                    f"Completado + importado: {Path(src).name}"
                                    if imported
                                    else f"{verb} (import pendiente): {Path(src).name}"
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
    if op_type == "move":
        blocked = place_file.seed_block_reason(src, config.FOLDER_DOWNLOAD_TORRENT, "mover")
        if blocked:
            return {"ok": False, "detail": blocked}

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
        place_file.trim_queue(file_queue)

    # Durable from the moment it is accepted, so a restart still shows it.
    await asyncio.to_thread(history.record_operation, op)

    await _ensure_consumer()

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
