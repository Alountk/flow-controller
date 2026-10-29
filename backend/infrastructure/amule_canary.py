"""Canario EC de aMule (S2/T2): una búsqueda REAL con timeout corto.

Por qué búsqueda y no handshake (S2): la sonda `POST /api/amule/test` seguiría
pasando con el subsistema de búsquedas/cola muerto — justo el fallo reportado
(«cuando se hace cualquier busqueda, no funciona»). Sólo una búsqueda real
ejercita ese subsistema (y el de servidores, compartido: EC no permite cambiar
de servidor por protocolo).

Por qué hilo daemon y no señal: el hang vive dentro de `amule_search` (socket o
poll eterno), así que la búsqueda corre en un hilo propio y `join(timeout)` es
el plazo; daemon para que un hang jamás bloquee el apagado del backend.

Por qué stop por conexión nueva: `amule_search` sólo manda su `search_stop` en
su camino feliz; si cuelga o falla, la búsqueda sigue viva en amuled y el hilo
colgado retiene su propia conexión, así que el canario manda
`EC_OP_SEARCH_STOP` (opcode existente, sin ops nuevas) por una conexión nueva,
en best-effort, en todo resultado fallido.

La config se lee en cada llamada vía `amule_service` (misma regla que S7); los
tests jamás abren red real. `run_canary` nunca lanza: devuelve un
`CanaryResult` tipado (ok, o fallo con `status` + `reason`), clasificado con
excepciones tipadas al estilo de `amule_ec_client`.
"""

from __future__ import annotations

import threading
from typing import Literal, NamedTuple
from urllib.parse import urlparse

import config
from infrastructure import amule_service
from infrastructure.amule_ec_client import (
    AmuleECClient,
    AmuleECConnectionError,
    AmuleECError,
    AmuleECTimeoutError,
)

__all__ = [
    "AmuleCanaryError",
    "AmuleCanaryTimeoutError",
    "AmuleCanaryConnectionError",
    "AmuleCanaryUnconfiguredError",
    "AmuleCanarySearchError",
    "CanaryResult",
    "CanaryStatus",
    "DEFAULT_CANARY_TIMEOUT",
    "run_canary",
]

#: Seconds a healthy trivial search must answer within before it counts as hung.
DEFAULT_CANARY_TIMEOUT = 10.0

#: Plazo del stop de limpieza: nunca debe frenar al watchdog.
_STOP_TIMEOUT = 3.0

#: Consulta trivial: ruido único → mínimo trabajo para amuled, cero descargas.
_CANARY_QUERY = "flow-controller-canary"


# --- Resultado tipado ------------------------------------------------------


CanaryStatus = Literal["ok", "timeout", "connection", "unconfigured", "error"]


class CanaryResult(NamedTuple):
    """Outcome typed as `ok`, or failure with `status` + `reason` (never raises)."""

    ok: bool
    status: CanaryStatus
    reason: str = ""


# --- Excepciones tipadas ---------------------------------------------------


class AmuleCanaryError(Exception):
    """Base: every canary failure is one of these; `status` feeds the result."""

    status: CanaryStatus = "error"


class AmuleCanaryTimeoutError(AmuleCanaryError):
    """The search did not answer within the canary timeout."""

    status = "timeout"


class AmuleCanaryConnectionError(AmuleCanaryError):
    """amuled refused or dropped the EC connection."""

    status = "connection"


class AmuleCanaryUnconfiguredError(AmuleCanaryError):
    """`AMULE_URL`/`AMULE_EC_PASSWORD` missing (same reason `amule_search` raises)."""

    status = "unconfigured"


class AmuleCanarySearchError(AmuleCanaryError):
    """The search answered, but with a failure."""

    status = "error"


def _classify(exc: Exception) -> AmuleCanaryError:
    if isinstance(exc, AmuleCanaryError):
        return exc
    # `amule_service._client` signals missing config with a bare RuntimeError.
    if isinstance(exc, RuntimeError):
        return AmuleCanaryUnconfiguredError(f"not configured: {exc}")
    # TimeoutError is an OSError: check it before the connection bucket.
    if isinstance(exc, (AmuleECTimeoutError, TimeoutError)):
        return AmuleCanaryTimeoutError(f"timeout: {exc}")
    if isinstance(exc, (AmuleECConnectionError, ConnectionRefusedError, OSError)):
        return AmuleCanaryConnectionError(f"connection failed: {exc}")
    if isinstance(exc, AmuleECError):
        return AmuleCanarySearchError(f"search failed: {exc}")
    return AmuleCanarySearchError(f"search failed: {exc or exc.__class__.__name__}")


# --- Limpieza --------------------------------------------------------------


def _stop_search() -> None:
    """Best-effort `search_stop` on a fresh connection (idempotent, never raises)."""
    try:
        url = config.AMULE_URL
        password = config.AMULE_EC_PASSWORD
        if not url or not password:
            return
        parsed = urlparse(url if "://" in url else f"//{url}")
        host = parsed.hostname or url
        with AmuleECClient(
            host, int(config.AMULE_EC_PORT or "4712"), password, timeout=_STOP_TIMEOUT
        ) as client:
            client.search_stop()
    except Exception:
        pass  # cleanup is best-effort: the canary outcome already carries the failure


# --- Canario ---------------------------------------------------------------


def run_canary(timeout: float = DEFAULT_CANARY_TIMEOUT) -> CanaryResult:
    """Run ONE trivial real search with a deadline; ok or typed failure."""
    results: list = []
    errors: list[Exception] = []

    def _target() -> None:
        try:
            results.append(amule_service.amule_search(_CANARY_QUERY))
        except Exception as exc:
            errors.append(exc)  # surface as data: this worker must never die loudly

    thread = threading.Thread(target=_target, name="amule-canary", daemon=True)
    thread.start()
    thread.join(timeout)

    if thread.is_alive():
        failure: AmuleCanaryError = AmuleCanaryTimeoutError(
            f"timeout: search exceeded {timeout:g}s"
        )
    elif errors:
        failure = _classify(errors[0])
    elif results:
        return CanaryResult(True, "ok")
    else:
        failure = AmuleCanarySearchError("search ended without a result")

    _stop_search()
    return CanaryResult(False, failure.status, str(failure))
