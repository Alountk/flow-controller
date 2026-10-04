"""The first-run endpoint has to carry a wizard, not just services.

Three gaps stood between `POST /api/setup` and a step-by-step installer:

1. It only ever copied `services.*`. A step that saved `paths` or
   `intervals` sent them and they vanished — so the wizard would have to
   switch to `POST /api/settings`, which is **not** partial-safe: it merges
   `DEFAULTS ← body`, and every group the step did not mention is reset to
   its default.
2. "Probar conexión" only probed the **saved** config. Testing a URL before
   committing to it — the entire point of a wizard step — was impossible.
3. `save_settings` returns `False` when the config directory is read-only,
   and both routes answered `{"ok": true}` anyway. A wizard that reports
   "guardado" over a read-only volume repeats the lie we removed from
   F-02g.
"""

import copy
from unittest.mock import AsyncMock, patch

import pytest

import config
from infrastructure import settings_store as settings_mod
from app import app
from fastapi.testclient import TestClient

client = TestClient(app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def _restored_settings():
    """Every test here rewrites the first-run config; put it back."""
    before = copy.deepcopy(settings_mod.get_settings())
    yield
    settings_mod._settings = before
    config.rebuild()


def _setup(**body):
    return client.post("/api/setup", json=body)


class TestSetupCarriesEveryGroup:
    def test_a_paths_group_reaches_the_settings(self):
        resp = _setup(paths={"allowed_roots": ["/mnt/custom"], "download_amule": "/somewhere/amule"})

        assert resp.status_code == 200, resp.text
        saved = settings_mod.get_settings().get("paths", {})
        assert saved.get("allowed_roots") == ["/mnt/custom"], (
            "the wizard's paths step would have been silently discarded; the only other "
            "endpoint that can write paths is not partial-safe"
        )
        assert saved.get("download_amule") == "/somewhere/amule"

    def test_an_intervals_group_reaches_the_settings(self):
        resp = _setup(intervals={"check": 45, "request_timeout": 9.5})

        assert resp.status_code == 200, resp.text
        saved = settings_mod.get_settings().get("intervals", {})
        assert saved.get("check") == 45
        assert saved.get("request_timeout") == 9.5

    def test_the_constants_follow_without_a_restart(self):
        _setup(tracing={"limit": 7})

        assert config.TRACE_LIMIT == 7, "config.rebuild() was not called or not effective"

    def test_a_port_change_reports_the_restart_it_needs(self):
        resp = _setup(server={"port": 9000})

        data = resp.json()
        assert data["ok"] is True
        assert "server.port" in data["restart_required"], (
            "the field is in RESTART_REQUIRED_FIELDS; reporting nothing would leave the "
            "wizard telling the user the port is live when uvicorn only reads it at boot"
        )

    def test_a_service_only_body_still_reports_no_restart(self):
        """The contract test_routes.py already pins must not move."""
        data = _setup(services={"radarr": {"url": "http://r:1"}}).json()

        assert data["restart_required"] == [], data["restart_required"]


class TestPersistIsReported:
    def test_a_failed_persist_is_not_reported_as_saved(self):
        with patch("interfaces.http.routes.settings.save_settings", return_value=False):
            data = _setup(services={"radarr": {"url": "http://r:1"}}).json()

        assert data["ok"] is True, "the settings are applied in memory either way"
        assert data.get("persisted") is False, (
            "the config volume is read-only and the endpoint claimed a plain success"
        )

    def test_a_successful_persist_says_so(self):
        with patch("interfaces.http.routes.settings.save_settings", return_value=True):
            data = _setup(services={"radarr": {"url": "http://r:1"}}).json()

        assert data.get("persisted") is True


class TestTheConnectionTestAcceptsCandidates:
    def test_it_probes_values_that_have_not_been_saved(self):
        probed = {}

        async def fake_test(session, service):
            probed.update(service)
            return {"ok": False, "error_kind": "unreachable", "url": service["url"]}

        with patch("interfaces.http.routes.settings.test_service_connection", new=fake_test):
            resp = client.post(
                "/api/services/test",
                json={"service": "radarr", "url": "http://candidate:7878", "api_key": "typed"},
            )

        assert resp.status_code == 200, resp.text
        assert probed.get("url") == "http://candidate:7878", (
            "the endpoint probed the saved config instead of what the step typed — a "
            "'Probar conexión' that only works after saving is useless in a wizard"
        )
        assert probed.get("api_key") == "typed"
        assert probed.get("kind") == "arr", "the template must still carry the service kind"
        assert resp.json()["ok"] is False

    def test_the_get_route_still_probes_the_saved_config(self):
        """The Settings page keeps working."""
        with patch("interfaces.http.routes.settings.test_service_connection", new_callable=AsyncMock) as t:
            t.return_value = {"ok": True, "url": "http://saved"}
            resp = client.get("/api/services/test?service=radarr")

        assert resp.status_code == 200, resp.text
        assert t.await_count == 1
        assert t.await_args.args[1]["url"] != "http://candidate:7878"

    def test_an_unknown_service_is_refused(self):
        resp = client.post("/api/services/test", json={"service": "jackett", "url": "http://x"})

        assert resp.status_code in (200, 404), resp.text
        assert resp.json().get("ok") is False
