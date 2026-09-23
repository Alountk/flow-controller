import asyncio
import errno
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
    SERVICES,
)
from clients import (
    arr_command,
    arr_episode_metadata,
    arr_episode_season,
    arr_import_status,
    arr_movie_metadata,
    arr_movie_root_folder,
    arr_series_metadata,
    arr_series_root_folder,
)
from traces import host_path
from task_manager import copy_tasks

log = logging.getLogger("flow-controller")

COPY_CHUNK_SIZE = 1024 * 1024  # 1 MB


class CopyCancelled(Exception):
    """Excepción lanzada cuando el usuario cancela una copia."""


def cleanup_tasks():
    """Elimina tareas finalizadas que superan el TTL."""
    copy_tasks.cleanup()


def copy_file_chunked(src: Path, dst: Path, task_id: str | None = None, total_bytes: int = 0, copied_bytes: int = 0) -> int:
    # A hardlink is instant, costs no extra space and keeps the download seeding
    # from the same inode, so try it before streaming any bytes. Only the
    # filesystem decides: same device links, a different one raises EXDEV.
    try:
        os.link(src, dst)
        return src.stat().st_size
    except OSError as exc:
        if exc.errno == errno.EXDEV:
            # Expected: source and destination live on different filesystems.
            log.debug("copy_file_chunked: %s and %s are on different filesystems, copying", src, dst)
        else:
            log.warning(
                "copy_file_chunked: hardlink failed (errno %s %s) for %s, falling back to copy",
                exc.errno,
                errno.errorcode.get(exc.errno, "unknown"),
                src,
            )
    written = 0
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(dir=dst.parent, delete=False, prefix=".copy_") as fdst:
            tmp_path = fdst.name
            with open(src, 'rb') as fsrc:
                while True:
                    if task_id and copy_tasks.is_cancelled(task_id):
                        raise CopyCancelled(f"cancelado durante copia de {src.name}")
                    chunk = fsrc.read(COPY_CHUNK_SIZE)
                    if not chunk:
                        break
                    fdst.write(chunk)
                    written += len(chunk)
                    if task_id:
                        copy_tasks.update(task_id, copied_bytes=copied_bytes + written, total_bytes=total_bytes)
        os.rename(tmp_path, str(dst))
        tmp_path = None
    except Exception:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise
    return written


def copy_files_to_root(output_path: str, root_folder: str, *, is_host_path: bool = False, task_id: str | None = None, target_name: str | None = None) -> dict:
    src = Path(output_path if is_host_path else host_path(output_path))
    dst_dir = Path(root_folder)
    log.info("copy_files: src=%s  dst=%s  is_host_path=%s target_name=%s", src, dst_dir, is_host_path, target_name)

    def _update_task(copied_bytes: int, total_bytes: int, files_done: int, files_total: int):
        if task_id:
            copy_tasks.update(task_id, copied_bytes=copied_bytes, total_bytes=total_bytes, files_done=files_done, files_total=files_total)

    def _is_cancelled() -> bool:
        return bool(task_id and copy_tasks.is_cancelled(task_id))

    if not src.exists():
        log.error("copy_files: fuente no encontrada: %s", src)
        if task_id:
            copy_tasks.update(task_id, status="error", detail=f"fuente no encontrada: {src}")
        return {"ok": False, "detail": f"fuente no encontrada: {src}"}

    dst_dir.mkdir(parents=True, exist_ok=True)

    if src.is_file():
        total = src.stat().st_size
        final_name = target_name if target_name else src.name
        dst = dst_dir / final_name
        _update_task(0, total, 0, 1)
        copy_file_chunked(src, dst, task_id, total, 0)
        _update_task(total, total, 1, 1)
        return {"ok": True, "detail": f"copiado: {final_name} → {dst_dir}", "files_copied": 1}

    if src.is_dir():
        # Walk the whole tree, not just the first level: a release folder carries
        # its payload in subfolders (Sample/, Subs/) and flattening them would
        # drop files or leave the sample next to the feature as a second video.
        all_files = sorted(f for f in src.rglob("*") if f.is_file())
        # Decide which files will actually be copied before reporting any total.
        # Counting files that already exist would make the progress bar never
        # reach 100% because those bytes are never written.
        to_copy = [f for f in all_files if not (dst_dir / f.relative_to(src)).exists()]
        skipped = len(all_files) - len(to_copy)
        total_bytes = sum(f.stat().st_size for f in to_copy)
        copied_bytes = 0
        count = 0
        _update_task(0, total_bytes, 0, len(to_copy))
        for item in to_copy:
            if _is_cancelled():
                return {"ok": False, "detail": f"cancelado por el usuario ({count}/{len(to_copy)} archivos copiados)", "files_copied": count}
            dst = dst_dir / item.relative_to(src)
            dst.parent.mkdir(parents=True, exist_ok=True)
            written = copy_file_chunked(item, dst, task_id, total_bytes, copied_bytes)
            copied_bytes += written
            count += 1
            _update_task(copied_bytes, total_bytes, count, len(to_copy))
        return {"ok": True, "detail": f"copiados {count} archivos a {dst_dir} ({skipped} ya existían)", "files_copied": count}

    return {"ok": False, "detail": f"fuente no es archivo ni directorio: {src}"}


async def run_copy_background(
    task_id: str,
    src_path: str,
    dst_root: str,
    service: dict,
    source: str,
    ids: dict | None = None,
    target_name: str | None = None,
    *,
    import_after_copy: bool = True,
):
    """Copy one download into ``dst_root`` in the background.

    ``import_after_copy`` defaults to ``True``: after a successful copy the arr
    is asked to import the new files and the result is polled until it has them
    — the behaviour for a copy into the arr's own library.

    A copy into a FOREIGN folder must pass ``False``. There the arr must NOT
    import: ``ProcessMonitoredDownloads`` would move the content into the
    library, exactly the duplicate this feature exists to avoid. With ``False``
    a successful copy ends ``done`` and nothing is asked of the arr.
    """
    ids = ids or {}
    try:
        copy_tasks.update(task_id, detail="copiando archivos...")
        result = await asyncio.to_thread(
            copy_files_to_root, src_path, dst_root, is_host_path=True, task_id=task_id, target_name=target_name
        )
        if copy_tasks.is_cancelled(task_id):
            copy_tasks.update(task_id,
                status="cancelled",
                detail=result.get("detail", "cancelado"),
                files_copied=result.get("files_copied", 0),
            )
            return
        copy_tasks.update(task_id,
            status="done" if result["ok"] else "error",
            detail=result.get("detail", ""),
            files_copied=result.get("files_copied", 0),
        )
        if result["ok"] and not import_after_copy:
            copy_tasks.update(task_id,
                status="done",
                detail="copiado a la carpeta elegida; el arr no lo tocará",
            )
            return
        if result["ok"]:
            copy_tasks.update(task_id, detail="importando...", status="importing")
            async with aiohttp.ClientSession() as session:
                await arr_command(session, service, {"name": "ProcessMonitoredDownloads"})
            await verify_import(task_id, service, source, ids)
    except CopyCancelled:
        task = copy_tasks.get(task_id) or {}
        copy_tasks.update(task_id,
            status="cancelled",
            detail=task.get("detail", "cancelado por el usuario"),
            files_copied=task.get("files_done", 0),
        )
    except Exception as exc:
        log.exception("copy_files: error en background task %s", task_id)
        copy_tasks.update(task_id, status="error", detail=f"{type(exc).__name__}: {exc}")


async def verify_import(task_id: str, service: dict, source: str, ids: dict):
    start = time.time()
    async with aiohttp.ClientSession() as session:
        while time.time() - start < IMPORT_POLL_TIMEOUT:
            if copy_tasks.is_cancelled(task_id):
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
                copy_tasks.update(task_id, status="done", detail="copia completada (sin verificación)")
                return

            status = await arr_import_status(session, service, **kwargs)

            if not status["has_file"]:
                elapsed = int(time.time() - start)
                copy_tasks.update(task_id, detail=f"esperando import... ({elapsed}s)")
                await asyncio.sleep(IMPORT_POLL_INTERVAL)
                continue

            if status["needs_rename"] is False:
                copy_tasks.update(task_id, status="imported", detail="importado y renombrado correctamente")
                return
            elif status["needs_rename"] is True:
                copy_tasks.update(task_id, status="renamed_needed", detail=status.get("detail", "importado — necesita renombrado manual"))
                return
            else:
                copy_tasks.update(task_id, status="imported", detail=status.get("detail", "importado correctamente"))
                return

    copy_tasks.update(task_id, status="import_timeout", detail=f"timeout después de {IMPORT_POLL_TIMEOUT}s — verifica manualmente")


async def do_action(session: aiohttp.ClientSession, action: str, payload: dict) -> dict:
    from config import EXPECTED_CATEGORY, path_is_allowed

    def _service_by_key(key: str) -> dict | None:
        for service in SERVICES:
            if service["key"] == key:
                return service
        return None

    source = payload.get("source")
    service = _service_by_key(source) if source else None
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
        if not local_path:
            # The app owns the container→host translation (_VOLUME_MAP), so a
            # caller that sends only the remote path gets it resolved here
            # instead of writing a self-mapping that maps nothing. The old
            # `/data/`-only special case is a subset of this general rule.
            local_path = host_path(remote_path)
        if local_path.rstrip("/") == remote_path.rstrip("/"):
            # No known translation: remote and local are the same path, so the
            # mapping would be a no-op. Refuse loudly instead of persisting a
            # useless entry that keeps the arr failing at the same path.
            return {
                "ok": False,
                "steps": [
                    {
                        "target": source,
                        "ok": False,
                        "detail": (
                            f"no hay una traducción conocida para '{remote_path}': "
                            "no se creó ningún mapeo de rutas"
                        ),
                    }
                ],
            }
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
        dest_root = payload.get("dest_root") or ""
        if dest_root:
            # Defence in depth: the combo is fed by the arr's roots and the
            # app's allowed roots, but the payload is untrusted here, so a
            # foreign folder is re-validated before writing a single byte.
            if not path_is_allowed(dest_root):
                log.warning("copy_files: destino no permitido: %s", dest_root)
                return {
                    "ok": False,
                    "steps": [
                        {"target": source, "ok": False, "detail": f"destino no permitido: {dest_root}"}
                    ],
                }
            # Take the item out of the arr's queue BEFORE copying, so the arr
            # cannot import it into the library behind our back. A failure here
            # fails the whole action: the hard constraint is that a folder
            # outside the arr's roots is never catalogued by the arr.
            if not queue_id:
                log.warning("copy_files: destino ajeno sin queue_id")
                return {
                    "ok": False,
                    "steps": [
                        {
                            "target": source,
                            "ok": False,
                            "detail": "no se puede garantizar que el arr no importe la copia: falta el id de la cola",
                        }
                    ],
                }
            from clients import arr_delete_queue
            removal = await arr_delete_queue(
                session,
                service,
                int(queue_id),
                blocklist=False,
                remove_from_client=False,
            )
            # A 404 means the arr is not tracking it: there is nothing left to
            # prevent, so the copy may proceed. Any other failure is real.
            if not (removal.get("ok") or removal.get("not_found")):
                detail = removal.get("detail") or "error desconocido"
                log.error("copy_files: no se pudo quitar la cola del arr: %s", detail)
                return {
                    "ok": False,
                    "steps": [
                        {"target": source, "ok": False, "detail": f"no se pudo quitar de la cola del arr: {detail}"}
                    ],
                }
            # The foreign destination is used exactly as given: no arr root and
            # no `Season XX` subfolder, which only belongs to the library layout.
            root = dest_root
            log.info("copy_files: destino ajeno=%s", root)
        else:
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

        # --- Smart rename: construir nombre correcto antes de copiar ---
        # Resolve the container path to a host path ONCE, through the app's
        # single authority. An absolute container path like
        # /downloads/incoming/x.mkv is not a host path; using it as one looked
        # up a file that does not exist. host_path is a no-op for a path that
        # matches no container prefix, so a real host path passes untouched.
        resolved_src = host_path(output_path)
        _src_path = Path(resolved_src)
        smart_name = _src_path.name  # fallback: nombre original
        ext = _src_path.suffix

        src_path_obj = Path(resolved_src)
        if src_path_obj.is_file():
            if source == "sonarr" and ids.get("episode_id") and ids.get("series_id"):
                ep_meta = await arr_episode_metadata(session, service, ids["episode_id"])
                sr_meta = await arr_series_metadata(session, service, ids["series_id"])
                series_title = sr_meta.get("title", "")
                season = ep_meta.get("season_number")
                episode = ep_meta.get("episode_number")
                ep_title = ep_meta.get("title", "")
                if series_title and season is not None and episode is not None:
                    parts = [f"{series_title} - S{season:02d}E{episode:02d}"]
                    if ep_title:
                        parts.append(ep_title)
                    smart_name = " - ".join(parts) + ext
                    log.info("copy_files: smart rename (sonarr) → %s", smart_name)

            elif source == "radarr" and ids.get("movie_id"):
                mv_meta = await arr_movie_metadata(session, service, ids["movie_id"])
                movie_title = mv_meta.get("title", "")
                year = mv_meta.get("year")
                quality = mv_meta.get("quality", "")
                if movie_title:
                    name_parts = movie_title
                    if year:
                        name_parts += f" ({year})"
                    if quality:
                        name_parts += f" {quality}"
                    smart_name = name_parts + ext
                    log.info("copy_files: smart rename (radarr) → %s", smart_name)

        dst_path = str(Path(root) / smart_name)
        task_id = str(uuid.uuid4())
        copy_tasks.create(task_id,
            status="running",
            src_path=resolved_src,
            dst_path=dst_path,
            copied_bytes=0,
            total_bytes=0,
            files_done=0,
            files_total=0,
            detail="preparando copia...",
        )
        asyncio.create_task(run_copy_background(task_id, resolved_src, root, service, source, ids, target_name=smart_name, import_after_copy=not dest_root))
        return {"ok": True, "needs_polling": True, "task_id": task_id, "src_path": resolved_src, "dst_path": dst_path}

    else:
        return {"ok": False, "steps": [{"target": "?", "ok": False, "detail": f"acción desconocida: {action}"}]}

    return {"ok": all(s["ok"] for s in steps), "steps": steps}
