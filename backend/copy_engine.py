import asyncio
import logging
import time
import uuid
from pathlib import Path

import aiohttp

from config import (
    IMPORT_POLL_INTERVAL,
    SERVICES,
)
from domain import naming as naming
from infrastructure.arr_client import (
    arr_naming_config,

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
from state import http_session
import config

log = logging.getLogger("flow-controller")

# The transfer itself lives behind the FileStorage port. This module knows HOW
# the app tracks a copy; infrastructure knows HOW bytes move. Neither has any
# business knowing the other, which is what `copy_files_to_root` below exists
# to keep true at the seam.
from application.ports import CopyCancelled, FileStorage  # noqa: F401  (CopyCancelled is caught here)
from application.use_cases.copy_files import copy_files
from infrastructure.file_storage import storage as _local_storage

#: Typed at the port, not at the adapter. This module's question is "something
#: that copies files", never "the local filesystem" — the composition root is
#: free to hand it a different one, and vulture is right that a type nobody
#: names is a type nobody is relying on.
file_storage: FileStorage = _local_storage


def cleanup_tasks():
    """Elimina tareas finalizadas que superan el TTL."""
    copy_tasks.cleanup()


def copy_files_to_root(output_path: str, root_folder: str, *, is_host_path: bool = False, task_id: str | None = None, target_name: str | None = None) -> dict:
    """Copy one download into `root_folder`, reporting through the task record.

    Wiring only. WHAT to copy is `application.use_cases.copy_files`; HOW the
    bytes move is `FileStorage`. This translates between the app's vocabulary
    (`task_id`, `copy_tasks`) and the use case's two callables — which is why
    the use case can be tested without a task manager existing.
    """
    src = Path(output_path if is_host_path else host_path(output_path))
    dst_dir = Path(root_folder)
    log.info("copy_files: src=%s  dst=%s  is_host_path=%s target_name=%s", src, dst_dir, is_host_path, target_name)

    def _is_cancelled() -> bool:
        return bool(task_id and copy_tasks.is_cancelled(task_id))

    def _on_progress(copied_bytes: int, total_bytes: int, files_done: int, files_total: int) -> None:
        if task_id:
            copy_tasks.update(
                task_id,
                copied_bytes=copied_bytes,
                total_bytes=total_bytes,
                files_done=files_done,
                files_total=files_total,
            )

    result = copy_files(
        src,
        dst_dir,
        storage=file_storage,
        target_name=target_name,
        is_cancelled=_is_cancelled if task_id else None,
        on_progress=_on_progress if task_id else None,
    )
    if task_id and result.get("code") == "not_found":
        # The one outcome the task record must hear about even with no bytes
        # moved: a missing source is a failure of the request, not a no-op.
        log.error("copy_files: fuente no encontrada: %s", src)
        copy_tasks.update(task_id, status="error", detail=result["detail"])
    return result


async def _radarr_pattern_destination(
    session,
    service: dict,
    meta: dict,
    *,
    new_quality: str,
    ext: str,
    dest_root: str,
) -> tuple[str, str, str]:
    """Where a copy into a foreign folder should be named, and how sure we are.

    Radarr renames what it owns and nothing else, so for a file outside its
    roots it offers only its pattern. Evaluating somebody else's format string
    is where a filename gets written wrong with total confidence, so the
    pattern is never taken on trust: it is re-evaluated for the file Radarr
    already owns and compared with the name Radarr chose. Only a match earns a
    name for the file we are about to write.

    Returns ``(root, filename, note)``. A failure returns ``(dest_root,
    "", note)`` with an empty filename: the caller keeps the name it already
    built, and the note says why it had to.

    The folder comes from Radarr's own ``movie.path`` rather than from
    ``movieFolderFormat`` — it is the answer Radarr already acted on.
    """
    pattern = (await arr_naming_config(session, service)).get("standard_movie_format", "")
    if not pattern:
        return dest_root, "", "Radarr no expone patrón de nombrado"
    reference = meta.get("file_name") or ""
    if not reference:
        return dest_root, "", "la película no tiene fichero de referencia en Radarr"
    existing = naming.build_values(
        title=meta.get("title", ""),
        year=meta.get("year"),
        quality=meta.get("quality", ""),
    )
    if not naming.reproduced_radarr(pattern, existing, reference):
        return dest_root, "", "el patrón de Radarr no se puede reproducir aquí"
    if not new_quality:
        return dest_root, "", "se desconoce la calidad descargada"
    values = naming.build_values(
        title=meta.get("title", ""),
        year=meta.get("year"),
        quality=new_quality,
    )
    rendered = naming.evaluate(pattern, values)
    if not rendered:
        return dest_root, "", "el patrón no se pudo evaluar con la calidad nueva"
    filename = Path(rendered).name + ext
    folder = meta.get("folder") or ""
    root = str(Path(dest_root) / folder) if folder else dest_root
    return root, filename, "nombre según el patrón de Radarr"


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
    naming_note: str | None = None,
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
            detail = "copiado a la carpeta elegida; el arr no lo tocará"
            if naming_note:
                # The name used is the whole question for a folder the arr
                # cannot see, so the task says which answer it settled on.
                detail = f"{detail} — {naming_note}"
            copy_tasks.update(task_id, status="done", detail=detail)
            return
        if result["ok"]:
            copy_tasks.update(task_id, detail="importando...", status="importing")
            async with http_session() as session:
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
    async with http_session() as session:
        while time.time() - start < config.IMPORT_POLL_TIMEOUT:
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

    copy_tasks.update(task_id, status="import_timeout", detail=f"timeout después de {config.IMPORT_POLL_TIMEOUT}s — verifica manualmente")


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
        from infrastructure.arr_client import amu_ws_find_instance, amu_ws, amu_ws_items as _amu_ws_items_fn
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
        from infrastructure.arr_client import amu_ws_find_instance, amu_ws, amu_ws_items as _amu_ws_items_fn
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
        from infrastructure.arr_client import arr_delete_queue
        steps.append({
            "target": source,
            **await arr_delete_queue(session, service, int(queue_id), blocklist),
        })

    elif action == "delete_torrent":
        if not matched_hash:
            return {"ok": False, "steps": [{"target": "amutorrent", "ok": False, "detail": "sin hash correlacionado"}]}
        delete_files = bool(payload.get("delete_files"))
        from infrastructure.arr_client import amu_ws_find_instance, amu_ws, amu_ws_items as _amu_ws_items_fn
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
        from infrastructure.arr_client import arr_remote_paths, arr_add_remote_path
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
            #
            # The one shape that needs no removal is a DIRECT add (B-10): it
            # never entered an arr queue, so there is nothing to detach and the
            # guarantee holds by construction — demanding an id that cannot
            # exist would fail the one download the rule exists to protect.
            # The flag is trusted input: the sweep builds this payload itself.
            if payload.get("arr_untracked"):
                log.info("copy_files: destino ajeno sin cola del arr (descarga directa)")
            elif not queue_id:
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
            else:
                from infrastructure.arr_client import arr_delete_queue
                removal = await arr_delete_queue(
                    session,
                    service,
                    int(queue_id),
                    blocklist=False,
                    remove_from_client=False,
                )
                # A 404 means the arr is not tracking it: there is nothing
                # left to prevent, so the copy may proceed. Any other failure
                # is real.
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

        # Populated only where a foreign destination asked a question; the
        # library path leaves it None so the task detail stays byte for byte
        # what it was.
        naming_note: str | None = None

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
                # Only a FOREIGN destination gets here: for the arr's own
                # library it imports and names the file itself, and overriding
                # that would be a second opinion nobody asked for.
                if dest_root:
                    pattern_root, pattern_name, naming_note = (
                        await _radarr_pattern_destination(
                            session,
                            service,
                            mv_meta,
                            new_quality=payload.get("quality") or "",
                            ext=ext,
                            dest_root=dest_root,
                        )
                    )
                    log.info("copy_files: patrón de Radarr → %s (%s)", naming_note, pattern_name or "sin cambio")
                    if pattern_name:
                        root = pattern_root
                        smart_name = pattern_name

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
        asyncio.create_task(run_copy_background(task_id, resolved_src, root, service, source, ids, target_name=smart_name, import_after_copy=not dest_root, naming_note=naming_note if dest_root else None))
        return {"ok": True, "needs_polling": True, "task_id": task_id, "src_path": resolved_src, "dst_path": dst_path}

    else:
        return {"ok": False, "steps": [{"target": "?", "ok": False, "detail": f"acción desconocida: {action}"}]}

    return {"ok": all(s["ok"] for s in steps), "steps": steps}
