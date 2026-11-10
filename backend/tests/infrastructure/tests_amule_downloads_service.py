"""Servicio de descargas de aMule (pagina-descargas T1/S2): una conexión por
operación y la lista de la cola tal cual la construye el cliente EC.

`amule_downloads()` sólo abre su conexión y delega en `get_downloads()`: la
fila S2 (con `state`/`eta_seconds` derivados y `source: "amule"`) la construye
el cliente (tests_amule_ec_downloads). Sin configurar, la negativa honesta
compartida «no está configurado», exactamente como sus hermanos. Ningún test
abre red real.
"""

from __future__ import annotations

import pytest

import config
from application import gateways
from infrastructure import amule_service

ROWS = [
    {
        "hash": "00112233445566778899aabbccddeeff",
        "name": "ubuntu.iso",
        "size_full": 1000,
        "size_done": 400,
        "progress_pct": 40.0,
        "speed": 100,
        "eta_seconds": 6,
        "state": "downloading",
        "stopped": False,
        "status_code": 0,
        "priority": 1,
        "category": 0,
        "sources": 5,
        "ed2k_link": "ed2k://|file|ubuntu.iso|1000|00112233445566778899aabbccddeeff|/",
        "source": "amule",
    }
]


class FakeClient:
    """Sustituto de AmuleECClient: registra operaciones, sin red."""

    instances: list["FakeClient"] = []

    def __init__(self, host, port, password, **kwargs):
        self.calls: list[tuple] = []
        self.closed = False
        FakeClient.instances.append(self)

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *_exc):
        self.close()
        return False

    def connect(self):
        self.calls.append(("connect",))

    def close(self):
        self.closed = True

    def get_downloads(self):
        self.calls.append(("get_downloads",))
        return list(ROWS)


@pytest.fixture(autouse=True)
def _fresh_fakes(monkeypatch):
    FakeClient.instances.clear()
    monkeypatch.setattr(amule_service, "AmuleECClient", FakeClient)
    monkeypatch.setattr(config, "AMULE_URL", "tcp://amule.test:4711")
    monkeypatch.setattr(config, "AMULE_EC_PORT", "9999")
    monkeypatch.setattr(config, "AMULE_EC_PASSWORD", "deadbeefdeadbeefdeadbeefdeadbeef")
    yield


# ── Una conexión por operación (el patrón de amule_servers/amule_categories) ─


def test_downloads_list_open_their_own_connection_and_close():
    assert amule_service.amule_downloads() == ROWS
    assert len(FakeClient.instances) == 1
    client = FakeClient.instances[0]
    assert ("get_downloads",) in client.calls
    assert client.closed


# ── Sin configurar: la negativa honesta compartida, sin tocar el cliente ─────


def test_unconfigured_downloads_raise_the_not_configured_reason(monkeypatch):
    monkeypatch.setattr(config, "AMULE_URL", "")
    monkeypatch.setattr(config, "AMULE_EC_PORT", "4712")
    monkeypatch.setattr(config, "AMULE_EC_PASSWORD", "")
    with pytest.raises(RuntimeError, match="no está configurado"):
        amule_service.amule_downloads()
    assert not FakeClient.instances


# ── Seam: el gateway delega en el adaptador vinculado ────────────────────────


def test_gateway_delegates_downloads_to_the_bound_adapter(monkeypatch):
    class Recorder:
        def amule_downloads(self):
            return [("rec",)]

    monkeypatch.setattr(gateways, "_amule", Recorder())
    assert gateways.amule_downloads() == [("rec",)]
