"""Recorrer la biblioteca y quedarse con las carpetas que repiten un fichero.

El disco es la única fuente que ve el segundo fichero de una carpeta: Radarr
guarda un `movieFile` por película y el resto le es invisible. Así que este
módulo camina las raíces permitidas y le pasa los ficheros a la regla pura.

El recorrido es lento por naturaleza (miles de carpetas, minutos en un disco
mecánico) y por eso el llamante lo ejecuta en un hilo: aquí no hay `async` ni
progreso, igual que `scan_wanted`.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Iterator

from domain.duplicates_folders import VIDEO_EXTS, duplicate_folders

#: `(root, dirs, files)` — injected so the walk is testable without a real disk.
ScanWalk = Callable[[str], Iterator[tuple[str, list[str], list[str]]]]


def collect_video_files(roots: list[str], *, walk: ScanWalk) -> list[dict]:
    """Every video file under `roots`, with its size. Unreadable roots are skipped."""
    found: list[dict] = []
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        try:
            for folder, _dirs, names in walk(root):
                for name in names:
                    if os.path.splitext(name)[1].lower() not in VIDEO_EXTS:
                        continue
                    path = os.path.join(folder, name)
                    try:
                        size = os.path.getsize(path)
                    except OSError:
                        continue
                    found.append({"path": path, "size": size})
        except OSError:
            continue
    return found


def scan_duplicates(
    roots: list[str],
    *,
    walk: ScanWalk,
    known: dict[str, str] | None = None,
    titles: dict[str, str] | None = None,
    radarr_available: bool = True,
) -> list[dict]:
    """The duplicate folders under `roots`, with what Radarr knows marked."""
    return duplicate_folders(
        collect_video_files(roots, walk=walk),
        known=known,
        titles=titles,
        radarr_available=radarr_available,
    )
