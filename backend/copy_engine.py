import asyncio
import logging
import os
import tempfile
import time
import uuid
from pathlib import Path

import aiohttp

from config import (
    IMPORT_POLL_INTERVAL,
    IMPORT_POLL_TIMEOUT,
    REQUEST_TIMEOUT,
    SERVICES,
)
from clients import (
    arr_command,
    arr_episode_season,
    arr_import_status,
    arr_movie_root_folder,
    arr_series_root_folder,
)
from traces import resolve_current_path, host_path

log = logging.getLogger("flow-controller")

COPY_CHUNK_SIZE = 1024 * 1024  # 1 MB

# Shared mutable state for background tasks.
_tasks: dict[str, dict] = {}
_task_lock = asyncio.Lock()


class CopyCancelled(Exception):
    """Excepción lanzada cuando el usuario cancela una copia."""


def cleanup_tasks():
    """Elimina tareas finalizadas que superan el TTL."""
    now = time.time()
    expired = [
        tid for tid, t in _tasks.items()
        if t.get("status") not in ("running", "importing")
        and now - t.get("created_at", 0) > 600
    ]
    for tid in expired:
        del _tasks[tid]


def copy_file_chunked(src: Path, dst: Path, task_id: str | None = None, total_bytes: int = 0, copied_bytes: int = 0) -> int:
    written = 0
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(dir=dst.parent, delete=False, prefix=".copy_") as fdst:
            tmp_path = fdst.name
            with open(src, 'rb') as fsrc:
                while True:
                    if task_id and task_id in _tasks and _tasks[task_id].get("cancelled"):
                        raise CopyCancelled(f"cancelado durante copia de {src.name}")
                    chunk = fsrc.read(COPY_CHUNK_SIZE)
                    if not chunk:
                        break
                    fdst.write(chunk)
                    written += len(chunk)
                    if task_id and task_id in _tasks:
                        _tasks[task_id].update({
                            "copied_bytes": copied_bytes + written,
                            "total_bytes": total_bytes,
                        })
        os.rename(tmp_path, str(dst))
        tmp_path = None
    except Exception:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise
    return written


def copy_files_to_root(output_path: str, root_folder: str, *, is_host_path: bool = False, task_id: str | None = None) -> dict:
    src = Path(output_path if is_host_path else host_path(output_path))
    dst_dir = Path(root_folder)
    log.info("copy_files: src=%s  dst=%s  is_host_path=%s", src, dst_dir, is_host_path)

    def _update_task(copied_bytes: int, total_bytes: int, files_done: int, files_total: int):
        if task_id and task_id in _tasks:
            _tasks[task_id].update({
                "copied_bytes": copied_bytes,
                "total_bytes": total_bytes,
                "files_done": files_done,
                "files_total": files_total,
            })

    def _is_cancelled() -> bool:
        return bool(task_id and task_id in _tasks and _tasks[task_id].get("cancelled"))

    if not src.exists():
        log.error("copy_files: fuente no encontrada: %s", src)
        if task_id and task_id in _tasks:
            _tasks[task_id].update({"status": "error", "detail": f"fuente no encontrada: {src}"})
        return {"ok": False, "detail": f"fuente no encontrada: {src}"}

    dst_dir.mkdir(parents=True, exist_ok=True)

    if src.is_file():
        total = src.stat().st_size
        dst = dst_dir / src.name
        _update_task(0, total, 0, 1)
        copy_file_chunked(src, dst, task_id, total, 0)
        _update_task(total, total, 1, 1)
        return {"ok": True, "detail": f"copiado: {src.name} → {dst_dir}", "files_copied": 1}

    if src.is_dir():
        files = [f for f in src.iterdir() if f.is_file()]
        total_bytes = sum(f.stat().st_size for f in files)
        copied_bytes = 0
        count = 0
        _update_task(0, total_bytes, 0, len(files))
        for item in files:
            if _is_cancelled():
                return {"ok": False, "detail": f"cancelado por el usuario ({count}/{len(files)} archivos copiados)", "files_copied": count}
            dst = dst_dir / item.name
            written = copy_file_chunked(item, dst, task_id, total_bytes, copied_bytes)
            copied_bytes += written
            count += 1
            _update_task(copied_bytes, total_bytes, count, len(files))
        return {"ok": True, "detail": f"copiados {count} archivos a {dst_dir}", "files_copied": count}

    return {"ok": False, "detail": f"fuente no es archivo ni directorio: {src}"}


async def run_copy_background(task_id: str, src_path: str, dst_root: str, service: dict, source: str, ids: dict | None = None):
    ids = ids or {}
    try:
        _tasks[task_id]["detail"] = "copiando archivos..."
        result = await asyncio.to_thread(
            copy_files_to_root, src_path, dst_root, is_host_path=True, task_id=task_id
        )
        if _tasks[task_id].get("cancelled"):
            _tasks[task_id].update({
                "status": "cancelled",
                "detail": result.get("detail", "cancelado"),
                "files_copied": result.get("files_copied", 0),
            })
            return
        _tasks[task_id].update({
            "status": "done" if result["ok"] else "error",
            "detail": result.get("detail", ""),
            "files_copied": result.get("files_copied", 0),
        })
        if result["ok"]:
            _tasks[task_id]["detail"] = "importando..."
            _tasks[task_id]["status"] = "importing"
            async with aiohttp.ClientSession() as session:
                await arr_command(session, service, {"name": "ProcessMonitoredDownloads"})
            await verify_import(task_id, service, source, ids)
    except CopyCancelled:
        _tasks[task_id].update({
            "status": "cancelled",
            "detail": _tasks[task_id].get("detail", "cancelado por el usuario"),
            "files_copied": _tasks[task_id].get("files_done", 0),
        })
    except Exception as exc:
        log.exception("copy_files: error en background task %s", task_id)
        _tasks[task_id].update({"status": "error", "detail": f"{type(exc).__name__}: {exc}"})


async def verify_import(task_id: str, service: dict, source: str, ids: dict):
    start = time.time()
    async with aiohttp.ClientSession() as session:
        while time.time() - start < IMPORT_POLL_TIMEOUT:
            if _tasks[task_id].get("cancelled"):
                return

            kwargs: dict = {}
            if source == "radarr" and ids.get("movie_id"):
                kwargs["movie_id"] = ids["movie_id"]
            elif source == "sonarr" and ids.get("series_id"):
                kwargs["series_id"] = ids["series_id"]
                if ids.get("episode_id"):
                    season = await arr_episode_season(session, service, ids["episode_id"])
                    if season is not None:
                        kwargs["season_number"] = season

            if not kwargs:
                _tasks[task_id].update({"status": "done", "detail": "copia completada (sin verificación)"})
                return

            status = await arr_import_status(session, service, **kwargs)

            if not status["has_file"]:
                elapsed = int(time.time() - start)
                _tasks[task_id]["detail"] = f"esperando import... ({elapsed}s)"
                await asyncio.sleep(IMPORT_POLL_INTERVAL)
                continue

            if status["needs_rename"] is False:
                _tasks[task_id].update({
                    "status": "imported",
                    "detail": "importado y renombrado correctamente",
                })
                return
            elif status["needs_rename"] is True:
                _tasks[task_id].update({
                    "status": "renamed_needed",
                    "detail": status.get("detail", "importado — necesita renombrado manual"),
                })
                return
            else:
                _tasks[task_id].update({
                    "status": "imported",
                    "detail": status.get("detail", "importado correctamente"),
                })
                return

    _tasks[task_id].update({
        "status": "import_timeout",
        "detail": f"timeout después de {IMPORT_POLL_TIMEOUT}s — verifica manualmente",
    })


async def do_action(session: aiohttp.ClientSession, action: str, payload: dict) -> dict:
    from config import ACTIONS, EXPECTED_CATEGORY
    from traces import host_path as _host_path_unused

    def _service_by_key(key: str) -> dict | None:
        for service in SERVICES:
            if service["key"] == key:
                return service
        return None

    source = payload.get("source")
    service = _service_by_key(source) if source else None
    download_id = payload.get("download_id") or ""
    matched_hash = payload.get("matched_hash")
    ids = payload.get("ids") or {}
    queue_id = ids.get("queue_id")
    steps: list[dict] = []

    if action == "retry_import":
        if not service:
            return {"ok": False, "steps": [{"target": "arr", "ok": False, "detail": "servicio desconocido"}]}
        steps.append({"target": source, **await arr_command(session, service, {"name": "ProcessMonitoredDownloads"})})

    elif action == "research":
        if not service:
            return {"ok": False, "steps": [{"target": "arr", "ok": False, "detail": "servicio desconocido"}]}
        if source == "sonarr" and ids.get("episode_id"):
            body = {"name": "EpisodeSearch", "episodeIds": [ids["episode_id"]]}
        elif source == "radarr" and ids.get("movie_id"):
            body = {"name": "MoviesSearch", "movieIds": [ids["movie_id"]]}
        else:
            return {"ok": False, "steps": [{"target": source, "ok": False, "detail": "faltan IDs de episodio/película"}]}
        steps.append({"target": source, **await arr_command(session, service, body)})

    elif action == "fix_category":
        if not matched_hash:
            return {"ok": False, "steps": [{"target": "amutorrent", "ok": False, "detail": "sin hash correlacionado"}]}
        category = EXPECTED_CATEGORY.get(source)
        if not category:
            return {"ok": False, "steps": [{"target": "amutorrent", "ok": False, "detail": "categoría esperada desconocida"}]}
        from clients import amu_ws_find_instance, amu_ws, amu_ws_items as _amu_ws_items_fn
        client, inst = await amu_ws_find_instance(matched_hash)
        steps.append({
            "target": "amutorrent",
            **await amu_ws(
                "batchSetFileCategory",
                {
                    "items": _amu_ws_items_fn(matched_hash, client=client or "qbittorrent", instance_id=inst),
                    "categoryName": category,
                    "moveFiles": False,
                },
            ),
        })
        if service:
            steps.append({
                "target": source,
                **await arr_command(session, service, {"name": "ProcessMonitoredDownloads"}),
            })

    elif action in ("pause", "resume"):
        if not matched_hash:
            return {"ok": False, "steps": [{"target": "amutorrent", "ok": False, "detail": "sin hash correlacionado"}]}
        from clients import amu_ws_find_instance, amu_ws, amu_ws_items as _amu_ws_items_fn
        ws_action = "batchPause" if action == "pause" else "batchResume"
        client, inst = await amu_ws_find_instance(matched_hash)
        steps.append({
            "target": "amutorrent",
            **await amu_ws(ws_action, {"items": _amu_ws_items_fn(matched_hash, client=client or "amule", instance_id=inst)}),
        })

    elif action == "remove_queue":
        if not service or not queue_id:
            return {"ok": False, "steps": [{"target": "arr", "ok": False, "detail": "sin queue_id"}]}
        blocklist = bool(payload.get("blocklist"))
        from clients import arr_delete_queue
        steps.append({
            "target": source,
            **await arr_delete_queue(session, service, int(queue_id), blocklist),
        })

    elif action == "delete_torrent":
        if not matched_hash:
            return {"ok": False, "steps": [{"target": "amutorrent", "ok": False, "detail": "sin hash correlacionado"}]}
        delete_files = bool(payload.get("delete_files"))
        from clients import amu_ws_find_instance, amu_ws, amu_ws_items as _amu_ws_items_fn
        client, inst = await amu_ws_find_instance(matched_hash)
        steps.append({
            "target": "amutorrent",
            **await amu_ws(
                "batchDelete",
                {
                    "items": _amu_ws_items_fn(matched_hash, client=client or "amule", instance_id=inst),
                    "deleteFiles": delete_files,
                    "source": "downloads",
                },
            ),
        })

    elif action == "fix_path_mapping":
        if not service:
            return {"ok": False, "steps": [{"target": "arr", "ok": False, "detail": "servicio desconocido"}]}
        host = payload.get("host") or ""
        remote_path = payload.get("remote_path") or ""
        local_path = payload.get("local_path") or ""
        if not (host and remote_path):
            return {
                "ok": False,
                "steps": [
                    {
                        "target": source,
                        "ok": False,
                        "detail": "faltan host/remote_path para el mapeo",
                    }
                ],
            }
        if not local_path and remote_path.startswith("/data/"):
            local_path = "/mnt/storage/" + remote_path[len("/data/"):]
        elif not local_path:
            local_path = remote_path
        from clients import arr_remote_paths, arr_add_remote_path
        existing = await arr_remote_paths(session, service)
        rp = remote_path.rstrip("/")
        lp = local_path.rstrip("/")
        dup = next(
            (
                m for m in existing
                if m.get("host") == host
                and m.get("remotePath", "").rstrip("/") == rp
                and m.get("localPath", "").rstrip("/") == lp
            ),
            None,
        )
        if dup:
            steps.append({"target": source, "ok": True, "detail": "el mapeo ya existe"})
        else:
            steps.append({
                "target": source,
                **await arr_add_remote_path(session, service, host, remote_path, local_path),
            })
        steps.append({
            "target": source,
            **await arr_command(session, service, {"name": "ProcessMonitoredDownloads"}),
        })

    elif action == "copy_files":
        log.info("action=copy_files source=%s ids=%s", source, ids)
        if not service:
            return {"ok": False, "steps": [{"target": "arr", "ok": False, "detail": "servicio desconocido"}]}
        output_path = payload.get("output_path") or ""
        if not output_path:
            log.warning("copy_files: sin output_path en payload")
            return {"ok": False, "steps": [{"target": source, "ok": False, "detail": "sin output_path"}]}
        if source == "sonarr" and ids.get("series_id"):
            root = await arr_series_root_folder(session, service, ids["series_id"])
            if root and ids.get("episode_id"):
                season_num = await arr_episode_season(session, service, ids["episode_id"])
                if season_num is not None:
                    root = str(Path(root) / f"Season {season_num}")
                    log.info("copy_files: season folder → %s", root)
        elif source == "radarr" and ids.get("movie_id"):
            root = await arr_movie_root_folder(session, service, ids["movie_id"])
        else:
            root = ""
        log.info("copy_files: output_path=%s  root=%s", output_path, root)
        if not root:
            log.error("copy_files: no se pudo obtener root folder para %s (series_id=%s, movie_id=%s)", source, ids.get("series_id"), ids.get("movie_id"))
            return {"ok": False, "steps": [{"target": source, "ok": False, "detail": "no se pudo obtener la carpeta raíz de la librería"}]}
        _src_path = Path(output_path)
        dst_path = str(Path(root) / _src_path.name)
        task_id = str(uuid.uuid4())
        _tasks[task_id] = {
            "status": "running",
            "created_at": time.time(),
            "src_path": output_path,
            "dst_path": dst_path,
            "copied_bytes": 0,
            "total_bytes": 0,
            "files_done": 0,
            "files_total": 0,
            "detail": "preparando copia...",
        }
        asyncio.create_task(run_copy_background(task_id, output_path, root, service, source, ids))
        return {"ok": True, "needs_polling": True, "task_id": task_id, "src_path": output_path, "dst_path": dst_path}

    else:
        return {"ok": False, "steps": [{"target": "?", "ok": False, "detail": f"acción desconocida: {action}"}]}

    return {"ok": all(s["ok"] for s in steps), "steps": steps}
