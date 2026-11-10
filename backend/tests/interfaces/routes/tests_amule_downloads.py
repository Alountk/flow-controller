"""Descargas de aMule y control por fichero (pagina-descargas T2/S2-S3).

Contrato `{ok, detail}` del predecesor `amule_actions.py`: HTTP 200 siempre
que el pedido tenga forma, veredicto honesto en español y jamás la contraseña
EC en la respuesta. La suite parchea los servicios EN el módulo de la ruta
(patrón `amule_shares`), y los fallos tipados se traducen al `Tipo: mensaje`
de siempre. `delete` es destructiva: bloqueada con `SAFE_MODE` activo con el
guardián y el mensaje verbatim de `routes/actions.py::run_action`.
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

ROUTE = "interfaces.http.routes.amule_downloads."
SECRET_PASSWORD = "sup3r-secret-ec"
HASH32 = "00112233445566778899aabbccddeeff"
LINK = "ed2k://|file|ubuntu.iso|1000|00112233445566778899aabbccddeeff|/"

#: Mensaje del guardián destructivo de `routes/actions.py::run_action` (verbatim).
SAFE_MODE_BLOCKED = (
    "'Eliminar descarga' es destructiva y el modo seguro está activo "
    "(SAFE_MODE=true). Desactívalo en backend/.env para habilitarla."
)

ROW = {
    "hash": HASH32,
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
    "ed2k_link": LINK,
    "source": "amule",
}


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


class TestDownloadList:
    def test_listing_passes_the_service_rows_through(self):
        with _fake("amule_downloads", return_value=[ROW, ROW]) as svc:
            res = client.get("/api/amule/downloads")

        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is True
        assert body["downloads"] == [ROW, ROW]
        assert body["detail"] == "2 descargas en la lista"
        svc.assert_called_once_with()

    def test_an_ec_failure_is_an_honest_200_not_a_500(self):
        with _fake(
            "amule_downloads",
            side_effect=AmuleECConnectionError("sin respuesta de EC en 1.2.3.4:4712"),
        ):
            res = client.get("/api/amule/downloads")

        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is False
        assert "EC" in body["detail"]

    def test_unconfigured_reads_the_honest_refusal(self):
        reason = config.service_unavailable_reason("amule", "amule")
        with _fake("amule_downloads", side_effect=RuntimeError(reason)):
            res = client.get("/api/amule/downloads")

        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is False
        assert "no está configurado" in body["detail"]

    def test_the_ec_password_never_reaches_the_detail(self):
        with _fake(
            "amule_downloads",
            side_effect=AmuleECCommandError(f"auth fallada con {SECRET_PASSWORD}"),
        ):
            res = client.get("/api/amule/downloads")

        assert res.status_code == 200
        assert SECRET_PASSWORD not in res.text


class TestDownloadActions:
    def test_pause_forwards_the_file_hash(self):
        with _fake("amule_pause", return_value=None) as svc:
            res = client.post("/api/amule/downloads/pause", json={"file_hash": HASH32})

        assert res.status_code == 200
        assert res.json()["ok"] is True
        svc.assert_called_once_with(HASH32)

    def test_resume_forwards_the_file_hash(self):
        with _fake("amule_resume", return_value=None) as svc:
            res = client.post("/api/amule/downloads/resume", json={"file_hash": HASH32})

        assert res.status_code == 200
        assert res.json()["ok"] is True
        svc.assert_called_once_with(HASH32)

    def test_priority_forwards_the_raw_number(self):
        with _fake("amule_set_priority", return_value=None) as svc:
            res = client.post(
                "/api/amule/downloads/priority", json={"file_hash": HASH32, "priority": 3}
            )

        assert res.status_code == 200
        assert res.json()["ok"] is True
        svc.assert_called_once_with(HASH32, 3)

    def test_category_forwards_the_index(self):
        with _fake("amule_set_category", return_value=None) as svc:
            res = client.post(
                "/api/amule/downloads/category", json={"file_hash": HASH32, "category": 4}
            )

        assert res.status_code == 200
        assert res.json()["ok"] is True
        svc.assert_called_once_with(HASH32, 4)

    def test_missing_file_hash_is_a_422(self):
        with _fake("amule_pause") as svc:
            res = client.post("/api/amule/downloads/pause", json={})

        assert res.status_code == 422
        svc.assert_not_called()

    def test_missing_priority_is_a_422(self):
        with _fake("amule_set_priority") as svc:
            res = client.post("/api/amule/downloads/priority", json={"file_hash": HASH32})

        assert res.status_code == 422
        svc.assert_not_called()

    def test_missing_category_is_a_422(self):
        with _fake("amule_set_category") as svc:
            res = client.post("/api/amule/downloads/category", json={"file_hash": HASH32})

        assert res.status_code == 422
        svc.assert_not_called()

    def test_priority_as_text_is_a_422(self):
        with _fake("amule_set_priority") as svc:
            res = client.post(
                "/api/amule/downloads/priority", json={"file_hash": HASH32, "priority": "alta"}
            )

        assert res.status_code == 422
        svc.assert_not_called()

    def test_an_unknown_action_is_refused_without_touching_the_service(self):
        with _fake("amule_pause") as svc:
            res = client.post("/api/amule/downloads/explode", json={"file_hash": HASH32})

        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is False
        assert "acción desconocida" in body["detail"]
        svc.assert_not_called()

    def test_a_core_rejection_maps_to_ok_false_with_the_detail(self):
        with _fake(
            "amule_set_priority",
            side_effect=AmuleECCommandError("EC_OP_FAILED: File not found"),
        ):
            res = client.post(
                "/api/amule/downloads/priority", json={"file_hash": HASH32, "priority": 1}
            )

        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is False
        assert "File not found" in body["detail"]


class TestDownloadDelete:
    def test_delete_without_files_forwards_the_default(self, monkeypatch):
        monkeypatch.setattr(config, "SAFE_MODE", False)
        with _fake("amule_delete", return_value=None) as svc:
            res = client.post("/api/amule/downloads/delete", json={"file_hash": HASH32})

        assert res.status_code == 200
        assert res.json()["ok"] is True
        svc.assert_called_once_with(HASH32, False)

    def test_delete_with_files_forwards_the_flag(self, monkeypatch):
        monkeypatch.setattr(config, "SAFE_MODE", False)
        with _fake("amule_delete", return_value=None) as svc:
            res = client.post(
                "/api/amule/downloads/delete",
                json={"file_hash": HASH32, "delete_files": True},
            )

        assert res.status_code == 200
        assert res.json()["ok"] is True
        svc.assert_called_once_with(HASH32, True)

    def test_delete_is_blocked_in_safe_mode_with_the_actions_message(self, monkeypatch):
        monkeypatch.setattr(config, "SAFE_MODE", True)
        with _fake("amule_delete") as svc:
            res = client.post("/api/amule/downloads/delete", json={"file_hash": HASH32})

        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is False
        assert body["detail"] == SAFE_MODE_BLOCKED
        assert body["safe_mode"] is True
        svc.assert_not_called()

    def test_delete_files_as_text_is_a_422(self, monkeypatch):
        monkeypatch.setattr(config, "SAFE_MODE", False)
        with _fake("amule_delete") as svc:
            res = client.post(
                "/api/amule/downloads/delete",
                json={"file_hash": HASH32, "delete_files": "sí"},
            )

        assert res.status_code == 422
        svc.assert_not_called()


class TestCategories:
    def test_categories_pass_the_mapping_through(self):
        mapping = {"all": 0, "radarr": 4, "tv-sonarr": 6}
        with _fake("amule_categories", return_value=mapping) as svc:
            res = client.get("/api/amule/categories")

        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is True
        assert body["categories"] == mapping
        svc.assert_called_once_with()

    def test_an_ec_failure_is_an_honest_200_not_a_500(self):
        with _fake("amule_categories", side_effect=AmuleECConnectionError("EC caído")):
            res = client.get("/api/amule/categories")

        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is False
        assert "EC" in body["detail"]
