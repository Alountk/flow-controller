"""Place, copy, move and delete files — the orchestration the routes did inline.

One module for the filesystem work that used to live inside the HTTP handlers
of `interfaces/http/routes/files.py` (T1): the route parses a request, hands
the paths here, and maps the returned dict to its response. Every function is
synchronous on purpose — the routes call them through `asyncio.to_thread`, the
same boundary the handlers already had — so none of this can ever run on the
event loop.

What the module consults rather than re-decides is `domain.policy.placement`:
when placement is a no-op, what a failed rename falls back to, what a fallback
move cleans up, how a copy temp is named, and how the queue trims. The policy
is pure and tested there; the touching happens here.

Behaviour is the routes' behaviour, kept byte for byte: the hardlink-first
placement that never costs a copy on one device, the rename-first move whose
copy fallback deletes the source only when it completed, the seed guard's
resolved paths, and the user-facing details exactly as the endpoints always
worded them.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

from domain.policy import placement

#: Bytes per chunk of a progress-reported copy (1MB).
CHUNK_SIZE = 1024 * 1024


def seed_block_reason(src: str, torrent_root: str, verb: str) -> str | None:
    """Why `src` may not be renamed or moved — or None when it may.

    Resolution of both ends happens here, once: the guard compares canonical
    paths (a symlinked torrent folder is still the torrent folder), and the
    policy itself stays free of syscalls. See
    `domain.policy.placement.seed_block_reason` for the rule's rationale.
    """
    return placement.seed_block_reason(
        os.path.realpath(src), os.path.realpath(torrent_root), verb
    )


def rename_path(src: str, dst: str) -> dict:
    """Rename `src` to `dst` — the caller must have guarded it first."""
    try:
        os.rename(src, dst)
        return {"ok": True, "detail": f"Renombrado: {Path(src).name} → {Path(dst).name}"}
    except Exception as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


def delete_path(target: str) -> dict:
    """Delete a file or a whole tree at `target`.

    Both branches are unbounded: a recursive delete or an unlink over a
    stalled mount must not hold the caller hostage, which is why this runs in
    a worker thread like every other function here.
    """
    try:
        p = Path(target)
        if p.is_dir():
            shutil.rmtree(p)
        else:
            p.unlink()
        return {"ok": True, "detail": f"Eliminado: {p.name}"}
    except Exception as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


def copy_path(src: str, dst: str) -> dict:
    """Copy `src` to `dst` — a file as plain bytes, a tree hardlink-first.

    A single file pays a real copy here (this is the endpoint's long-standing
    contract); a release folder must not, so the tree copy links every file it
    can and duplicates only what the filesystem refuses to link.
    """
    try:
        src_path = Path(src)
        if src_path.is_dir():
            shutil.copytree(src, dst, copy_function=_link_or_copy)
        else:
            shutil.copy2(src, dst)
        return {"ok": True, "detail": f"Copiado: {src_path.name} → {dst}"}
    except Exception as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


def _link_or_copy(src: str, dst: str) -> None:
    """Enlaza si el sistema de ficheros deja, y copia si no.

    `shutil.copytree` lo invoca una vez por fichero, así que una carpeta de
    release colocada en el mismo dispositivo no cuesta un byte extra y la
    semilla sigue intacta. Solo un corte de dispositivo (EXDEV) paga el
    duplicado real — y ahí no hay más remedio. Es la ejecución, fichero a
    fichero, de `placement.HARDLINK_FIRST`.
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
    — eso vaciaría el inodo que la fuente todavía referencia. El nombre de ese
    temporal lo decide la política (`placement.atomic_temp_params`).
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
            delete=False, **placement.atomic_temp_params(dst)
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
    mueve. Qué rama corresponde lo decide `placement.placement_plan`.
    """
    src_path = Path(src)
    dst_path = Path(dst)
    dst_path.parent.mkdir(parents=True, exist_ok=True)

    plan = placement.placement_plan(
        src_path.exists(),
        dst_path.exists(),
        lambda: os.path.samefile(src, dst),
    )
    if plan == placement.ALREADY_PLACED:
        # Ya hay un nombre en cada extremo apuntando al mismo inodo: no hay
        # nada que hacer, y sobre todo NO hay que abrir `dst` para escritura.
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


def place_path(src: str, dst: str, op: dict) -> None:
    """A queue operation of type "copy": a tree with counts, a file placed."""
    if Path(src).is_dir():
        _copytree_with_progress(src, dst, op)
    else:
        _place_file(src, dst, op)


def move_path(src: str, dst: str, op: dict) -> None:
    """A queue operation of type "move": rename first, copy + delete after.

    The rename is the happy path — atomic and free, and it takes the source
    with it, which is what a MOVE is. Any OSError (an EXDEV cut being the
    common one) falls back to a copy of the tree or the file, and the source
    is then removed only when the transfer completed and nobody cancelled
    (`placement.fallback_source_cleanup`). A cancelled fallback keeps the
    download where it was and publishes nothing half-written.
    """
    src_path = Path(src)
    try:
        dst_parent = Path(dst).parent
        if not dst_parent.exists():
            dst_parent.mkdir(parents=True, exist_ok=True)
        os.rename(src, dst)
    except OSError:
        if src_path.is_dir():
            _copytree_with_progress(src, dst, op)
        else:
            _copy_with_progress(src, dst, op)
        cleanup = placement.fallback_source_cleanup(cancelled=bool(op.get("cancelled")))
        if cleanup == placement.DELETE_SOURCE:
            (shutil.rmtree if src_path.is_dir() else os.remove)(src)


def trim_queue(ops: list) -> None:
    """Apply the queue's batch policy in place: trim only past the limit.

    Called under the queue's own lock by the route that appends. The decision
    of WHAT may be dropped lives in `placement.retained_queue`; this is only
    the application of that decision to the live list.
    """
    if placement.over_queue_limit(ops):
        ops[:] = placement.retained_queue(ops)
