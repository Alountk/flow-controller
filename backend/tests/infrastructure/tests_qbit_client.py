"""The NATIVE qBittorrent client: login+SID, one add, an honest contract.

S1: no aMuTorrent bypass, no new dependency — `infrastructure.qbit_client`
speaks the qBittorrent web API with aiohttp alone. S2: the answer names its
destination on the way in («Descarga añadida en qBittorrent (URL), categoría
flow») AND on the way out («qBittorrent (URL) no aceptó la descarga: …»).
S5 is the reason this module exists: the old bridge looked at the STATUS only
and aMuTorrent answers 200+`Fail.` to every add, so a total failure read as
success. Here success is HTTP 200 AND body `strip()` in {"", "Ok."} — and
nothing else is.

S4, verified against the live client (see the feature doc, Log L3): auth is
login + SID cookie + `Referer` (Bearer gets 403 on the real build), the add
carries `urls` + `category` with `Referer`/`Origin`, and there is NO
`ensure_category` step — `createCategories` 404s in this build and the add
auto-creates the category. Only two POSTs exist in this module's whole life:
login and add.

Only the HTTP transport is faked (`_StubSession`, plus a kwarg recorder in the
`tests_direct_add` style): the form fields, the headers, the timeout budget
and the success rule are the contract under test.
"""

import asyncio
import logging

import aiohttp
import pytest

import config
from infrastructure.qbit_client import DIRECT_DOWNLOAD_CATEGORY, qbit_add_download
from tests._stubs import _StubSession

QBIT_URL = "http://qbit.test:8080"
QBIT_USER = "chan"
QBIT_PASSWORD = "pass-falso-1234"

MAGNET = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"

LOGIN = f"{QBIT_URL}/api/v2/auth/login"
ADD = f"{QBIT_URL}/api/v2/torrents/add"

UNCONFIGURED = "qBittorrent no está configurado — añádelo en Configuración → Servicios"


class _KwargSession(_StubSession):
    """`_StubSession.calls` keeps only the URL; the form, the headers and the
    timeout budget all travel as kwargs, so they must be recorded too."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.post_kwargs: list[tuple[str, dict]] = []

    def post(self, url, **kwargs):
        self.post_kwargs.append((str(url), kwargs))
        return super().post(url, **kwargs)


@pytest.fixture
def qbit(monkeypatch):
    """The configured service, read at call time from `config`'s globals."""
    monkeypatch.setattr(config, "QBIT_URL", QBIT_URL)
    monkeypatch.setattr(config, "QBIT_USER", QBIT_USER)
    monkeypatch.setattr(config, "QBIT_PASSWORD", QBIT_PASSWORD)


def _session(login=(200, "Ok."), add=(200, "Ok."), **kwargs) -> _KwargSession:
    return _KwargSession({LOGIN: login, ADD: add}, **kwargs)


# ── the login ────────────────────────────────────────────────────────────────


def test_the_login_posts_the_credentials_with_a_referer(qbit):
    session = _session()

    asyncio.run(qbit_add_download(session, MAGNET))

    (url, kw) = session.post_kwargs[0]
    assert url == LOGIN
    assert kw["data"] == {
        "username": QBIT_USER,
        "password": QBIT_PASSWORD,
        "rememberMe": "true",
    }
    assert kw["headers"]["Referer"] == QBIT_URL


def test_rejected_credentials_refuse_the_add_and_say_so(qbit):
    session = _session(login=(200, "Fails."))

    result = asyncio.run(qbit_add_download(session, MAGNET))

    assert result == {"ok": False, "detail": f"qBittorrent rechazó las credenciales ({QBIT_URL})"}
    assert [u for u, _ in session.calls] == [LOGIN], "a refused login never reaches the add"


# ── the add ──────────────────────────────────────────────────────────────────


def test_the_add_rides_the_login_session_with_urls_and_category(qbit):
    session = _session()

    result = asyncio.run(qbit_add_download(session, MAGNET))

    (url, kw) = session.post_kwargs[1]
    assert url == ADD
    assert kw["data"] == {"urls": MAGNET, "category": DIRECT_DOWNLOAD_CATEGORY}
    assert kw["headers"] == {"Referer": QBIT_URL, "Origin": QBIT_URL}
    # SAME session for login and add: the SID cookie is what authenticates it.
    assert [u for u, _ in session.calls] == [LOGIN, ADD]
    assert result == {
        "ok": True,
        "detail": f"Descarga añadida en qBittorrent ({QBIT_URL}), categoría flow",
        "category": "flow",
    }


def test_an_ok_body_with_whitespace_still_counts_as_success(qbit):
    session = _session(add=(200, "Ok.\n"))

    result = asyncio.run(qbit_add_download(session, MAGNET))

    assert result["ok"] is True


def test_an_empty_body_is_success_too(qbit):
    session = _session(add=(200, ""))

    result = asyncio.run(qbit_add_download(session, MAGNET))

    assert result["ok"] is True


def test_the_category_is_named_in_the_success_detail(qbit):
    """S2: the answer says WHERE the download went, every time."""
    session = _session()

    result = asyncio.run(qbit_add_download(session, MAGNET))

    assert f"qBittorrent ({QBIT_URL})" in result["detail"]
    assert "categoría flow" in result["detail"]


# ── the honest failure matrix (S5) ───────────────────────────────────────────


def test_a_400_with_fail_says_http_and_body(qbit):
    session = _session(add=(400, "Fail."))

    result = asyncio.run(qbit_add_download(session, MAGNET))

    assert result["ok"] is False
    assert "HTTP 400" in result["detail"]
    assert "Fail." in result["detail"]
    assert f"qBittorrent ({QBIT_URL})" in result["detail"], "S2: el rechazo nombra el destino"


def test_a_200_with_fail_is_a_failure_not_a_success(qbit):
    """THE regression: aMuTorrent answered 200+`Fail.` and the old bridge
    called that success. Under S5 the body is half of the contract."""
    session = _session(add=(200, "Fail."))

    result = asyncio.run(qbit_add_download(session, MAGNET))

    assert result["ok"] is False
    assert "Fail." in result["detail"]


def test_a_200_with_fails_is_a_failure_too(qbit):
    session = _session(add=(200, "Fails."))

    result = asyncio.run(qbit_add_download(session, MAGNET))

    assert result["ok"] is False
    assert "Fails." in result["detail"]


def test_a_timed_out_add_says_how_long_it_waited(qbit):
    # str(TimeoutError()) is empty: the detail must carry the budget instead
    # of a dangling "TimeoutError: " (the `_empty_answer_detail` precedent).
    session = _session(add=(0, asyncio.TimeoutError()))

    result = asyncio.run(qbit_add_download(session, MAGNET))

    assert result["ok"] is False
    assert f"TimeoutError: sin respuesta tras {int(config.REQUEST_TIMEOUT * 12)}s" in result["detail"]


def test_a_transport_error_keeps_its_type_name(qbit):
    session = _session(add=(0, aiohttp.ClientError("connection refused")))

    result = asyncio.run(qbit_add_download(session, MAGNET))

    assert result["ok"] is False
    assert "ClientError" in result["detail"]


def test_an_apikey_in_an_echoed_body_is_redacted(qbit):
    session = _session(add=(400, "rechazada apikey=SEKRET-KEY-9876 (SEKRET-KEY-9876)"))

    result = asyncio.run(qbit_add_download(session, MAGNET))

    assert result["ok"] is False
    assert "SEKRET-KEY-9876" not in result["detail"], "una apikey se coló en la respuesta"
    assert "apikey=****" in result["detail"]


# ── budget and bookkeeping ───────────────────────────────────────────────────


def test_the_add_waits_the_ed2k_budget_of_the_precedent(qbit):
    # ×12 measured on the throttled ED2K add (precedent PR #193): the add POST
    # is what kicks the client's work off, and ×2 gave up while it was running.
    session = _session()

    asyncio.run(qbit_add_download(session, MAGNET))

    for _, kw in session.post_kwargs:
        assert kw["timeout"].total == config.REQUEST_TIMEOUT * 12


def test_the_add_logs_what_it_is_about_to_post(qbit, caplog):
    session = _session()

    with caplog.at_level(logging.INFO, logger="flow-controller"):
        asyncio.run(qbit_add_download(session, MAGNET))

    assert "qbit_add_download" in caplog.text
    assert DIRECT_DOWNLOAD_CATEGORY in caplog.text
    assert MAGNET[:48] in caplog.text


def test_no_category_step_exists_anywhere(qbit):
    """S4: `createCategories` 404s on the real build and the add auto-creates
    the category — an ensure step would fail every add on a false alarm."""
    session = _session()

    asyncio.run(qbit_add_download(session, MAGNET))

    posted = [u for u, _ in session.post_kwargs]
    assert posted == [LOGIN, ADD], f"only login and add may be posted, got {posted}"


def test_the_category_is_the_one_the_arr_never_polls(qbit):
    assert DIRECT_DOWNLOAD_CATEGORY == "flow"


# ── unconfigured (S3) ────────────────────────────────────────────────────────


@pytest.mark.parametrize("missing", ["QBIT_URL", "QBIT_USER", "QBIT_PASSWORD"])
def test_an_unconfigured_service_refuses_without_any_http_call(monkeypatch, missing):
    values = {"QBIT_URL": QBIT_URL, "QBIT_USER": QBIT_USER, "QBIT_PASSWORD": QBIT_PASSWORD}
    values[missing] = ""
    for name, value in values.items():
        monkeypatch.setattr(config, name, value)
    session = _session()

    result = asyncio.run(qbit_add_download(session, MAGNET))

    assert result == {"ok": False, "detail": UNCONFIGURED}
    assert session.calls == [], "sin configurar no hay ni un POST que fallar"
