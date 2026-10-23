"""T2 (S2): la contraseña EC jamás sale en claro por la API de settings.

`ec_password` vive en `settings.json → services.amule.ec_password` y se edita
por el endpoint de settings con la semántica que S2 manda para este campo:
«clave vacía en POST = conservar la guardada». Las respuestas la muestran
SIEMPRE enmascarada (el patrón `****` + últimos 4 de `_mask_secrets`) y ningún
log la escribe.

Ojo: ésta es a propósito una excepción al «vacío borra» que el resto de
secretos conserva (`test_clearing_a_secret_still_clears_it` en tests_routes):
S2 lo pide literal para la contraseña EC, y éste es el archivo que lo fija.
"""

import copy

import pytest

from app import app
from fastapi.testclient import TestClient
from interfaces.http.routes import settings as settings_route

client = TestClient(app, raise_server_exceptions=False)

SECRET = "EC-SECRETO-FALSO-4242"
MASKED = "****" + SECRET[-4:]

STORED = {
    "services": {
        "amule": {
            "url": "http://amule.test:4712",
            "ec_port": "4712",
            "ec_password": SECRET,
        },
    },
}


@pytest.fixture
def saved(monkeypatch):
    """Settings guardados con un secreto falso; captura lo que se persistiría.

    Se parchean los nombres del módulo de la ruta (su contrato con
    `application.gateways`), así el cuerpo real del endpoint corre entero sin
    tocar el settings.json real.
    """
    captured: dict = {}

    def _fake_save(data):
        captured.clear()
        captured.update(copy.deepcopy(data))
        return True

    monkeypatch.setattr(settings_route, "get_settings", lambda: copy.deepcopy(STORED))
    monkeypatch.setattr(settings_route, "save_settings", _fake_save)
    return captured


def _form(password=MASKED) -> dict:
    """El formulario tal y como lo devuelve GET /api/settings y lo reenvía la UI."""
    form = copy.deepcopy(STORED)
    form["services"]["amule"]["ec_password"] = password
    return form


# ── ninguna respuesta lleva el secreto en claro ──────────────────────────────


def test_get_settings_returns_only_the_mask(saved):
    resp = client.get("/api/settings")

    assert resp.status_code == 200, resp.text
    assert SECRET not in resp.text
    value = resp.json()["services"]["amule"]["ec_password"]
    assert value == MASKED
    assert value.startswith("****"), "la máscara es lo que el form devuelve intacto"


def test_get_config_never_carries_the_secret(saved):
    resp = client.get("/api/config")

    assert resp.status_code == 200, resp.text
    assert SECRET not in resp.text


def test_no_settings_or_config_response_ever_carries_the_clear_secret(saved):
    texts = {
        "GET /api/settings": client.get("/api/settings").text,
        "GET /api/config": client.get("/api/config").text,
        "GET /api/services": client.get("/api/services").text,
        "GET /api/setup": client.get("/api/setup").text,
        "POST /api/settings": client.post("/api/settings", json=_form()).text,
        "POST /api/amule/test": client.post("/api/amule/test").text,
    }
    for where, text in texts.items():
        assert SECRET not in text, f"{where} filtró la contraseña EC"


# ── semántica de guardado: vacío conserva, máscara conserva, nuevo sustituye ─


def test_saving_the_untouched_form_preserves_the_stored_secret(saved):
    resp = client.post("/api/settings", json=_form())

    assert resp.status_code == 200, resp.text
    assert SECRET not in resp.text
    assert saved["services"]["amule"]["ec_password"] == SECRET


def test_empty_on_save_keeps_the_stored_secret_and_stays_masked(saved):
    """S2 literal: «clave vacía en POST = conservar la guardada»."""
    resp = client.post("/api/settings", json=_form(password=""))

    assert resp.status_code == 200, resp.text
    assert SECRET not in resp.text
    assert saved["services"]["amule"]["ec_password"] == SECRET
    # Y al releer sigue saliendo enmascarada, jamás en claro.
    after = client.get("/api/settings")
    assert after.json()["services"]["amule"]["ec_password"] == MASKED
    assert SECRET not in after.text


def test_a_body_without_the_password_field_keeps_the_stored_secret(saved):
    form = _form()
    del form["services"]["amule"]["ec_password"]

    client.post("/api/settings", json=form)

    assert saved["services"]["amule"]["ec_password"] == SECRET


def test_a_new_secret_replaces_the_stored_one(saved):
    resp = client.post("/api/settings", json=_form(password="NUEVA-CLAVE-EC-5678"))

    assert resp.status_code == 200, resp.text
    assert saved["services"]["amule"]["ec_password"] == "NUEVA-CLAVE-EC-5678"
    assert "NUEVA-CLAVE-EC-5678" not in resp.text, "la respuesta jamás devuelve el valor nuevo"


def test_url_and_port_are_editable_through_the_settings_endpoint(saved):
    form = _form()
    form["services"]["amule"]["url"] = "http://otro-amule:4712"
    form["services"]["amule"]["ec_port"] = "9999"

    client.post("/api/settings", json=form)

    assert saved["services"]["amule"]["url"] == "http://otro-amule:4712"
    assert saved["services"]["amule"]["ec_port"] == "9999"
    assert saved["services"]["amule"]["ec_password"] == SECRET


# ── hardening S2: el ciphertext de reposo jamás asoma en las respuestas ──────

CIPHERTEXT = "enc:gAAAAABmT0KEN-CIPHERTEXT-DE-PRUEBA"
STORED_CIPHER = {
    "services": {
        "amule": {
            "url": "http://amule.test:4712",
            "ec_port": "4712",
            "ec_password": CIPHERTEXT,
        },
    },
}


def test_ciphertext_never_leaves_and_never_double_encrypts(saved, monkeypatch):
    """Si en memoria llegara el ciphertext, sale la máscara desnuda — nunca `enc:`.

    Y el keep-on-empty conserva el valor tal cual: ni se descifra a una
    respuesta ni se vuelve a cifrar al guardarlo.
    """
    monkeypatch.setattr(settings_route, "get_settings", lambda: copy.deepcopy(STORED_CIPHER))

    resp = client.get("/api/settings")

    assert resp.status_code == 200, resp.text
    assert CIPHERTEXT not in resp.text
    assert "enc:" not in resp.text
    assert resp.json()["services"]["amule"]["ec_password"] == "****"

    form = copy.deepcopy(STORED_CIPHER)
    form["services"]["amule"]["ec_password"] = ""
    posted = client.post("/api/settings", json=form)

    assert CIPHERTEXT not in posted.text
    assert saved["services"]["amule"]["ec_password"] == CIPHERTEXT, (
        "vacío debe conservar el valor guardado tal cual, sin descifrarlo ni re-cifrarlo"
    )
