"""Adapter EC de aMule (S2): la config se lee en cada llamada y cada
operación abre y cierra su propia conexión — EC es petición/respuesta.

Sin `AMULE_URL` o `AMULE_EC_PASSWORD` la operación falla con la razón
compartida «no está configurado» (la misma que la API responde como 502);
los fallos de transporte suben como excepciones tipadas de
`infrastructure.amule_ec_client` para que la ruta los mapee. Jamás
imprime credenciales.
"""

from __future__ import annotations

import time
from urllib.parse import urlparse

import config
from infrastructure.amule_ec_client import AmuleECClient, EC_SEARCH_GLOBAL

__all__ = [
    "amule_add_ed2k",
    "amule_delete",
    "amule_download_search_result",
    "amule_pause",
    "amule_resume",
    "amule_search",
    "amule_set_category",
    "amule_set_priority",
]

#: Segundos entre polls de progreso (el servidor responde "refetch in a moment").
_POLL_INTERVAL = 0.5
#: Plazo total de la búsqueda antes de pedir los resultados que haya (parciales).
_SEARCH_DEADLINE = 15.0


def _host(raw: str) -> str:
    """Host de `AMULE_URL`, con o sin esquema ni puerto web (como el probe)."""
    parsed = urlparse(raw if "://" in raw else f"//{raw}")
    return parsed.hostname or raw


def _client() -> AmuleECClient:
    url = config.AMULE_URL
    password = config.AMULE_EC_PASSWORD
    if not url or not password:
        raise RuntimeError(config.service_unavailable_reason("amule", "amule"))
    return AmuleECClient(_host(url), int(config.AMULE_EC_PORT or "4712"), password)


def amule_search(query: str, mode: int = EC_SEARCH_GLOBAL):
    """Búsqueda completa: connect → start → polls → results → stop."""
    with _client() as client:
        client.search(query, mode)
        deadline = time.monotonic() + _SEARCH_DEADLINE
        while True:
            if client.search_progress() == 0xFFFF:
                break
            if time.monotonic() >= deadline:
                break
            time.sleep(_POLL_INTERVAL)
        results = client.search_results()
        client.search_stop()
    return results


def amule_add_ed2k(ed2k_link: str, category: int | None = None) -> None:
    """Encola un enlace ed2k (`EC_OP_ADD_LINK`) en su propia conexión."""
    with _client() as client:
        client.add_ed2k(ed2k_link, category)


def amule_download_search_result(file_hash, category: int | None = None) -> None:
    """Encola un resultado de búsqueda por hash (`EC_OP_DOWNLOAD_SEARCH_RESULT`)."""
    with _client() as client:
        client.download_search_result(file_hash, category)


def amule_pause(file_hash) -> None:
    with _client() as client:
        client.pause(file_hash)


def amule_resume(file_hash) -> None:
    with _client() as client:
        client.resume(file_hash)


def amule_set_priority(file_hash, priority: int) -> None:
    with _client() as client:
        client.set_priority(file_hash, priority)


def amule_set_category(file_hash, category: int) -> None:
    with _client() as client:
        client.set_category(file_hash, category)


def amule_delete(file_hash) -> None:
    with _client() as client:
        client.delete(file_hash)
