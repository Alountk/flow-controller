"""Cliente Docker mínimo (amule-watchdog T1 / S4-S5, S8) — Engine API por unix socket.

HTTP con la stdlib (`http.client` sobre `socket.AF_UNIX`) al socket
`/var/run/docker.sock`; sin dependencias nuevas. En toda la vida de este módulo
existen DOS llamadas: `GET /containers/json` (resolución, sólo lectura) y UN
shape fijo de reinicio, `POST /containers/{id}/restart?t=<segundos>` (S8) — sin
shell, sin paths del usuario, sin credenciales. El `{id}` del reinicio es
SIEMPRE el `Id` que reportó el engine, nunca texto crudo de configuración.

Resolución del contenedor de aMule (S4): `AMULE_CONTAINER` con el patrón de
`config.py:199-201` (`get_setting("services", "amule", ...)` manda, el entorno
es el default) gana si sale no vacío; si no, coincidencia ÚNICA cuyo nombre Y
imagen casan /amule/i. 0 o ≥2 coincidencias → `DockerResolutionError`
(fail-closed: sólo detección, jamás un reinicio ambiguo).

Todo fallo (socket ausente, engine caído o con error HTTP, contenedor
desaparecido, respuesta inválida, timeout) sube como excepción tipada de este
módulo con una razón legible (`DockerClientError.reason`); nunca un traceback
crudo hacia HTTP y nunca secretos en el mensaje.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import socket
from typing import NamedTuple

from infrastructure.settings_store import get_setting

__all__ = [
    # Cliente y tipos de datos
    "DockerClient",
    "ContainerRef",
    # Excepciones tipadas
    "DockerClientError",
    "DockerConnectionError",
    "DockerContainerGoneError",
    "DockerEngineError",
    "DockerProtocolError",
    "DockerResolutionError",
    "DockerTimeoutError",
    # Constantes
    "DOCKER_SOCKET_PATH",
    "CONNECT_TIMEOUT_S",
    "READ_TIMEOUT_S",
    "DEFAULT_RESTART_STOP_TIMEOUT_S",
]

DOCKER_SOCKET_PATH = "/var/run/docker.sock"
CONNECT_TIMEOUT_S = 2.0
READ_TIMEOUT_S = 10.0
DEFAULT_RESTART_STOP_TIMEOUT_S = 10

_AMULE_RX = re.compile(r"amule", re.IGNORECASE)
_ID_RX = re.compile(r"[A-Za-z0-9_.-]{1,128}")


# --- Excepciones tipadas ---------------------------------------------------


class DockerClientError(Exception):
    """Base: todo fallo del seam Docker sube como una de estas."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class DockerConnectionError(DockerClientError):
    """El socket Docker no existe, no acepta conexión o se cayó."""


class DockerTimeoutError(DockerClientError):
    """El engine no respondió dentro del timeout de conexión/lectura."""


class DockerProtocolError(DockerClientError):
    """El engine respondió algo que no es una respuesta válida de la Engine API."""


class DockerEngineError(DockerClientError):
    """El engine respondió status HTTP no-2xx; `.status` lleva el código."""

    def __init__(self, reason: str, status: int) -> None:
        super().__init__(reason)
        self.status = status


class DockerContainerGoneError(DockerEngineError):
    """HTTP 404: el contenedor desapareció entre la resolución y el reinicio."""


class DockerResolutionError(DockerClientError):
    """Sin contenedor aMule único — fail-closed a sólo-detección, nunca adivinar."""


# --- Modelo ----------------------------------------------------------------


class ContainerRef(NamedTuple):
    """Contenedor resuelto: `Id` del engine más el nombre/imagen por el que casó."""

    id: str
    name: str
    image: str


class _Entry(NamedTuple):
    id: str
    names: tuple[str, ...]
    image: str


def _configured_container_name() -> str:
    # Precedencia exacta de config.py:199-201: settings.json manda, el entorno es el default.
    value = get_setting("services", "amule", "container", default=os.getenv("AMULE_CONTAINER", ""))
    return str(value or "").strip()


# --- Transporte HTTP sobre unix socket -------------------------------------


class _UnixHTTPConnection(http.client.HTTPConnection):
    """HTTPConnection que conecta por AF_UNIX, con timeout de conexión y lectura propios."""

    def __init__(self, socket_path: str, connect_timeout_s: float, read_timeout_s: float) -> None:
        super().__init__("localhost", timeout=connect_timeout_s)
        self._socket_path = socket_path
        self._read_timeout_s = read_timeout_s

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.settimeout(self.timeout)  # connect budget
            sock.connect(self._socket_path)
        except OSError:
            sock.close()
            raise
        sock.settimeout(self._read_timeout_s)  # reads get their own budget
        self.sock = sock


def _engine_message(body: bytes) -> str:
    try:
        data = json.loads(body)
    except ValueError:
        return ""
    if isinstance(data, dict) and isinstance(data.get("message"), str):
        return data["message"][:200]
    return ""


def _raise_engine_error(status: int, body: bytes, action: str) -> None:
    detail = _engine_message(body)
    suffix = f": {detail}" if detail else ""
    if status == 404:
        raise DockerContainerGoneError(f"container gone (HTTP 404) while {action}{suffix}", status)
    raise DockerEngineError(f"docker engine returned HTTP {status} while {action}{suffix}", status)


def _parse_container_list(body: bytes) -> list[_Entry]:
    try:
        data = json.loads(body)
    except ValueError as exc:
        raise DockerProtocolError(f"docker engine sent a non-JSON body while listing containers: {exc}") from exc
    if not isinstance(data, list):
        raise DockerProtocolError("docker engine /containers/json did not return a JSON array")
    entries = []
    for item in data:
        if not isinstance(item, dict):
            raise DockerProtocolError("docker engine listed a non-object container entry")
        cid, image, names = item.get("Id"), item.get("Image"), item.get("Names")
        if not isinstance(cid, str) or not cid or not isinstance(image, str):
            raise DockerProtocolError("docker engine listed a container without Id/Image strings")
        if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
            raise DockerProtocolError("docker engine listed a container with an invalid Names field")
        entries.append(_Entry(id=cid, names=tuple(n.lstrip("/") for n in names), image=image))
    return entries


def _to_ref(entry: _Entry) -> ContainerRef:
    return ContainerRef(id=entry.id, name=entry.names[0] if entry.names else entry.id, image=entry.image)


# --- Cliente ---------------------------------------------------------------


class DockerClient:
    """Cliente mínimo de la Docker Engine API sobre el socket unix (inyectable en tests)."""

    def __init__(
        self,
        socket_path: str = DOCKER_SOCKET_PATH,
        *,
        connect_timeout_s: float = CONNECT_TIMEOUT_S,
        read_timeout_s: float = READ_TIMEOUT_S,
    ) -> None:
        self._socket_path = socket_path
        self._connect_timeout_s = connect_timeout_s
        self._read_timeout_s = read_timeout_s

    # -- resolución (S4) --

    def resolve_container(self) -> ContainerRef:
        """El contenedor de aMule: el configurado si está, si no el único que casa /amule/i.

        0 o ≥2 coincidencias es `DockerResolutionError`: fail-closed, nunca se
        reinicia un contenedor que no está probado que sea el correcto.
        """
        entries = _parse_container_list(self._request("GET", "/containers/json", "listing containers"))
        name = _configured_container_name()
        if name:
            return self._resolve_by_name(entries, name)
        return self._resolve_by_amule_match(entries)

    @staticmethod
    def _resolve_by_name(entries: list[_Entry], name: str) -> ContainerRef:
        wanted = name.lstrip("/")
        matches = [e for e in entries if any(n == wanted for n in e.names)]
        if len(matches) == 1:
            return _to_ref(matches[0])
        if not matches:
            raise DockerResolutionError(f"container '{wanted}' not found among running containers")
        raise DockerResolutionError(f"ambiguous: {len(matches)} containers named '{wanted}'")

    @staticmethod
    def _resolve_by_amule_match(entries: list[_Entry]) -> ContainerRef:
        # Nombre Y imagen, no "nombre o imagen": un helper llamado *amule* con
        # imagen ajena no es aMule, y este seam no puede equivocarse (S4).
        matches = [
            e
            for e in entries
            if _AMULE_RX.search(" ".join(e.names)) and _AMULE_RX.search(e.image)
        ]
        if len(matches) == 1:
            return _to_ref(matches[0])
        if not matches:
            raise DockerResolutionError(
                f"no running container matches name and image /amule/i ({len(entries)} checked) "
                "— refusing to guess, detection-only"
            )
        listed = ", ".join(e.names[0] if e.names else e.id for e in matches)
        raise DockerResolutionError(
            f"ambiguous: {len(matches)} containers match /amule/i ({listed}) "
            "— refusing to restart an ambiguous container"
        )

    # -- reinicio (S8: único shape fijo) --

    def restart_container(
        self, container_id: str, stop_timeout_s: int = DEFAULT_RESTART_STOP_TIMEOUT_S
    ) -> None:
        """`POST /containers/{id}/restart?t=<segundos>` y nada más (S8).

        `container_id` debe ser un id/nombre de engine válido y `stop_timeout_s`
        un entero ≥ 0: ambos viajan verbatim en el shape, sin cuota de inyección.
        """
        if not isinstance(container_id, str) or not _ID_RX.fullmatch(container_id):
            raise ValueError("container_id must match [A-Za-z0-9_.-]{1,128} — the restart shape is fixed (S8)")
        if isinstance(stop_timeout_s, bool) or not isinstance(stop_timeout_s, int) or stop_timeout_s < 0:
            raise ValueError("stop_timeout_s must be a non-negative int (it goes to ?t= verbatim)")
        self._request(
            "POST",
            f"/containers/{container_id}/restart?t={stop_timeout_s}",
            f"restarting container {container_id}",
        )

    # -- transporte --

    def _request(self, method: str, path: str, action: str) -> bytes:
        conn = _UnixHTTPConnection(self._socket_path, self._connect_timeout_s, self._read_timeout_s)
        try:
            conn.request(method, path)
            response = conn.getresponse()
            body = response.read()
            status = response.status
        except TimeoutError as exc:
            raise DockerTimeoutError(
                f"docker engine timed out while {action} "
                f"(connect {self._connect_timeout_s}s / read {self._read_timeout_s}s)"
            ) from exc
        except http.client.HTTPException as exc:
            raise DockerProtocolError(f"docker engine sent an invalid response while {action}: {exc}") from exc
        except OSError as exc:
            raise DockerConnectionError(
                f"docker socket {self._socket_path} unavailable ({exc.strerror or exc})"
            ) from exc
        finally:
            conn.close()
        if status >= 400:
            _raise_engine_error(status, body, action)
        return body
