"""Route tests for the explicit auto-copy sweep endpoint.

Only the HTTP transport and the driver are stubbed where noted; the route body
itself runs, so a broken import, a missing router registration or a shape change
would fail here.
"""

from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

import history
import routes.auto_copy as route_module
from app import app
from tests_routes import _StubSession

client = TestClient(app, raise_server_exceptions=False)


def test_the_sweep_endpoint_returns_the_summary():
    summary = {
        "ok": True,
        "running": False,
        "safe_mode": True,
        "counts": {"traces": 0},
        "entries": [],
        "errors": [],
    }
    with patch.object(route_module, "sweep", new=AsyncMock(return_value=summary)):
        resp = client.post("/api/auto-copy/sweep")

    assert resp.status_code == 200
    assert resp.json() == summary


def test_the_sweep_endpoint_forwards_the_configured_safe_mode():
    seen = {}

    async def fake_sweep(session, *, safe_mode, **kwargs):
        seen["safe_mode"] = safe_mode
        return {"ok": True, "running": False, "safe_mode": safe_mode}

    with patch.object(route_module, "sweep", new=fake_sweep), patch.object(
        route_module, "SAFE_MODE", False
    ):
        assert client.post("/api/auto-copy/sweep").status_code == 200

    assert seen["safe_mode"] is False


def test_the_sweep_endpoint_requires_auth():
    import routes.status as status_module

    with patch("settings.auth_required", return_value=True), patch.object(
        status_module, "credentials"
    ) as creds:
        creds.verify_api_key.return_value = False
        unauth = TestClient(app, raise_server_exceptions=False)
        resp = unauth.post("/api/auto-copy/sweep")

    assert resp.status_code == 401


def test_an_unavailable_database_and_arr_do_not_produce_a_500():
    """The route contract is a JSON summary, even with the store closed and
    every outbound call answering 503."""
    history.close()

    with patch("aiohttp.ClientSession", _StubSession):
        resp = client.post("/api/auto-copy/sweep")

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["counts"]["traces"] == 0


def test_an_unexpected_driver_error_returns_json_not_a_500():
    with patch.object(
        route_module, "sweep", new=AsyncMock(side_effect=RuntimeError("boom"))
    ):
        resp = client.post("/api/auto-copy/sweep")

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert body["errors"]
