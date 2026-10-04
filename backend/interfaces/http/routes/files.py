"""File browser, queue, copy/move routes."""

import asyncio
import logging
import os
import shutil
import tempfile
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

import state
from config import find_service
from traces import host_path
from application.gateways import history
from import_service import post_move_import
from models import ActionRequest
from domain.naming import MEDIA_EXTENSIONS
from interfaces.http.routes.status import verify_api_key
from state import file_queue, queue_lock, http_session
import config

log = logging.getLogger("flow-controller")
router = APIRouter()

CHUNK_SIZE = 1024 * 1024  # 1MB


def _seed_block_reason(src: str, verb: str) -> str | None:
    """Why `src` must not be renamed or moved by us — or None when it may.

    A torrent client shares a PATH, not an inode. Renaming or moving a file
    removes the directory entry it is seeding, and the data surviving does not
    help: the seeder's path is what disappeared. Placing an extra name (a
    hardlink or a copy) never touches it, which is why the operations allowed
    here are the ones that ADD a name and not the ones that change one.

    **Only the torrent folder is guarded.** aMule is excluded on purpose, and
    two independent reasons say the same thing:

    - its downloads sit on a *different mount* from the library
      (`/mnt/storage-6tb` vs `/mnt/storage`), so a hardlink between them is
      impossible — there was no hardlink here to protect in the first place;
    - aMule has no seed ratio and no swarm obligation, and an ED2K can be
      fetched again from the network, so a file there is disposable on a
      schedule rather than a fragile seed. Blocking it would protect nothing
      while getting in the way of the retention cleanup.

    The folder comes from settings, so changing it in Configuración moves the
    guard with it.
    """
    resolved = os.path.realpath(src)
    root = os.path.realpath(config.FOLDER_DOWNLOAD_TORRENT)
    if resolved == root or resolved.startswith(root + "/"):
        return (
            f"'{Path(src).name}' está en la carpeta de descargas de torrents ({root}) y no se "
            f"puede {verb}: qBittorrent comparte exactamente esa ruta, y renombrarla o moverla "
            f"rompe el hardlink con el que sigue sembrando. En su lugar, copia o coloca el "
            f"fichero — se resuelve con un enlace duro y la semilla no se entera."
        )
    return None


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

@router.get("/api/files/roots")
async def file_roots(_key: str = Depends(verify_api_key)):
    """Devuelve las raíces de navegación disponibles."""
    roots = []
    for root in config.ALLOWED_ROOTS:
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
    blocked = _seed_block_reason(src, "renombrar")
    if blocked:
        return {"ok": False, "detail": blocked}
    try:
        await asyncio.to_thread(os.rename, src, dst)
        return {"ok": True, "detail": f"Renombrado: {Path(src).name} → {Path(dst).name}"}
    except Exception as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


@router.post("/api/files/delete")
async def file_delete(req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Elimina un archivo o directorio."""
    target = _validate_path(req.remote_path or "")
    try:
        p = Path(target)
        # Both branches are unbounded: a recursive delete or an unlink over a
        # stalled mount must not hold the loop hostage.
        if p.is_dir():
            await asyncio.to_thread(shutil.rmtree, p)
        else:
            await asyncio.to_thread(p.unlink)
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
            await asyncio.to_thread(shutil.copytree, src, dst, copy_function=_link_or_copy)
        else:
            await asyncio.to_thread(shutil.copy2, src, dst)
        return {"ok": True, "detail": f"Copiado: {src_path.name} → {dst}"}
    except Exception as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


# ── Copy + Queue ──────────────────────────────────────────────────────────────

def _link_or_copy(src: str, dst: str) -> None:
    """Enlaza si el sistema de ficheros deja, y copia si no.

    `shutil.copytree` lo invoca una vez por fichero, así que una carpeta de
    release colocada en el mismo dispositivo no cuesta un byte extra y la
    semilla sigue intacta. Solo un corte de dispositivo (EXDEV) paga el
    duplicado real — y ahí no hay más remedio.
    """
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def _copy_with_progress(src: str, dst: str, op: dict) -> None:
    """Copia un archivo con progreso, actualizando op en un dict compartido.

    Escribe en un temporal del MISMO directorio y solo lo renombra al final: un
    fallo a mitad no deja un fichero a medias con el nombre definitivo, y un
    destino que ya sea otro nombre del MISMO inodo jamás se abre para escritura
    — eso vaciaría el inodo que la fuente todavía referencia.
    """
    src_path = Path(src)
    if src_path.is_dir():
        shutil.copytree(src, dst, copy_function=_link_or_copy)
        return
    total = src_path.stat().st_size
    op["total_bytes"] = total
    op["copied_bytes"] = 0
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=str(Path(dst).parent), delete=False, prefix=".copy_", suffix=".part"
        ) as fdst:
            tmp_path = fdst.name
            with open(src, "rb") as fin:
                while True:
                    if op.get("cancelled"):
                        raise InterruptedError("Cancelado por el usuario")
                    chunk = fin.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    fdst.write(chunk)
                    op["copied_bytes"] += len(chunk)
                    op["progress"] = round(op["copied_bytes"] / total * 100) if total else 100
        os.rename(tmp_path, dst)
        tmp_path = None
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


def _place_file(src: str, dst: str, op: dict) -> None:
    """Pone `src` en `dst` sin destruir nunca `src`.

    El enlace duro es la primera opción: instantáneo, sin un byte extra, y la
    descarga sigue sembrando desde el mismo inodo — la misma razón que ya
    invoca `copy_file_chunked` en `copy_engine`. Solo el sistema de ficheros
    puede rechazarlo (EXDEV cuando `dst` vive en otro dispositivo), y entonces
    copiamos los bytes: pero el origen queda intacto, porque esto *coloca*, no
    mueve.
    """
    src_path = Path(src)
    dst_path = Path(dst)
    dst_path.parent.mkdir(parents=True, exist_ok=True)

    # Ya hay un nombre en cada extremo apuntando al mismo inodo: no hay nada que
    # hacer, y sobre todo NO hay que abrir `dst` para escritura.
    if src_path.exists() and dst_path.exists() and os.path.samefile(src, dst):
        op["total_bytes"] = op["copied_bytes"] = src_path.stat().st_size
        op["progress"] = 100
        op["files_done"] = op["files_total"] = 1
        return

    try:
        os.link(src, dst)
    except OSError:
        _copy_with_progress(src, dst, op)
    else:
        op["total_bytes"] = op["copied_bytes"] = src_path.stat().st_size
        op["progress"] = 100
    op["files_done"] = op["files_total"] = 1


def _copytree_with_progress(src: str, dst: str, op: dict) -> None:
    """Copia un directorio con progreso por archivos."""
    src_path = Path(src)
    all_files = [f for f in src_path.rglob("*") if f.is_file()]
    total_files = len(all_files)
    op["files_total"] = total_files
    op["files_done"] = 0
    op["total_bytes"] = sum(f.stat().st_size for f in all_files)
    op["copied_bytes"] = 0
    shutil.copytree(src, dst, copy_function=_link_or_copy)
    op["files_done"] = total_files
    op["copied_bytes"] = op["total_bytes"]
    op["progress"] = 100


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
                src_path = Path(src)
                if src_path.is_dir():
                    await asyncio.to_thread(_copytree_with_progress, src, dst, op)
                else:
                    await asyncio.to_thread(_place_file, src, dst, op)
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
        blocked = _seed_block_reason(src, "mover")
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
        if len(file_queue) > 50:
            file_queue[:] = [o for o in file_queue if o["status"] in ("pending", "running")]

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
