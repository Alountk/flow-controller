"""Duplicado de verdad: dos ficheros de vídeo en la misma carpeta y de la misma clase.

El buscador anterior agrupaba **películas de Radarr** por `tmdbId`, y eso no
puede encontrar un duplicado: Radarr guarda un solo `movieFile` por película, así
que el segundo fichero de una carpeta no existe para su API. Con 1067 películas
en la biblioteca del usuario había **cero** `tmdbId` repetidos — la lista estaba
vacía por construcción, no por falta de duplicados.

La regla de este módulo mira el disco: una carpeta con dos o más ficheros de
vídeo de la **misma clase** es un duplicado. Clases distintas (un 4K y un 1080p)
no lo son: es la decisión del usuario, y son dos copias que quiere conservar.

Puro: entran ficheros y lo que Radarr conoce, sale la lista. Sin disco, sin red.
"""

from __future__ import annotations

import os
from typing import Iterable, Mapping

#: One list for the whole project: what counts as a video file. Kept here
#: because the duplicate rule is the first thing that needs it in `domain`.
VIDEO_EXTS = frozenset({
    ".mkv", ".mp4", ".avi", ".m2ts", ".ts", ".wmv",
    ".mov", ".m4v", ".flv", ".mpg", ".mpeg", ".webm",
})

#: Class order for output stability, widest first.
_CLASSES = ("4K", "3D", "1080", "otros")


def resolution_class(name: str) -> str:
    """Class of a file from its name: `4K`, `3D`, `1080` or `otros`.

    The name is all we have for a file Radarr never imported, so the resolution
    token is read from it. `2160p` before `3d` before `1080`: a release name can
    carry several tokens and the widest one decides.
    """
    lowered = name.lower()
    if "2160p" in lowered or "4k" in lowered:
        return "4K"
    if "3d" in lowered:
        return "3D"
    if "1080" in lowered:
        return "1080"
    return "otros"


def _known_name(known: Mapping[str, str], folder: str) -> str:
    """The file Radarr says it has in `folder`, or "" when it knows no movie there."""
    return known.get(folder, "")


def duplicate_folders(
    files: Iterable[Mapping[str, object]],
    *,
    known: Mapping[str, str] | None = None,
    titles: Mapping[str, str] | None = None,
    radarr_available: bool = True,
) -> list[dict]:
    """Group files by folder, keep folders that repeat a class, mark what Radarr knows.

    `known` maps a folder to the file name Radarr tracks there; `titles` maps it
    to the movie's title. Both are optional: a folder Radarr does not know still
    gets reported, with its own name as title — an orphan folder is exactly the
    kind of duplicate worth seeing.

    `radarr_available=False` means the arr did not answer, and then **no file is
    marked as the extra one**: `known` is None and nothing is reclaimable. With
    the arr down every file would otherwise look deletable, including the one it
    tracks, and the screen would invite exactly the wrong deletion.
    """
    known = known or {}
    titles = titles or {}
    by_folder: dict[str, list[dict]] = {}
    for entry in files:
        path = str(entry.get("path") or "")
        if not path:
            continue
        folder = os.path.dirname(path)
        by_folder.setdefault(folder, []).append({
            "path": path,
            "name": os.path.basename(path),
            "size": int(entry.get("size") or 0),
        })

    groups: list[dict] = []
    for folder, entries in by_folder.items():
        if len(entries) < 2:
            continue
        tracked = _known_name(known, folder)
        for member in entries:
            # Only the file Radarr names is "the one it knows". Everything else in
            # the folder is the extra copy — deleting that one cannot orphan the movie.
            member["known"] = (bool(tracked) and member["name"] == tracked) if radarr_available else None
        by_class: dict[str, list[dict]] = {}
        for member in entries:
            by_class.setdefault(resolution_class(member["name"]), []).append(member)
        for label in _CLASSES:
            members = by_class.get(label) or []
            if len(members) < 2:
                continue
            # El que sobra, primero: el botón cómodo tiene que ser el seguro.
            members.sort(key=lambda m: (
                0 if m["known"] is False else 1 if m["known"] is None else 2,
                m["name"],
            ))
            groups.append({
                "folder": folder,
                "class": label,
                "title": titles.get(folder) or os.path.basename(folder),
                "files": members,
                "reclaimable": sum(m["size"] for m in members if m["known"] is False),
            })
    groups.sort(key=lambda g: (-g["reclaimable"], g["folder"]))
    return groups
