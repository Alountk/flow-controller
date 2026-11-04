"""Qué ficheros son el mismo título repetido (S1/S2/S3/S7).

Puro: lo que Radarr ya dijo de cada película entra, grupos de duplicados salen.
Sin disco, sin red y sin una segunda definición de «4K» — la clase es la de
`library_class`, la que ya usan los chips de la biblioteca.

La clave es (`tmdbId`, clase), porque el usuario decidió que un 4K y un 1080p de
la misma película conviven a propósito (L2). El tamaño no entra en la
comparación: se devuelve para que el usuario elija cuál sobra.
"""

from __future__ import annotations

from typing import Iterable, Mapping

from domain.library_class import library_class

#: `library_class` label for "Radarr remembers it, the disk does not have it".
NO_FILE = "sin archivo"


def _tmdb_id(movie: Mapping) -> int:
    value = movie.get("tmdb_id")
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return value if value > 0 else 0


def _titles(movie: Mapping) -> list[str]:
    """Los títulos que llegaron, sin inventar ni deduplicar entre películas."""
    raw = movie.get("titles")
    if isinstance(raw, list) and raw:
        return [t for t in raw if isinstance(t, str) and t.strip()]
    title = movie.get("title")
    return [title] if isinstance(title, str) and title.strip() else []


def duplicate_groups(
    movies: Iterable[Mapping], *, path_3d: str = ""
) -> list[dict]:
    """One entry per `(tmdbId, class)` holding two or more files.

    A movie without `tmdbId`, without a file or without a path is left out: an
    absent identifier is not a match, and a file that cannot be named cannot be
    deleted from the screen that lists it.
    """
    buckets: dict[tuple[int, str], list[Mapping]] = {}
    for movie in movies:
        tmdb_id = _tmdb_id(movie)
        path = movie.get("path") if isinstance(movie.get("path"), str) else ""
        if not tmdb_id or not path:
            continue
        klass = library_class(
            has_file=bool(movie.get("has_file")),
            quality=str(movie.get("quality") or ""),
            path=path,
            path_3d=path_3d,
        )
        if klass == NO_FILE:
            continue
        buckets.setdefault((tmdb_id, klass), []).append(movie)

    groups: list[dict] = []
    for (tmdb_id, klass), members in buckets.items():
        if len(members) < 2:
            continue
        titles: list[str] = []
        files: list[dict] = []
        for movie in members:
            for title in _titles(movie):
                if title not in titles:
                    titles.append(title)
            files.append({
                "path": movie["path"],
                "size": movie.get("size_on_disk") or 0,
                "quality": movie.get("quality") or "",
                "title": (movie.get("title") or ""),
            })
        groups.append({
            "tmdb_id": tmdb_id,
            "class": klass,
            "titles": titles,
            "files": files,
        })
    # Determinista, y con los pares que más pesan primero: es lo que se mira.
    groups.sort(key=lambda g: (-len(g["files"]), g["titles"][0] if g["titles"] else ""))
    return groups
