"""T3 (S2): seam EC de aMule — config leída en cada llamada, razón
«no está configurado», adapter con conexión por operación y `bind` validado.

Ningún test abre red real: el adapter se prueba con un `AmuleECClient`
falso inyectado y credenciales inventadas (jamás .env.local ni secretos).
"""

from __future__ import annotations

import pytest

import config
from application import gateways
from application.ports import (
    AmuleECService,
    ArrClient,
    CredentialsStore,
    HistoryStore,
    SettingsStore,
    SystemProbe,
    port_members,
)
from infrastructure import amule_service


# ── S2: servicio conocido y razón «no está configurado» ──────────────────────


@pytest.fixture
def amule_entry():
    """Entrada `amule` real de SERVICES; se restaura al terminar cada test.

    `monkeypatch.setitem` no sirve aquí: SERVICES es lista, no dict.
    """
    idx = next(i for i, s in enumerate(config.SERVICES) if s["key"] == "amule")
    original = config.SERVICES[idx]

    def _set(**overrides):
        entry = {"key": "amule", "kind": "amule", "url": "", "api_key": "",
                 "configured": False}
        entry.update(overrides)
        config.SERVICES[idx] = entry
        return entry

    yield _set
    config.SERVICES[idx] = original


def test_amule_service_entry_is_known_and_reason_reads_not_configured(amule_entry):
    amule_entry(configured=False)
    reason = config.service_unavailable_reason("amule", "amule")
    assert "no está configurado" in reason
    assert "desconocido" not in reason
    assert config.find_service("amule", "amule") is None


def test_amule_kind_is_isolated_from_arr_loops(amule_entry):
    amule_entry(url="amule.test", configured=True)
    # Configurado sí se ve… pero NUNCA dentro de los bucles de tipo "arr".
    assert config.find_service("amule", "amule") is not None
    assert all(
        s["key"] != "amule" for s in config.configured_services("arr")
    )


# ── S2: adapter fail-closed sin configurar ───────────────────────────────────


@pytest.mark.parametrize(
    "fn,args",
    [
        (amule_service.amule_search, ("ubuntu",)),
        (amule_service.amule_add_ed2k, ("ed2k://|file|x|",)),
        (amule_service.amule_pause, ("0" * 32,)),
        (amule_service.amule_resume, ("0" * 32,)),
        (amule_service.amule_set_priority, ("0" * 32, 1)),
        (amule_service.amule_set_category, ("0" * 32, 3)),
        (amule_service.amule_delete, ("0" * 32,)),
        (amule_service.amule_download_search_result, ("0" * 32,)),
    ],
)
def test_unconfigured_adapter_raises_the_not_configured_reason(
    monkeypatch, fn, args
):
    monkeypatch.setattr(config, "AMULE_URL", "")
    monkeypatch.setattr(config, "AMULE_EC_PORT", "4712")
    monkeypatch.setattr(config, "AMULE_EC_PASSWORD", "")
    with pytest.raises(RuntimeError, match="no está configurado"):
        fn(*args)


# ── S2/S7: una conexión por operación, host/puerto/password desde config ─────


class FakeClient:
    """Sustituto de AmuleECClient: registra ctor y operaciones, sin red."""

    instances: list["FakeClient"] = []

    def __init__(self, host, port, password, **kwargs):
        self.host = host
        self.port = port
        self.password = password
        self.kwargs = kwargs
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
        return "3.0.1"

    def close(self):
        self.closed = True
        self.calls.append(("close",))

    def search(self, query, mode, **kwargs):
        self.calls.append(("search", query, mode))
        return "Search in progress. Refetch results in a moment!"

    def search_progress(self):
        # Primer poll sin terminar, segundo finished (0xFFFF) → bucle sale.
        pending = sum(1 for c in self.calls if c[0] == "progress")
        self.calls.append(("progress",))
        return 0xFFFF if pending >= 1 else 0

    def search_results(self, detail=2):
        self.calls.append(("results",))
        from infrastructure.amule_ec_client import SearchResult

        self._results = [
            SearchResult(
                name="ubuntu.iso", size=1024, file_hash=b"\x01" * 16,
                sources=3, sources_xfer=0, status=0,
            )
        ]
        return self._results

    def search_stop(self):
        self.calls.append(("stop",))

    def add_ed2k(self, link, category=None):
        self.calls.append(("add_ed2k", link, category))

    def download_search_result(self, file_hash, category=None):
        self.calls.append(("download_search_result", file_hash, category))

    def pause(self, file_hash):
        self.calls.append(("pause", file_hash))

    def resume(self, file_hash):
        self.calls.append(("resume", file_hash))

    def set_priority(self, file_hash, priority):
        self.calls.append(("set_priority", file_hash, priority))

    def set_category(self, file_hash, category):
        self.calls.append(("set_category", file_hash, category))

    def delete(self, file_hash):
        self.calls.append(("delete", file_hash))


@pytest.fixture(autouse=True)
def _fresh_fakes(monkeypatch):
    FakeClient.instances.clear()
    monkeypatch.setattr(amule_service, "AmuleECClient", FakeClient)
    monkeypatch.setattr(amule_service, "_POLL_INTERVAL", 0)
    monkeypatch.setattr(config, "AMULE_URL", "tcp://amule.test:4711")
    monkeypatch.setattr(config, "AMULE_EC_PORT", "9999")
    monkeypatch.setattr(config, "AMULE_EC_PASSWORD", "deadbeefdeadbeefdeadbeefdeadbeef")
    yield
    FakeClient.instances.clear()


def test_search_connects_polls_results_and_stops():
    results = amule_service.amule_search("ubuntu", 1)
    assert [r.name for r in results] == ["ubuntu.iso"]
    client = FakeClient.instances[0]
    # urlparse normaliza el host aunque AMULE_URL traiga esquema y puerto web.
    assert (client.host, client.port) == ("amule.test", 9999)
    assert client.password == "deadbeefdeadbeefdeadbeefdeadbeef"
    names = [c[0] for c in client.calls]
    assert names[0] == "connect"
    assert ("search", "ubuntu", 1) in client.calls
    assert names.index("results") > names.index("progress")
    assert names[-2:] == ["stop", "close"]
    assert client.closed is True


def test_search_accepts_a_bare_host_in_amule_url(monkeypatch):
    monkeypatch.setattr(config, "AMULE_URL", "amule.test")
    amule_service.amule_search("q", 0)
    assert FakeClient.instances[0].host == "amule.test"


def test_search_deadline_still_returns_results_without_signal(monkeypatch):
    # Sin 0xFFFF jamás (como el aMule real en vivo): sale por plazo y
    # aun así pide resultados y cierra la búsqueda.
    monkeypatch.setattr(amule_service, "_SEARCH_DEADLINE", 0)
    monkeypatch.setattr(
        FakeClient, "search_progress", lambda self: 0
    )
    results = amule_service.amule_search("q", 1)
    assert len(results) == 1
    names = [c[0] for c in FakeClient.instances[0].calls]
    assert "stop" in names and names[-1] == "close"


def test_queue_operations_open_their_own_connection_and_close():
    amule_service.amule_pause("aa" * 16)
    amule_service.amule_resume("aa" * 16)
    amule_service.amule_set_priority("aa" * 16, 2)
    amule_service.amule_set_category("aa" * 16, 4)
    amule_service.amule_delete("aa" * 16)
    amule_service.amule_add_ed2k("ed2k://|file|x|", 7)
    amule_service.amule_download_search_result("aa" * 16, 7)
    assert len(FakeClient.instances) == 7  # una conexión por operación
    assert all(c.closed for c in FakeClient.instances)
    last = FakeClient.instances
    assert ("pause", "aa" * 16) in last[0].calls
    assert ("resume", "aa" * 16) in last[1].calls
    assert ("set_priority", "aa" * 16, 2) in last[2].calls
    assert ("set_category", "aa" * 16, 4) in last[3].calls
    assert ("delete", "aa" * 16) in last[4].calls
    assert ("add_ed2k", "ed2k://|file|x|", 7) in last[5].calls
    assert ("download_search_result", "aa" * 16, 7) in last[6].calls


# ── Seam: puerto declarado, gateway delega, bind valida ──────────────────────


def test_port_declares_the_whole_ec_surface():
    members = set(port_members(AmuleECService))
    assert {
        "amule_search",
        "amule_add_ed2k",
        "amule_download_search_result",
        "amule_pause",
        "amule_resume",
        "amule_set_priority",
        "amule_set_category",
        "amule_delete",
    } <= members


def test_gateway_delegates_to_the_bound_adapter(monkeypatch):
    class Recorder:
        def amule_search(self, query, mode=1):
            return [("rec", query, mode)]

        def amule_pause(self, file_hash):
            return [("pause", file_hash)]

    monkeypatch.setattr(gateways, "_amule", Recorder())
    assert gateways.amule_search("q", 2) == [("rec", "q", 2)]
    assert gateways.amule_pause("hh") == [("pause", "hh")]


def _satisfying(*ports):
    """Dummy que satisface cada puerto (sólo atributos, como `runtime_checkable`)."""

    class Dummy:
        pass

    for port in ports:
        for name in port_members(port):
            setattr(Dummy, name, lambda *a, **k: None)
    return Dummy()


def test_bind_rejects_an_adapter_that_misses_the_port():
    # Los adaptadores requeridos cumplen sus puertos, así que `bind` llega
    # a la validación de `amule` — que debe rechazar el objeto. El rechazo
    # ocurre ANTES de `globals().update`: el estado global no se toca.
    with pytest.raises(TypeError, match="does not satisfy AmuleECService"):
        gateways.bind(
            arr=_satisfying(ArrClient),
            settings=_satisfying(SettingsStore),
            sqlite_history=_satisfying(HistoryStore),
            credentials_module=_satisfying(CredentialsStore),
            system=_satisfying(SystemProbe),
            scan=lambda: None,
            amule=object(),
        )
