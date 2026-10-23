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


# ── sonda de lo ESCRITO: body candidato opcional (config-1x1 S1/T2) ──────────
#
# `POST /api/amule/test` acepta `{url?, ec_port?, ec_password?}` al estilo del
# precedente `POST /api/services/test`: lo escrito en la tarjeta manda para
# ESTA llamada; lo ausente, vacío o enmascarado cae a lo guardado. Sin body,
# el camino guardado de siempre — byte a byte.

TYPED_URL = "http://10.0.0.9:9000"
TYPED_PORT = "5000"
TYPED_SECRET = "CLAVE-CANDIDATA-777"


def test_what_was_typed_is_what_gets_probed(configured, stub_client):
    """Con body, los valores escritos mandan sobre los guardados."""
    resp = client.post(
        "/api/amule/test",
        json={"url": TYPED_URL, "ec_port": TYPED_PORT, "ec_password": TYPED_SECRET},
    )

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True, "detail": "0.4.9"}
    (fake,) = FakeECClient.instances
    assert (fake.host, fake.port, fake.password) == ("10.0.0.9", 5000, TYPED_SECRET)
    assert TYPED_SECRET not in resp.text


def test_typed_values_work_even_with_nothing_stored(monkeypatch, stub_client):
    """El bug de L1: nada guardado, todo escrito — la sonda debe conectar."""
    monkeypatch.setattr(config, "AMULE_URL", "")
    monkeypatch.setattr(config, "AMULE_EC_PORT", "4712")
    monkeypatch.setattr(config, "AMULE_EC_PASSWORD", "")

    resp = client.post(
        "/api/amule/test",
        json={"url": "http://192.168.1.10", "ec_port": "4712", "ec_password": TYPED_SECRET},
    )

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True, "detail": "0.4.9"}, (
        "L1: con lo escrito completo la sonda no puede contestar «no está configurado»"
    )
    (fake,) = FakeECClient.instances
    assert (fake.host, fake.port, fake.password) == ("192.168.1.10", 4712, TYPED_SECRET)


def test_absent_fields_fall_back_to_the_stored_config(configured, stub_client):
    resp = client.post("/api/amule/test", json={"ec_password": TYPED_SECRET})

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True, "detail": "0.4.9"}
    (fake,) = FakeECClient.instances
    # URL y puerto, de lo guardado; sólo la contraseña, de lo escrito.
    assert (fake.host, fake.port, fake.password) == ("amule.test", 4712, TYPED_SECRET)


def test_empty_fields_fall_back_to_the_stored_config(configured, stub_client):
    """Vacío = ausente: la respuesta debe ser idéntica a la de sin body."""
    vacio = client.post("/api/amule/test", json={"url": "", "ec_port": "", "ec_password": ""})
    sin_body = client.post("/api/amule/test")

    assert vacio.status_code == sin_body.status_code == 200
    assert vacio.json() == sin_body.json() == {"ok": True, "detail": "0.4.9"}
    primero, segundo = FakeECClient.instances
    for fake in (primero, segundo):
        assert (fake.host, fake.port, fake.password) == ("amule.test", 4712, SECRET)


def test_a_masked_value_is_never_used_as_a_password(configured, stub_client):
    """El form devuelve la máscara intacta: no es una contraseña, es «conserva»."""
    resp = client.post(
        "/api/amule/test",
        json={"url": TYPED_URL, "ec_port": TYPED_PORT, "ec_password": "****WXYZ"},
    )

    assert resp.status_code == 200, resp.text
    (fake,) = FakeECClient.instances
    assert fake.password == SECRET, "la máscara jamás viaja como contraseña: gana la guardada"
    assert (fake.host, fake.port) == ("10.0.0.9", 5000), "los campos no-secretos escritos sí mandan"
    assert "****WXYZ" not in resp.text


def test_nothing_typed_and_nothing_stored_still_shares_the_reason(monkeypatch, stub_client):
    monkeypatch.setattr(config, "AMULE_URL", "")
    monkeypatch.setattr(config, "AMULE_EC_PORT", "4712")
    monkeypatch.setattr(config, "AMULE_EC_PASSWORD", "")

    resp = client.post("/api/amule/test", json={})

    expected = config.service_unavailable_reason("amule", "amule")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": False, "detail": expected}
    assert FakeECClient.instances == [], "sin config no se debe construir ningún cliente"


def test_a_bad_typed_port_still_answers_200_with_the_verdict_in_the_body(
    configured, stub_client
):
    """HTTP 200 siempre: hasta un valor inválido escrito es un veredicto."""
    resp = client.post("/api/amule/test", json={"ec_port": "no-es-un-puerto"})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is False
    assert "ValueError" in body["detail"]
    assert SECRET not in resp.text


def test_a_numeric_typed_port_is_accepted(configured, stub_client):
    """settings.json puede guardar el puerto como número; el body también."""
    resp = client.post("/api/amule/test", json={"ec_port": 5001})

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True, "detail": "0.4.9"}
    (fake,) = FakeECClient.instances
    assert fake.port == 5001


def test_the_candidate_password_never_appears_in_response_or_logs(configured, stub_client, caplog):
    """La contraseña USADA (la escrita) se redacta de cualquier detalle."""
    with caplog.at_level(logging.DEBUG):
        FakeECClient.error = AmuleECConnectionError(f"auth rechazada para {TYPED_SECRET}")
        fallo = client.post("/api/amule/test", json={"ec_password": TYPED_SECRET})
        FakeECClient.error = None
        ok = client.post("/api/amule/test", json={"ec_password": TYPED_SECRET})

    detalle = fallo.json()["detail"]
    assert fallo.json()["ok"] is False
    assert "auth rechazada para ****" in detalle, (
        "el detalle se redacta con la contraseña USADA (la escrita), no con la guardada"
    )
    assert TYPED_SECRET not in fallo.text, "la contraseña candidata jamás se refleja"
    assert TYPED_SECRET not in ok.text
    assert TYPED_SECRET not in caplog.text, "ni un log puede contener la contraseña candidata"
    assert FakeECClient.instances, "el stub debió construirse con la contraseña escrita"
    assert all(f.password == TYPED_SECRET for f in FakeECClient.instances)


# ── la cadena save→probe (S1) ────────────────────────────────────────────────
#
# L3: `config.rebuild()` sí corre tras guardar (settings.py:180) y la
# persistencia de `services.amule` está probada. Lo que faltaba era fijar la
# cadena COMPLETA: guardar la tarjeta y que la sonda posterior — sin body —
# pruebe exactamente lo guardado, contraseña incluida. Es la cadena que el
# usuario no pudo completar.


class TestSaveThenProbe:
    """POST /api/settings → config.rebuild() → POST /api/amule/test (sin body)."""

    @pytest.fixture
    def persisted(self, tmp_path, monkeypatch):
        """Settings reales hacia un directorio desechable, restauración total."""
        directory = tmp_path / "config"
        directory.mkdir()
        monkeypatch.setattr(settings_mod, "CONFIG_DIR", str(directory))
        monkeypatch.setattr(settings_mod, "SETTINGS_FILE", str(directory / "settings.json"))
        before = copy.deepcopy(settings_mod.get_settings())
        yield
        settings_mod._settings = before
        config.rebuild()

    def test_the_saved_card_is_what_the_next_probe_tests(self, persisted, stub_client, caplog):
        guardado = {
            "url": "http://amule.guardado:8080",
            "ec_port": "4719",
            "ec_password": "clave-guardada-9876",
        }

        with caplog.at_level(logging.DEBUG):
            guardado_resp = client.post("/api/settings", json={"services": {"amule": guardado}})
            assert guardado_resp.status_code == 200, guardado_resp.text
            assert "clave-guardada-9876" not in guardado_resp.text

            # Sin body: la sonda lee lo que el guardado dejó (rebuild incluido).
            resp = client.post("/api/amule/test")

        assert resp.status_code == 200, resp.text
        assert resp.json() == {"ok": True, "detail": "0.4.9"}
        (fake,) = FakeECClient.instances
        assert (fake.host, fake.port, fake.password) == ("amule.guardado", 4719, "clave-guardada-9876"), (
            "POST /api/settings → config.rebuild() → POST /api/amule/test debe sondear "
            "EXACTAMENTE lo guardado, contraseña incluida"
        )
        assert "clave-guardada-9876" not in resp.text
        assert "clave-guardada-9876" not in caplog.text, "la contraseña guardada jamás se loguea"

    def test_the_masked_round_trip_of_a_save_still_probes_the_saved_password(
        self, persisted, stub_client
    ):
        """Tras el primer guardado el form reenvía la máscara: la sonda (sin
        body, o con la máscara en él) debe probar la contraseña REAL guardada."""
        client.post(
            "/api/settings",
            json={
                "services": {
                    "amule": {
                        "url": "http://amule.guardado:8080",
                        "ec_port": "4719",
                        "ec_password": "clave-guardada-9876",
                    }
                }
            },
        )

        resp = client.post("/api/amule/test")

        assert resp.json() == {"ok": True, "detail": "0.4.9"}
        (fake,) = FakeECClient.instances
        assert fake.password == "clave-guardada-9876"
        assert (fake.host, fake.port) == ("amule.guardado", 4719)
