"""T2 (S2): `POST /api/amule/test` — la sonda EC de sólo lectura.

El endpoint abre `AmuleECClient` con la configuración vigente (settings/env en
el momento de la llamada, la misma resolución que `amule_service._client` pero
sin su `RuntimeError`), hace connect+handshake y cierra en `finally`. Responde
SIEMPRE HTTP 200 con `{ok, detail}`.

Regla dura: la sonda NUNCA encola ni busca nada. El stub de estas pruebas
**revienta** si se invoca cualquier operación de búsqueda o de cola, así que un
`ok: true` sólo es posible si la llamada fue handshake y nada más.

Ningún test abre red real ni usa secretos de entornos reales.
"""

import copy
import logging

import pytest

import config
from app import app
from fastapi.testclient import TestClient
from infrastructure import credentials
from infrastructure import settings_store as settings_mod
from infrastructure.amule_ec_client import AmuleECConnectionError
from interfaces.http.routes import settings as settings_route

client = TestClient(app, raise_server_exceptions=False)

SECRET = "EC-SECRETO-FALSO-4242"


class FakeECClient:
    """Sustituto de `AmuleECClient`: registra ctor/connect/close y RUGE en cola."""

    instances: list["FakeECClient"] = []
    version: str | None = "0.4.9"
    error: BaseException | None = None

    def __init__(self, host, port, password, **kwargs):
        self.host = host
        self.port = port
        self.password = password
        self.calls: list[str] = []
        self.closed = False
        FakeECClient.instances.append(self)

    def connect(self):
        self.calls.append("connect")
        if FakeECClient.error is not None:
            raise FakeECClient.error
        return FakeECClient.version

    def close(self):
        self.calls.append("close")
        self.closed = True

    # ── lo que una sonda read-only JAMÁS hace ────────────────────────────────

    def _forbidden(self, *args, **kwargs):
        raise AssertionError("la sonda EC no debe invocar operaciones de búsqueda o cola")

    search = search_progress = search_results = search_stop = _forbidden
    add_ed2k = download_search_result = pause = resume = _forbidden
    set_priority = set_category = delete = delete_disk = categories = _forbidden


@pytest.fixture
def stub_client(monkeypatch):
    FakeECClient.instances = []
    FakeECClient.version = "0.4.9"
    FakeECClient.error = None
    monkeypatch.setattr(settings_route, "amule_ec_client", FakeECClient)


@pytest.fixture
def configured(monkeypatch):
    """Config aMule inventada; el PUERTO viene de AMULE_EC_PORT, no de la URL."""
    monkeypatch.setattr(config, "AMULE_URL", "http://amule.test:8080")
    monkeypatch.setattr(config, "AMULE_EC_PORT", "4712")
    monkeypatch.setattr(config, "AMULE_EC_PASSWORD", SECRET)


@pytest.fixture
def unconfigured(monkeypatch):
    """Sin URL en la config: el endpoint jamás debe intentar abrir la red."""
    monkeypatch.setattr(config, "AMULE_URL", "")
    monkeypatch.setattr(config, "AMULE_EC_PORT", "4712")
    monkeypatch.setattr(config, "AMULE_EC_PASSWORD", SECRET)


# ── ok: true ─────────────────────────────────────────────────────────────────


def test_success_reports_the_server_version(configured, stub_client):
    resp = client.post("/api/amule/test")

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True, "detail": "0.4.9"}
    (fake,) = FakeECClient.instances
    # Misma resolución que amule_service._client: host de la URL, puerto del
    # AMULE_EC_PORT, contraseña de la config — y nada más.
    assert (fake.host, fake.port, fake.password) == ("amule.test", 4712, SECRET)
    assert fake.calls == ["connect", "close"]
    assert fake.closed
    assert SECRET not in resp.text


def test_success_without_a_server_version_says_conectado(configured, stub_client):
    FakeECClient.version = None

    resp = client.post("/api/amule/test")

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True, "detail": "conectado"}


# ── ok: false ────────────────────────────────────────────────────────────────


def test_typed_error_is_reported_as_tipo_mensaje(configured, stub_client):
    FakeECClient.error = AmuleECConnectionError("no se pudo conectar con amuled")

    resp = client.post("/api/amule/test")

    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "ok": False,
        "detail": "AmuleECConnectionError: no se pudo conectar con amuled",
    }
    assert SECRET not in resp.text
    (fake,) = FakeECClient.instances
    assert fake.closed, "close() debe ejecutarse en finally aunque connect() falle"


@pytest.mark.parametrize("missing", ["url", "password"])
def test_unconfigured_shares_the_reason_verbatim(monkeypatch, stub_client, missing):
    monkeypatch.setattr(config, "AMULE_URL", "" if missing == "url" else "http://amule.test:8080")
    monkeypatch.setattr(config, "AMULE_EC_PORT", "4712")
    monkeypatch.setattr(config, "AMULE_EC_PASSWORD", "" if missing == "password" else SECRET)

    resp = client.post("/api/amule/test")

    expected = config.service_unavailable_reason("amule", "amule")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": False, "detail": expected}
    assert "no está configurado" in expected
    assert FakeECClient.instances == [], "sin config no se debe construir ningún cliente"
    assert SECRET not in resp.text


# ── read-only de verdad ──────────────────────────────────────────────────────


def test_no_search_or_queue_operation_is_ever_invoked(configured, stub_client):
    """El stub lanza AssertionError ante cualquier op de búsqueda/cola."""
    resp = client.post("/api/amule/test")

    assert resp.json()["ok"] is True
    (fake,) = FakeECClient.instances
    assert fake.calls == ["connect", "close"], (
        f"la sonda debe ser connect+handshake y cerrar; vio: {fake.calls}"
    )


# ── contrato de autenticación ────────────────────────────────────────────────


def test_requires_the_api_key(monkeypatch, unconfigured):
    data = copy.deepcopy(settings_mod.get_settings())
    credentials.set_app_key(data, "clave-de-prueba-amule")
    monkeypatch.setattr(settings_mod, "_settings", data)

    assert client.post("/api/amule/test").status_code == 401
    ok = client.post("/api/amule/test", headers={"X-Api-Key": "clave-de-prueba-amule"})
    # Con clave sigue respondiendo 200 — el veredicto vive en el cuerpo.
    assert ok.status_code == 200


# ── la contraseña jamás se loguea ────────────────────────────────────────────


def test_the_password_never_reaches_the_logs(configured, stub_client, caplog):
    with caplog.at_level(logging.DEBUG):
        FakeECClient.error = AmuleECConnectionError("fallo de prueba")
        client.post("/api/amule/test")
        FakeECClient.error = None
        client.post("/api/amule/test")

    assert SECRET not in caplog.text, "ningún log debe contener la contraseña EC"
