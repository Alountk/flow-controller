"""`notifications.ntfy` cifrado en reposo y enmascarado en la API (C-01, S1).

El token de ntfy es una credencial como las demás: va en
`credentials.ENCRYPTED_SECRET_FIELDS`, el fichero guarda `enc:…`, y ninguna
respuesta HTTP enseña ni el claro ni el ciphertext — sólo la máscara
`****` + últimos 4, el patrón de `routes/settings.py`.

Y una lección de producción que se fija aquí: **el grupo va SIEMPRE en el
payload** de `GET /api/settings`, aunque el usuario no lo haya tocado nunca.
La tarjeta que lo lee no lleva guardas (`services.qbit.url` tumbó la pantalla
entera en el cierre del qbit-nativo, Log L8); un `settings.json` anterior a
esta feature no debe poder repetirlo.
"""

import json

import pytest

from app import app
from fastapi.testclient import TestClient
from infrastructure import credentials
from infrastructure import settings_store as settings

client = TestClient(app, raise_server_exceptions=False)

SECRET = "ntfy_tk_secreto_falso_9876"
MASKED = "****" + SECRET[-4:]


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    directory = tmp_path / "config"
    directory.mkdir()
    monkeypatch.setattr(settings, "CONFIG_DIR", str(directory))
    monkeypatch.setattr(settings, "SETTINGS_FILE", str(directory / "settings.json"))
    monkeypatch.setattr(settings, "encryption_error", "", raising=False)
    monkeypatch.setenv(credentials.SECRET_ENV_VAR, SECRET)
    before = settings._settings
    settings._settings = {}
    yield directory
    settings._settings = before


def _with_ntfy(token: str = SECRET) -> dict:
    return {
        "notifications": {
            "ntfy": {
                "url": "http://ntfy.test:8080",
                "topic": "flowcontroller",
                "token": token,
                "enabled": True,
            }
        },
        "security": {"safe_mode": True},
    }


def _raw(cfg) -> str:
    return (cfg / "settings.json").read_text()


def test_the_token_is_written_as_ciphertext_not_in_the_clear(cfg):
    assert settings.save_settings(_with_ntfy()) is True

    raw = _raw(cfg)
    stored = json.loads(raw)

    assert SECRET not in raw, "el token de ntfy se escribió en claro"
    assert credentials.is_encrypted(stored["notifications"]["ntfy"]["token"])


def test_the_settings_response_shows_only_the_mask(cfg):
    settings.save_settings(_with_ntfy())
    settings.load_settings()

    resp = client.get("/api/settings")

    assert resp.status_code == 200, resp.text
    assert SECRET not in resp.text
    assert "enc:" not in resp.text, "ni el ciphertext debe asomar"
    assert resp.json()["notifications"]["ntfy"]["token"] == MASKED


def test_the_masked_form_round_trips_over_the_ciphertext(cfg):
    """El form postea la máscara tal cual: guardarla destruiría el token."""
    settings.save_settings(_with_ntfy())
    settings.load_settings()

    form = client.get("/api/settings").json()
    posted = client.post("/api/settings", json=form)
    assert posted.status_code == 200, posted.text
    assert SECRET not in posted.text

    settings.load_settings()
    assert settings.get_setting("notifications", "ntfy", "token") == SECRET
    assert SECRET not in _raw(cfg), "el round-trip dejó el token en claro en el fichero"


def test_the_group_is_always_present_even_in_a_file_that_never_had_it(cfg):
    """Una tarjeta que lee `notifications.ntfy.url` sin guardas no puede crashear."""
    (cfg / "settings.json").write_text(json.dumps({"services": {"radarr": {"url": "http://r.test"}}}))

    settings.load_settings()
    payload = client.get("/api/settings").json()

    ntfy = payload["notifications"]["ntfy"]
    assert ntfy["url"] == ""
    assert ntfy["topic"] == ""
    assert ntfy["token"] == ""
    assert ntfy["enabled"] is False


def test_clearing_the_token_on_purpose_still_clears_it(cfg):
    """Vacío NO es máscara: apagar el canal tiene que poder quitar el token."""
    settings.save_settings(_with_ntfy())
    settings.load_settings()

    form = client.get("/api/settings").json()
    form["notifications"]["ntfy"]["token"] = ""
    client.post("/api/settings", json=form)

    settings.load_settings()
    assert settings.get_setting("notifications", "ntfy", "token") == ""
