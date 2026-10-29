"""Adapter EC de aMule (S2): la config se lee en cada llamada y cada
operación abre y cierra su propia conexión — EC es petición/respuesta.

Sin `AMULE_URL` o `AMULE_EC_PASSWORD` la operación falla con la razón
compartida «no está configurado» (la misma que la API responde como 502);
los fallos de transporte suben como excepciones tipadas de
`infrastructure.amule_ec_client` para que la ruta los mapee. Jamás
imprime credenciales.
"""

from __future__ import annotations

import socket
import time
from urllib.parse import urlparse

import config
from infrastructure.amule_ec_client import AmuleECClient, EC_SEARCH_GLOBAL

__all__ = [
    "amule_add_ed2k",
    "amule_categories",
    "amule_delete",
    "amule_download_search_result",
    "amule_pause",
    "amule_resume",
    "amule_search",
    "amule_server_add",
    "amule_server_connect",
    "amule_server_remove",
    "amule_servers",
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


# -- servidores (T2/S3) --


def amule_servers() -> list:
    """Servidores de aMule (nombre, dirección, estado) en su propia conexión."""
    with _client() as client:
        return client.server_list()


def amule_server_add(address: str, name: str = "") -> None:
    """Añade un servidor (`EC_OP_SERVER_ADD`).

    La dirección viaja VERBATIM: el core la parte por ':' él mismo
    (`Get_EC_Response_Server_Add`), y un parseo previo aquí sólo podría
    divergir del suyo.
    """
    with _client() as client:
        client.server_add(address, name)


def amule_server_remove(address: str) -> None:
    """Quita un servidor «host:puerto» (`EC_OP_SERVER_REMOVE`)."""
    ipv4, port = _server_target(address)
    with _client() as client:
        client.server_remove(ipv4, port)


def amule_server_connect(address: str) -> None:
    """Pide al core conectar con «host:puerto» (`EC_OP_SERVER_CONNECT`)."""
    ipv4, port = _server_target(address)
    with _client() as client:
        client.server_connect(ipv4, port)


def _server_target(address: str) -> tuple[str, int]:
    """«host:puerto» → (IP numérica, puerto 1-65535) para el tag IPV4.

    El core sólo admite binario en `EC_TAG_SERVER` (resuelve con
    `GetServerByIPTCP`), así que un nombre se resuelve AQUÍ; todo lo que no
    sea utilizable sube como `ValueError` en español, nombrando el fallo.
    """
    host, sep, port_text = str(address).strip().rpartition(":")
    if not sep or not host:
        raise ValueError(f"dirección inválida: falta el puerto en «{address}»")
    try:
        port = int(port_text)
    except ValueError as exc:
        raise ValueError(f"dirección inválida: «{port_text}» no es un puerto válido") from exc
    if not 1 <= port <= 65535:
        raise ValueError(f"dirección inválida: el puerto {port} está fuera de rango (1-65535)")
    return _resolve_ipv4(host), port


def _resolve_ipv4(host: str) -> str:
    """Host numérico tal cual; nombre resuelto a IPv4 o `ValueError`."""
    try:
        socket.inet_aton(host)
        return host
    except OSError:
        pass
    try:
        infos = socket.getaddrinfo(host, None, socket.AF_INET, socket.SOCK_STREAM)
    except OSError as exc:
        raise ValueError(f"dirección inválida: no se pudo resolver «{host}»") from exc
    if not infos:
        raise ValueError(f"dirección inválida: «{host}» no resuelve a ninguna IP")
    return infos[0][4][0]


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


def amule_categories() -> dict:
    """Categorías de aMule como `{título: índice}`, en su propia conexión."""
    with _client() as client:
        return client.categories()


def amule_delete(file_hash, delete_files: bool = False) -> None:
    """Borra la descarga de la cola de aMule.

    Mapeo semántico (decisión L7): con `delete_files`, un fichero COMPLETO
    (listado en compartidos) sale del disco vía `KNOWNFILE_DELETE` (0x6A) y
    todo lo demás se descarta vía `PARTFILE_DELETE` (0x1D); sin
    `delete_files`, siempre `PARTFILE_DELETE`.
    """
    with _client() as client:
        if delete_files and client.delete_disk(file_hash):
            return
        client.delete(file_hash)
