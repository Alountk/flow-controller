"""Copy a download's files into a destination folder.

A use case: it decides what to copy, in what order, and what to tell the caller
about it. It does not know how bytes move (`FileStorage`), who is watching
progress, or whether anyone is — those arrive as arguments.

That is the whole reason this can be tested with a dict and no disk, and the
reason the same code can copy into a library, beside a library, or into a
folder the arr will never see.

The source is walked whole rather than one level deep: a release folder carries
its payload in `Sample/` and `Subs/`, and flattening it would drop files or
leave the sample next to the feature as a second video. Files already at the
destination are counted before any total is reported — counting bytes that will
never be written is how a progress bar comes to sit at 90% forever.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

from application.ports import FileStorage

#: (copied_bytes, total_bytes, files_done, files_total)
Progress = Callable[[int, int, int, int], None]


def copy_files(
    src: Path,
    dst_dir: Path,
    *,
    storage: FileStorage,
    target_name: str | None = None,
    is_cancelled: Callable[[], bool] | None = None,
    on_progress: Progress | None = None,
) -> dict:
    """Copy `src` — a file or a tree — under `dst_dir`.

    Returns ``{"ok": bool, "detail": str, "files_copied": int}`` plus ``code``
    on a failure (``"not_found"``, ``"not_a_file_or_dir"``) so the caller can
    react to the kind of failure without parsing `detail` — which is
    user-facing Spanish, written to be read by the person waiting, and not a
    protocol.

    A single file keeps its name unless `target_name` says otherwise. A
    directory keeps its whole shape and **ignores** `target_name`: a folder
    rename cannot be done by renaming one file, and silently applying it to
    the first would be worse than not honouring it.

    Cancellation is checked between files, never mid-file. A half-copied file
    is a corrupt one, and the transfer's own atomic rename is what keeps that
    from being visible — so the only safe place to stop is a file boundary.
    """

    def _report(copied: int, total: int, done: int, total_files: int) -> None:
        if on_progress:
            on_progress(copied, total, done, total_files)

    if not src.exists():
        return {"ok": False, "detail": f"fuente no encontrada: {src}", "files_copied": 0, "code": "not_found"}

    dst_dir.mkdir(parents=True, exist_ok=True)

    if src.is_file():
        total = src.stat().st_size
        final_name = target_name or src.name
        dst = dst_dir / final_name
        _report(0, total, 0, 1)
        storage.copy_file(
            src,
            dst,
            is_cancelled=is_cancelled,
            on_progress=lambda written: _report(written, total, 0, 1),
        )
        _report(total, total, 1, 1)
        return {"ok": True, "detail": f"copiado: {final_name} → {dst_dir}", "files_copied": 1}

    if src.is_dir():
        all_files = sorted(f for f in src.rglob("*") if f.is_file())
        to_copy = [f for f in all_files if not (dst_dir / f.relative_to(src)).exists()]
        skipped = len(all_files) - len(to_copy)
        total_bytes = sum(f.stat().st_size for f in to_copy)
        copied_bytes = 0
        count = 0
        _report(0, total_bytes, 0, len(to_copy))
        for item in to_copy:
            if is_cancelled and is_cancelled():
                return {
                    "ok": False,
                    "detail": f"cancelado por el usuario ({count}/{len(to_copy)} archivos copiados)",
                    "files_copied": count,
                }
            dst = dst_dir / item.relative_to(src)
            dst.parent.mkdir(parents=True, exist_ok=True)
            base = copied_bytes
            written = storage.copy_file(
                item,
                dst,
                is_cancelled=is_cancelled,
                on_progress=lambda w, _b=base: _report(_b + w, total_bytes, count, len(to_copy)),
            )
            copied_bytes += written
            count += 1
            _report(copied_bytes, total_bytes, count, len(to_copy))
        return {
            "ok": True,
            "detail": f"copiados {count} archivos a {dst_dir} ({skipped} ya existían)",
            "files_copied": count,
        }

    return {
        "ok": False,
        "detail": f"fuente no es archivo ni directorio: {src}",
        "files_copied": 0,
        "code": "not_a_file_or_dir",
    }
