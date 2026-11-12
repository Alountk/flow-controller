"""Borrar el fichero duplicado que sobra (S5).

Irreversible, así que la mitad del módulo es lo que **no** borra: sólo un
fichero, sólo dentro de las raíces permitidas, y sólo si sigue existiendo. El
listado que el usuario está mirando tiene un minuto; la ruta que llega puede
venir de Radarr (`/data/…`) o de un enlace que apunta fuera.
"""

from __future__ import annotations

import os

import config
from application import gateways


class DuplicateDeleteError(Exception):
    """Un borrado rechazado con el motivo que el usuario tiene que leer."""

    def __init__(self, message: str, *, kind: str = "forbidden") -> None:
        super().__init__(message)
        self.kind = kind


def delete_duplicate(path: str) -> dict:
    """Borra `path` y devuelve la ruta que realmente se borró.

    El `realpath` no es cosmético: es lo que impide que un `..`, un enlace
    simbólico o una raíz que empieza igual (`/mnt/x-evil`) borren fuera de la
    biblioteca.
    """
    if not isinstance(path, str) or not path:
        raise DuplicateDeleteError("ruta vacía")
    # Radarr enseña `/data/...`; el disco vive donde este host lo monta.
    translated = config.host_path(path)
    if not os.path.isabs(translated):
        raise DuplicateDeleteError("la ruta tiene que ser absoluta")
    if not config.path_is_allowed(translated):
        raise DuplicateDeleteError(
            f"fuera de las carpetas permitidas: {translated}"
        )
    if not os.path.exists(translated):
        raise DuplicateDeleteError(
            f"el fichero ya no existe: {translated}", kind="missing"
        )
    if not os.path.isfile(translated):
        raise DuplicateDeleteError(
            f"no es un fichero, y esto sólo borra ficheros: {translated}"
        )
    try:
        os.remove(translated)
    except OSError as exc:
        raise DuplicateDeleteError(
            f"el sistema de ficheros lo rechazó: {exc}", kind="io"
        ) from exc
    invalidate = getattr(gateways.history, "invalidate_movie_classes_for", None)
    if invalidate is not None:
        # Rows cite Radarr's view of the path AND the host's; both, cheaply.
        invalidate(path, translated)
    return {"deleted": translated}
