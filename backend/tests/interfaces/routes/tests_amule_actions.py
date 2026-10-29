"""Acciones de control de aMule (S3/S4): contrato {ok, detail} honesto por ruta.

Predecesor: `POST /api/amule/test` — HTTP 200 siempre que el pedido tenga
forma, `detail` en español y jamás la contraseña EC. Aquí se pinchan las cinco
rutas del router nuevo con servicios falsos:

- éxito ⇒ `{ok: true, detail}`; fallo operativo (EC caído, core que rechaza)
  ⇒ `{ok: false, detail}` con el error tipado traducido y SECRETO ASEADDO;
- petición sin forma (falta `address`/`link`) ⇒ 422 con `detail` en español;
- enlace de esquema distinto de `ed2k://` o `magnet:` ⇒ `{ok: false, detail}`
  SIN llegar a tocar el servicio (S4);
- el listado pasa tal cual lo devuelve el servicio (`servers`).
"""

import copy
from unittest.mock import Mock, patch

import pytest
from fastapi.testclient import TestClient

import config
from app import app
from infrastructure import settings_store as settings_mod
from infrastructure.amule_ec_client import AmuleECCommandError, AmuleECConnectionError

client = TestClient(app, raise_server_exceptions=False)

ROUTE = "interfaces.http.routes.amule_actions."
SECRET_PASSWORD = "sup3r-secret-ec"
ED2K = "ed2k://|file|test.bin|1024|00112233445566778899aabbccddeeff|/"


@pytest.fixture(autouse=True)
def _ec_secret():
    """Contraseña EC conocida en settings: el guardado de secretos debe filtrarla."""
    before = copy.deepcopy(settings_mod.get_settings())
    amule = settings_mod._settings.setdefault("services", {}).setdefault("amule", {})
    amule["ec_password"] = SECRET_PASSWORD
    config.rebuild()
    yield
    settings_mod._settings = before
    config.rebuild()


def _fake(name: str, *, return_value=None, side_effect=None):
    """Parchea el nombre importado en el módulo de la ruta (patrón amule_shares)."""
    return patch(
        ROUTE + name,
        new=Mock(return_value=return_value, side_effect=side_effect),
    )


class TestServerList:
    def test_listing_passes_the_service_payload_through(self):
        rows = [{"name": "MiServer", "address": "1.2.3.4:4662", "failed": False}]
        with _fake("amule_servers", return_value=rows) as svc:
            res = client.get("/api/amule/servers")

        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is True
        assert body["servers"] == rows
        svc.assert_called_once_with()

    def test_an_ec_failure_is_an_honest_200_not_a_500(self):
        with _fake(
            "amule_servers",
            side_effect=AmuleECConnectionError("sin respuesta de EC en 1.2.3.4:4712"),
        ):
            res = client.get("/api/amule/servers")

        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is False
        assert "EC" in body["detail"]


class TestServerActions:
    def test_add_forwards_address_and_name(self):
        with _fake("amule_server_add", return_value=None) as svc:
            res = client.post(
                "/api/amule/servers/add", json={"address": "1.2.3.4:4662", "name": "MiServer"}
            )

        assert res.status_code == 200
        assert res.json()["ok"] is True
        svc.assert_called_once_with("1.2.3.4:4662", "MiServer")

    def test_add_without_name_is_allowed(self):
        with _fake("amule_server_add", return_value=None) as svc:
            res = client.post("/api/amule/servers/add", json={"address": "1.2.3.4:4662"})

        assert res.status_code == 200
        svc.assert_called_once_with("1.2.3.4:4662", "")

    def test_add_without_address_is_a_422(self):
        with _fake("amule_server_add") as svc:
            res = client.post("/api/amule/servers/add", json={"name": "huerfano"})

        assert res.status_code == 422
        svc.assert_not_called()

    def test_a_core_rejection_maps_to_ok_false_with_the_detail(self):
        with _fake(
            "amule_server_add",
            side_effect=AmuleECCommandError("EC_OP_FAILED: Server not added"),
        ):
            res = client.post(
                "/api/amule/servers/add", json={"address": "1.2.3.4:4662", "name": "X"}
            )

        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is False
        assert "Server not added" in body["detail"]

    def test_remove_forwards_the_address(self):
        with _fake("amule_server_remove", return_value=None) as svc:
            res = client.post("/api/amule/servers/remove", json={"address": "1.2.3.4:4662"})

        assert res.status_code == 200
        assert res.json()["ok"] is True
        svc.assert_called_once_with("1.2.3.4:4662")

    def test_connect_forwards_the_address(self):
        with _fake("amule_server_connect", return_value=None) as svc:
            res = client.post("/api/amule/servers/connect", json={"address": "1.2.3.4:4662"})

        assert res.status_code == 200
        assert res.json()["ok"] is True
        svc.assert_called_once_with("1.2.3.4:4662")

    def test_unresolvable_or_malformed_address_is_ok_false_not_a_crash(self):
        with _fake(
            "amule_server_connect",
            side_effect=ValueError("dirección inválida: falta el puerto"),
        ):
            res = client.post("/api/amule/servers/connect", json={"address": "1.2.3.4"})

        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is False
        assert "puerto" in body["detail"]

    def test_the_ec_password_never_reaches_the_detail(self):
        with _fake(
            "amule_server_add",
            side_effect=AmuleECCommandError(f"auth fallada con {SECRET_PASSWORD}"),
        ):
            res = client.post(
                "/api/amule/servers/add", json={"address": "1.2.3.4:4662", "name": "X"}
            )

        assert res.status_code == 200
        assert SECRET_PASSWORD not in res.text


class TestAddLinks:
    def test_an_ed2k_link_goes_straight_to_the_queue(self):
        with _fake("amule_add_ed2k", return_value=None) as svc:
            res = client.post("/api/amule/links", json={"link": ED2K})

        assert res.status_code == 200
        assert res.json()["ok"] is True
        svc.assert_called_once_with(ED2K)

    def test_a_magnet_link_is_accepted_too(self):
        magnet = "magnet:?xt=urn:md5:00112233445566778899aabbccddeeff"
        with _fake("amule_add_ed2k", return_value=None) as svc:
            res = client.post("/api/amule/links", json={"link": magnet})

        assert res.status_code == 200
        assert res.json()["ok"] is True
        svc.assert_called_once_with(magnet)

    def test_a_foreign_scheme_is_refused_without_touching_the_service(self):
        with _fake("amule_add_ed2k") as svc:
            res = client.post("/api/amule/links", json={"link": "https://ejemplo.tld/f.bin"})

        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is False
        assert body["detail"]
        svc.assert_not_called()

    def test_missing_link_is_a_422(self):
        with _fake("amule_add_ed2k") as svc:
            res = client.post("/api/amule/links", json={})

        assert res.status_code == 422
        svc.assert_not_called()

    def test_a_queue_rejection_is_reported_honestly(self):
        with _fake(
            "amule_add_ed2k",
            side_effect=AmuleECCommandError("EC_OP_FAILED: link no aceptado"),
        ):
            res = client.post("/api/amule/links", json={"link": ED2K})

        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is False
        assert "link no aceptado" in body["detail"]
