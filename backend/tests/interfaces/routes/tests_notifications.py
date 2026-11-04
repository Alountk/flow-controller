"""`POST /api/notifications/test` — el botón «Probar aviso» (C-01, S2).

El botón envía un aviso **real** y devuelve lo que pasó. La ruta no inventa un
éxito: si el canal no está configurado responde `ok: false` con el motivo, con
la misma forma que `/api/services/test` y por la misma razón — la UI pinta una
píldora a partir de `ok`, y un 500 no le diría nada al usuario.
"""

from unittest.mock import patch

import pytest

from app import app
from fastapi.testclient import TestClient
from application.use_cases import notifier
from infrastructure import settings_store

client = TestClient(app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def _restore_settings():
    before = settings_store._settings
    yield
    settings_store._settings = before


def _channel(enabled=True):
    settings_store._settings = {
        "notifications": {
            "ntfy": {"url": "http://ntfy.test:8080", "topic": "flow", "token": "", "enabled": enabled}
        }
    }


def test_the_button_sends_a_real_aviso_and_returns_what_happened():
    _channel()
    with patch.object(
        notifier, "send", return_value={"ok": True, "status": 200, "elapsed_ms": 12, "error": ""}
    ) as sent:
        resp = client.post("/api/notifications/test")

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True, "status": 200, "elapsed_ms": 12, "error": ""}
    assert sent.call_count == 1


def test_without_a_channel_the_button_reports_it_instead_of_pretending():
    _channel(enabled=False)
    with patch.object(notifier, "send", return_value={"ok": False, "status": None, "elapsed_ms": 1, "error": "not-configured"}) as sent:
        resp = client.post("/api/notifications/test")

    assert resp.status_code == 200, resp.text
    assert resp.json()["ok"] is False
    assert resp.json()["error"] == "not-configured"
    assert sent.call_count == 1, "la ruta delega el veredicto en el notificador, no lo adivina"


def test_a_broken_channel_does_not_become_a_server_error():
    _channel()
    with patch.object(
        notifier, "send", return_value={"ok": False, "status": None, "elapsed_ms": 5001, "error": "ClientConnectorError: refused"}
    ):
        resp = client.post("/api/notifications/test")

    assert resp.status_code == 200, "un canal caído es un resultado, no un 500"
    body = resp.json()
    assert body["ok"] is False
    assert "refused" in body["error"]
