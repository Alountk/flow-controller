"""El servicio `amuleapi`: entrada SERVICES, sonda HTTP y secretos (T2, S1).

La REST de aMule 3.x (`docs/api/REFERENCE.md` de `amule-org/amule`) se sondea
con `GET /api/v1/version`: auth opcional para los campos de identidad, `200`
sin credencial y sin contar para el rate limit de 401 — así que esta sonda
**nunca envía la contraseña** (la contraseña es de T3, para el login).
`daemon_version` es la del amuled conectado por EC: si sale vacía, amuleapi
está vivo pero no le cuadra el núcleo.
"""

import asyncio
from contextlib import contextmanager
from unittest.mock import patch

import config
from fastapi.testclient import TestClient

from app import app
from infrastructure import arr_client
from tests._stubs import _StubSession

client = TestClient(app, raise_server_exceptions=False)

VERSION_PATH = "/api/v1/version"
AMULEAPI_URL = "http://amuleapi.test:4713"
SENTINEL = "AMULEAPI-PASS-SECRETO-9999"

VERSION_BODY = {
    "service": "amuleapi",
    "api_version": "v1",
    "amuleapi_version": "3.2.0",
    "daemon_version": "3.2.0",
    "update": {"check_enabled": False, "checked": False, "latest_version": None, "available": False},
}

SERVICE = {
    "key": "amuleapi",
    "kind": "amuleapi",
    "url": AMULEAPI_URL,
    "api_key": "",
    "password": SENTINEL,
    "configured": True,
}


class _KwargSession(_StubSession):
    """Records the kwargs of each GET: the probe must send NO credentials."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.get_kwargs: list[tuple[str, dict]] = []

    def get(self, url, **kwargs):
        self.get_kwargs.append((str(url), kwargs))
        return super().get(url, **kwargs)


@contextmanager
def patch_session(session):
    with patch("aiohttp.ClientSession", lambda *a, **k: session):
        yield


def _run(coroutine):
    return asyncio.run(coroutine)


def _probe(version=(200, VERSION_BODY), service=None):
    session = _KwargSession({VERSION_PATH: version})
    result = _run(arr_client.test_service_connection(session, service or dict(SERVICE)))
    return session, result


# ── 1. la entrada SERVICES ───────────────────────────────────────────────────


class TestAmuleapiServiceEntry:
    def test_the_list_carries_an_amuleapi_entry(self):
        entry = next(s for s in config.SERVICES if s["key"] == "amuleapi")

        assert entry["kind"] == "amuleapi", (
            "kind propio: ni el 'qbit' de la fachada aMuTorrent ni el 'amule' del EC"
        )
        for field in ("url", "password"):
            assert field in entry, f"la sonda/T3 necesitan {field}"

    def test_configured_needs_url_and_password(self):
        """Url sola no opera: sin la contraseña de admin no hay login (T3)."""
        entry = next(s for s in config.SERVICES if s["key"] == "amuleapi")

        assert entry["configured"] == bool(entry["url"] and entry["password"])

    def test_an_empty_default_is_not_configured(self):
        real = config.get_setting
        config.get_setting = lambda *a, **k: k.get("default")
        config.rebuild()
        try:
            entry = next(s for s in config.SERVICES if s["key"] == "amuleapi")
            assert entry["url"] == ""
            assert entry["configured"] is False
        finally:
            config.get_setting = real
            config.rebuild()

    def test_the_settings_payload_always_carries_the_port_key(self):
        form = client.get("/api/settings").json()

        assert form["services"]["amuleapi"]["port"] == "", (
            "sin la clave el form de la tarjeta crashea al leer .port"
        )


# ── 2. la sonda anónima ──────────────────────────────────────────────────────


class TestAmuleapiProbe:
    def test_ok_reports_the_connected_daemon_version(self):
        _, result = _probe()

        assert result["ok"] is True
        assert result["version"] == "3.2.0", "muestra la versión del amuled (daemon_version)"
        assert result["detail"] == "Conectado (3.2.0)"
        assert result["url"] == AMULEAPI_URL
        assert "elapsed_ms" in result

    def test_the_probe_sends_no_credentials(self):
        """Identidad pública por contrato: la contraseña jamás viaja en la
        sonda, y un 401 aquí sería otro servicio delante, no amuleapi."""
        session, _ = _probe()

        assert len(session.get_kwargs) == 1
        _, kw = session.get_kwargs[0]
        headers = kw.get("headers") or {}
        assert not any(k.lower() == "authorization" for k in headers), (
            "la sonda mandó credenciales"
        )

    def test_a_rejected_status_is_not_a_connection(self):
        _, result = _probe(version=(503, {}))

        assert result["ok"] is False
        assert result["detail"], "la fila necesita un motivo legible"

    def test_a_transport_error_is_honest(self):
        session = _KwargSession({VERSION_PATH: (0, asyncio.TimeoutError())})

        result = _run(arr_client.test_service_connection(session, dict(SERVICE)))

        assert result["ok"] is False
        assert result["error_kind"] == "timeout"
        assert "no respondió a tiempo" in result["detail"]


# ── 3. las rutas ─────────────────────────────────────────────────────────────


class TestAmuleapiRoutes:
    def test_services_test_probes_it_over_http(self):
        session = _KwargSession({VERSION_PATH: (200, VERSION_BODY)})

        with patch_session(session):
            resp = client.get("/api/services/test?service=amuleapi")

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        assert body["results"][0]["key"] == "amuleapi"

    def test_the_list_carries_its_own_kind(self):
        body = client.get("/api/services").json()
        entry = next(s for s in body["services"] if s["key"] == "amuleapi")

        assert entry == {
            "key": "amuleapi",
            "kind": "amuleapi",
            "url": entry["url"],
            "configured": entry["configured"],
        }, "sólo key/kind/url/configured: ningún campo secreto"
        assert "password" not in entry and "api_key" not in entry

    def test_no_services_response_carries_the_password(self):
        """SERVICES es una lista rellenada en sitio (rebuild): se sustituye la
        entrada y se restaura — `monkeypatch.setitem` no aplica a listas."""
        idx = next(i for i, s in enumerate(config.SERVICES) if s["key"] == "amuleapi")
        original = config.SERVICES[idx]
        config.SERVICES[idx] = dict(SERVICE)
        try:
            session = _KwargSession({VERSION_PATH: (200, VERSION_BODY)})
            with patch_session(session):
                texts = {
                    "GET /api/services": client.get("/api/services").text,
                    "GET /api/services/test": client.get("/api/services/test").text,
                    "POST /api/services/test": client.post(
                        "/api/services/test", json={"service": "amuleapi"}
                    ).text,
                }
        finally:
            config.SERVICES[idx] = original

        for where, text in texts.items():
            assert SENTINEL not in text, f"{where} filtró la contraseña de amuleapi"

    def test_the_candidate_port_composes_the_probed_url(self):
        session = _KwargSession({VERSION_PATH: (200, VERSION_BODY)})

        with patch_session(session):
            resp = client.post(
                "/api/services/test",
                json={"service": "amuleapi", "url": "http://amulehost", "port": "4711"},
            )

        assert resp.status_code == 200, resp.text
        assert resp.json()["ok"] is True
        assert session.get_kwargs[0][0] == "http://amulehost:4711/api/v1/version"

    def test_without_a_body_port_the_stored_one_stands(self, monkeypatch):
        monkeypatch.setattr(config, "AMULEAPI_URL", "http://amulehost", raising=False)
        monkeypatch.setattr(config, "AMULEAPI_PORT", "4711", raising=False)
        session = _KwargSession({VERSION_PATH: (200, VERSION_BODY)})

        with patch_session(session):
            resp = client.post("/api/services/test", json={"service": "amuleapi"})

        assert resp.json()["ok"] is True
        assert session.get_kwargs[0][0] == "http://amulehost:4711/api/v1/version"
