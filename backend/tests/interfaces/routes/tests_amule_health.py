"""T3 (S6): `GET /api/amule/health` — el snapshot del watchdog, tal cual.

La ruta no importa `infrastructure/` (`tests_architecture`): `app.py` inyecta el
módulo, y aquí se sustituye por un `SimpleNamespace(get_state=...)` para fijar
el contrato del snapshot. Sin inyección el endpoint responde el payload honesto
de «sin-datos» — nunca un 500, nunca un invento.

Ningún test abre red real ni Docker.
"""

from types import SimpleNamespace

from app import app
from fastapi.testclient import TestClient
from interfaces.http.routes import settings as settings_route

client = TestClient(app, raise_server_exceptions=False)

SNAPSHOT_KEYS = {
    "state",
    "detail",
    "checked_at",
    "consecutive_failures",
    "restart_attempts",
    "last_restart_at",
}


def test_health_returns_the_full_snapshot_as_is(monkeypatch):
    snapshot = {
        "state": "colgado",
        "detail": "colgado confirmado: timeout: search exceeded 10s",
        "checked_at": 1000.0,
        "consecutive_failures": 2,
        "restart_attempts": 1,
        "last_restart_at": 900.0,
    }
    monkeypatch.setattr(
        settings_route, "amule_watchdog", SimpleNamespace(get_state=lambda: snapshot)
    )

    resp = client.get("/api/amule/health")

    assert resp.status_code == 200, resp.text
    assert set(resp.json()) == SNAPSHOT_KEYS
    assert resp.json() == snapshot, "S6: el snapshot se devuelve tal cual, sin reenvolver"


def test_health_without_the_module_is_honest_sin_datos(monkeypatch):
    monkeypatch.setattr(settings_route, "amule_watchdog", None)

    resp = client.get("/api/amule/health")

    assert resp.status_code == 200, "sin inyección se responde honesto, jamás un 500"
    payload = resp.json()
    assert set(payload) == SNAPSHOT_KEYS
    assert payload["state"] == "sin-datos"
    assert payload["detail"], "el payload honesto debe decir por qué no hay datos"
