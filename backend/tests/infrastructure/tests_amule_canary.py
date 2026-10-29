"""T2 (S2/S5/S8): canario EC de aMule — una búsqueda REAL con timeout corto.

El handshake NO detecta el fallo reportado: `POST /api/amule/test` sigue
pasando con el subsistema de búsquedas muerto («cuando se hace cualquier
busqueda, no funciona»). Estos tests jamás abren red real: se stubbea
`amule_service.amule_search` (monkeypatch) y el cliente de limpieza se
sustituye por un doble que sólo registra `search_stop`.
"""

from __future__ import annotations

import threading

import pytest

import config
from infrastructure import amule_canary, amule_service
from infrastructure.amule_ec_client import (
    AmuleECCommandError,
    AmuleECConnectionError,
    AmuleECTimeoutError,
)


class FakeStopClient:
    """Double for the cleanup client: records `search_stop`, opens no socket."""

    instances: list["FakeStopClient"] = []

    def __init__(self, host, port, password, **kwargs):
        self.calls: list[str] = []
        FakeStopClient.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def search_stop(self):
        self.calls.append("search_stop")


def _search_was_stopped() -> bool:
    return any("search_stop" in client.calls for client in FakeStopClient.instances)


@pytest.fixture(autouse=True)
def no_real_network(monkeypatch):
    """No test may open a socket: fake cleanup client + invented credentials."""
    FakeStopClient.instances = []
    monkeypatch.setattr(amule_canary, "AmuleECClient", FakeStopClient)
    monkeypatch.setattr(config, "AMULE_URL", "tcp://amule.test:4711")
    monkeypatch.setattr(config, "AMULE_EC_PORT", "9999")
    monkeypatch.setattr(config, "AMULE_EC_PASSWORD", "deadbeefdeadbeefdeadbeefdeadbeef")


# ── (a) success: the search answers within the timeout ──────────────────────


def test_search_answering_within_the_timeout_is_ok(monkeypatch):
    calls = []

    def quick_search(query, mode=None):
        calls.append(query)
        return []

    monkeypatch.setattr(amule_service, "amule_search", quick_search)

    result = amule_canary.run_canary(timeout=1.0)

    assert result.ok is True
    assert result.status == "ok"
    assert result.reason == ""
    assert len(calls) == 1  # exactly ONE trivial real search


# ── (b) timeout: failure AND cleanup still invoked (search stopped) ─────────


def test_hung_search_fails_with_timeout_and_still_stops_the_search(monkeypatch):
    release = threading.Event()

    def hung_search(query, mode=None):
        release.wait(5)  # hangs past the canary timeout
        return []

    monkeypatch.setattr(amule_service, "amule_search", hung_search)
    try:
        result = amule_canary.run_canary(timeout=0.05)
    finally:
        release.set()

    assert result.ok is False
    assert result.status == "timeout"
    assert "timeout" in result.reason
    assert _search_was_stopped()  # cleanup still invoked: the search was stopped


# ── (c) connection refused: failure with a reason ────────────────────────────


def test_connection_refused_fails_with_a_connection_reason(monkeypatch):
    def refused(query, mode=None):
        raise AmuleECConnectionError("no se pudo conectar con amuled")

    monkeypatch.setattr(amule_service, "amule_search", refused)

    result = amule_canary.run_canary(timeout=1.0)

    assert result.ok is False
    assert result.status == "connection"
    assert result.reason


# ── (d) unconfigured: failure with a reason, never raises out ────────────────


def test_missing_amule_url_or_password_fails_without_raising(monkeypatch):
    monkeypatch.setattr(config, "AMULE_URL", "")
    monkeypatch.setattr(config, "AMULE_EC_PASSWORD", "")

    # Real `amule_search` raises the "not configured" RuntimeError internally.
    result = amule_canary.run_canary(timeout=1.0)

    assert result.ok is False
    assert result.status == "unconfigured"
    assert "configured" in result.reason


# ── triangulate: classification and cleanup corner cases ─────────────────────


def test_default_timeout_is_short_and_configurable():
    assert 0 < amule_canary.DEFAULT_CANARY_TIMEOUT <= 30


def test_ec_layer_timeout_is_reported_as_timeout(monkeypatch):
    def slow(query, mode=None):
        raise AmuleECTimeoutError("amuled no responde (timeout)")

    monkeypatch.setattr(amule_service, "amule_search", slow)

    result = amule_canary.run_canary(timeout=1.0)

    assert result.ok is False
    assert result.status == "timeout"
    assert "timeout" in result.reason


def test_builtin_connection_refused_maps_to_connection(monkeypatch):
    def refused(query, mode=None):
        raise ConnectionRefusedError(111, "Connection refused")

    monkeypatch.setattr(amule_service, "amule_search", refused)

    result = amule_canary.run_canary(timeout=1.0)

    assert result.ok is False
    assert result.status == "connection"


def test_unconfigured_reason_from_the_stub_is_reported_as_unconfigured(monkeypatch):
    def unconfigured(query, mode=None):
        raise RuntimeError("amule no está configurado (faltan la URL o la API key)")

    monkeypatch.setattr(amule_service, "amule_search", unconfigured)

    result = amule_canary.run_canary(timeout=1.0)

    assert result.ok is False
    assert result.status == "unconfigured"


def test_search_failure_is_reported_as_error_and_still_stops_the_search(monkeypatch):
    def broken(query, mode=None):
        raise AmuleECCommandError("EC_OP_FAILED")

    monkeypatch.setattr(amule_service, "amule_search", broken)

    result = amule_canary.run_canary(timeout=1.0)

    assert result.ok is False
    assert result.status == "error"
    assert result.reason
    assert _search_was_stopped()


def test_cleanup_is_best_effort_and_never_raises(monkeypatch):
    class ExplodingStopClient(FakeStopClient):
        def search_stop(self):
            raise AmuleECConnectionError("no se pudo conectar con amuled")

    monkeypatch.setattr(amule_canary, "AmuleECClient", ExplodingStopClient)

    def broken(query, mode=None):
        raise AmuleECCommandError("EC_OP_FAILED")

    monkeypatch.setattr(amule_service, "amule_search", broken)

    result = amule_canary.run_canary(timeout=1.0)  # must not raise

    assert result.ok is False
    assert result.status == "error"


def test_a_strange_failure_never_escapes_the_canary(monkeypatch):
    def weird(query, mode=None):
        raise ValueError("boom")

    monkeypatch.setattr(amule_service, "amule_search", weird)

    result = amule_canary.run_canary(timeout=1.0)

    assert result.ok is False
    assert result.status == "error"
    assert "boom" in result.reason
