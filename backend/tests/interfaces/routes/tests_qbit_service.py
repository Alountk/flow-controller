"""The `qbit` service: its SERVICES entry, its login probe, and its secrets.

S3 adds `services.qbit.{url,user,password}` — settings only, empty default,
no env fallback (D6: the operator points at their own client). Three contracts
live here:

1. the SERVICES entry (`key: qbit`, NEW `kind: qbittorrent` — never the
   `qbit` kind the aMuTorrent facade wears, so the probes cannot confuse the
   two) is `configured` only when url AND user AND password are set, and an
   unconfigured default really is `configured: false`;
2. the probe (S4/D2) is login-then-nothing: `POST /api/v2/auth/login` with the
   form credentials and a `Referer`, `Ok.` → «Conectado (URL)», `Fails.` →
   «Credenciales rechazadas», transport → honest text. No bearer, no version
   fetch (Bearer returns 403 on the real build);
3. the password NEVER leaves the API: `GET /api/services`, `GET/POST
   /api/services/test` and friends are scanned for it here, and the settings
   mask round-trip is pinned in `tests_routes.TestMaskedSecretsRoundTrip`.

The probe reads `user`/`password` from the service dict so `POST
/api/services/test` can test the values the user just typed (`{"service":
"qbit", "url": …, "user": …, "password": …}` — the `service` field every
other candidate probe uses).
"""

import asyncio
from contextlib import contextmanager
from unittest.mock import patch

import aiohttp
import pytest

import config
from fastapi.testclient import TestClient

from app import app
from infrastructure import arr_client
from tests._stubs import _StubSession

client = TestClient(app, raise_server_exceptions=False)

QBIT_URL = "http://qbit.test:8080"
SENTINEL = "QBIT-PASSWORD-SECRETO-4242"

LOGIN = "/api/v2/auth/login"

SERVICE = {
    "key": "qbit",
    "kind": "qbittorrent",
    "url": QBIT_URL,
    "api_key": "",
    "user": "chan",
    "password": SENTINEL,
    "configured": True,
}


class _KwargSession(_StubSession):
    """Records the form each POST was made with: the credentials under test
    travel in `data`, and `calls` keeps only the URL."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.post_kwargs: list[tuple[str, dict]] = []

    def post(self, url, **kwargs):
        self.post_kwargs.append((str(url), kwargs))
        return super().post(url, **kwargs)


def _run(coroutine):
    return asyncio.run(coroutine)


@contextmanager
def patch_session(session):
    """`http_session()` builds an `aiohttp.ClientSession` per call — here it
    hands out THE stub, so no test can reach a real qBittorrent."""
    with patch("aiohttp.ClientSession", lambda *a, **k: session):
        yield


# ── 1. the SERVICES entry ────────────────────────────────────────────────────


class TestQbitServiceEntry:
    def test_the_list_carries_a_native_qbit_entry(self):
        entry = next(s for s in config.SERVICES if s["key"] == "qbit")

        assert entry["kind"] == "qbittorrent", (
            "nuevo kind: no confundir con el 'qbit' de la fachada aMuTorrent"
        )
        assert entry["api_key"] == "", "este servicio se autentica por login, no por api key"
        for field in ("url", "user", "password"):
            assert field in entry, f"la sonda necesita {field} para el login"

    def test_the_amutorrent_entry_keeps_its_own_kind(self):
        amu = next(s for s in config.SERVICES if s["key"] == "amutorrent")

        assert amu["kind"] == "qbit", "el kind antiguo no cambia (S7: amutorrent sigue vivo)"

    def test_configured_needs_url_user_and_password(self):
        entry = next(s for s in config.SERVICES if s["key"] == "qbit")

        assert entry["configured"] == bool(
            entry["url"] and entry["user"] and entry["password"]
        )

    def test_an_empty_default_is_not_configured(self):
        """D6/S3: settings only, sin default hardcoded — sin settings no hay
        servicio y `configured` es false."""
        real = config.get_setting
        config.get_setting = lambda *a, **k: k.get("default")
        config.rebuild()
        try:
            entry = next(s for s in config.SERVICES if s["key"] == "qbit")
            assert entry["url"] == ""
            assert entry["configured"] is False
        finally:
            config.get_setting = real
            config.rebuild()


# ── 2. the login probe ───────────────────────────────────────────────────────


def _probe(login=(200, "Ok."), service=None):
    routes = {LOGIN: login}
    session = _KwargSession(routes)
    return session, _run(arr_client.test_service_connection(session, service or dict(SERVICE)))


class TestQbitProbe:
    def test_ok_logs_in_and_reports_the_destination(self):
        session, result = _probe()

        assert result["ok"] is True
        assert result["detail"] == f"Conectado ({QBIT_URL})"
        assert result["url"] == QBIT_URL

    def test_the_probe_is_login_then_nothing(self):
        """S4: Bearer is 403 on the real build; and no version/meta fetch —
        the login answer IS the probe."""
        session, _ = _probe()

        posted = [u for u, _ in session.post_kwargs]
        assert len(posted) == 1 and posted[0].endswith(LOGIN)
        (url, kw) = session.post_kwargs[0]
        assert url == f"{QBIT_URL}{LOGIN}"
        assert kw["data"] == {
            "username": "chan",
            "password": SENTINEL,
            "rememberMe": "true",
        }
        assert kw["headers"]["Referer"] == QBIT_URL

    def test_rejected_credentials_are_not_a_connection(self):
        _, result = _probe(login=(200, "Fails."))

        assert result["ok"] is False
        assert result["detail"] == "Credenciales rechazadas"
        assert result["error_kind"] == "auth"

    def test_a_transport_error_is_honest(self):
        session = _KwargSession({LOGIN: (0, asyncio.TimeoutError())})

        result = _run(arr_client.test_service_connection(session, dict(SERVICE)))

        assert result["ok"] is False
        assert result["error_kind"] == "timeout"
        assert "sin respuesta" in result["detail"]

    def test_check_service_maps_the_same_probe(self):
        session = _KwargSession({LOGIN: (200, "Ok.")})

        state, reason, meta = _run(arr_client.check_service(session, dict(SERVICE)))

        assert state == "online"

    def test_check_service_calls_a_rejected_login_misconfigured(self):
        session = _KwargSession({LOGIN: (200, "Fails.")})

        state, reason, meta = _run(arr_client.check_service(session, dict(SERVICE)))

        assert state == "misconfigured"
        assert "Credenciales rechazadas" in reason

    def test_check_service_calls_a_dead_client_offline(self):
        session = _KwargSession({LOGIN: (0, aiohttp.ClientError("connection refused"))})

        state, reason, meta = _run(arr_client.check_service(session, dict(SERVICE)))

        assert state == "offline"
        assert "ClientError" in reason


# ── 3. the candidate probe (POST /api/services/test) ─────────────────────────


class TestQbitCandidateProbe:
    def test_the_service_field_selects_the_qbit_template(self):
        """The wizard contract: {"service": "qbit", …} — the same `service`
        field radarr and amutorrent use, never a new one."""
        session = _KwargSession({LOGIN: (200, "Ok.")})

        with patch_session(session):
            resp = client.post(
                "/api/services/test",
                json={"service": "qbit", "url": QBIT_URL, "user": "otro", "password": "escrita"},
            )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        assert body["results"][0]["key"] == "qbit"
        _, kw = session.post_kwargs[0]
        assert kw["data"]["username"] == "otro" and kw["data"]["password"] == "escrita", (
            "lo escrito en la tarjeta manda para esta llamada"
        )

    def test_the_response_never_carries_the_password(self):
        session = _KwargSession({LOGIN: (200, "Ok.")})

        with patch_session(session):
            resp = client.post(
                "/api/services/test",
                json={"service": "qbit", "url": QBIT_URL, "user": "chan", "password": SENTINEL},
            )

        assert SENTINEL not in resp.text, "la contraseña se coló en la respuesta"


# ── 4. the password never leaves the API ─────────────────────────────────────


class TestQbitPasswordNeverLeaks:
    @pytest.fixture
    def configured(self):
        """A SERVICES entry carrying the sentinel password (in place, like
        `tests_amule_service` does)."""
        idx = next(i for i, s in enumerate(config.SERVICES) if s["key"] == "qbit")
        original = config.SERVICES[idx]
        config.SERVICES[idx] = dict(SERVICE)
        try:
            yield
        finally:
            config.SERVICES[idx] = original

    def test_no_services_response_carries_the_password(self, configured):
        session = _KwargSession({LOGIN: (200, "Ok.")})

        with patch_session(session):
            texts = {
                "GET /api/services": client.get("/api/services").text,
                "GET /api/services/test": client.get("/api/services/test").text,
            }
            texts["POST /api/services/test"] = client.post(
                "/api/services/test", json={"service": "qbit"}
            ).text

        for where, text in texts.items():
            assert SENTINEL not in text, f"{where} filtró la contraseña de qBittorrent"

    def test_the_listed_entry_exposes_no_secret_fields(self, configured):
        body = client.get("/api/services").json()
        entry = next(s for s in body["services"] if s["key"] == "qbit")

        assert entry == {
            "key": "qbit",
            "kind": "qbittorrent",
            "url": QBIT_URL,
            "configured": True,
        }
