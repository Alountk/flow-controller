"""El cliente HTTP de `amuleapi`: login JWT, 401 terminal, errores tipados (T3, S2).

`docs/api/REFERENCE.md` de `amule-org/amule` (v1): `POST /api/v1/auth/login
?include_token=true` con `{"password": …}` devuelve `{"token": …}` y las
llamadas autenticadas viajan con `Authorization: Bearer`. El **primer 401 es
terminal para el token** (re-login y UN reintento; reintentar el token nunca
funciona y cada token rechazado cuenta para un limitador que bloquea la IP
300 s) y el **login jamás se reintenta** (limitador propio: 5 fallos/60 s →
300 s de bloqueo). Un `429` trae `Retry-After` y esos segundos entran en el
detalle del error.

Sólo se finge el transporte (`_StubSession` más secuencias por URL y cabeceras
de respuesta: el contrato necesita «401 y luego 200» en la MISMA URL y un
`Retry-After` que el stub base no sabe dar). El JSON exacto del login, la
caché del token, la regla 401 y los errores tipados son el contrato bajo
prueba. Contraseña y token son sentinelas: ningún fallo puede devolverlas en
`str(exc)` ni en `repr`.
"""

import asyncio

import aiohttp
import pytest

import config
from infrastructure.amuleapi_client import AmuleAPIError, AmuleAPIClient, login
from tests._stubs import _StubResponse, _StubSession

BASE = "http://amuleapi.test:4713"
PASSWORD = "AMULEAPI-PASS-SECRETO-9999"
TOKEN = "AMULEAPI-TOKEN-SECRETO-8888"

LOGIN_PATH = "/api/v1/auth/login"
LOGIN_URL = f"{BASE}{LOGIN_PATH}?include_token=true"
TARGET_PATH = "/api/v1/search"
TARGET_URL = f"{BASE}{TARGET_PATH}"

LOGIN_OK = (200, {"token": TOKEN, "role": "admin", "expires_at": 1893456000, "session_id": "s-1"})
ENVELOPE_401 = {"error": {"code": "unauthorized", "message": "token rejected"}}


class _Response(_StubResponse):
    """`_StubResponse` con cabeceras: un `429` lleva `Retry-After`."""

    def __init__(self, status, payload, headers=None):
        super().__init__(status, payload)
        self.headers = headers or {}


class _Session(_StubSession):
    """`_StubSession` + secuencias por URL exacta y kwargs registrados.

    Las rutas responden siempre lo mismo; la regla 401 necesita «401 y luego
    200» en la misma URL, y el contrato del login se juzga por sus kwargs.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.sequences: dict[str, list[tuple[int, object, dict]]] = {}
        self.sent: list[tuple[str, str, dict]] = []

    def post(self, url, **kwargs):
        self.sent.append(("POST", str(url), kwargs))
        return super().post(url, **kwargs)

    def request(self, method, url, **kwargs):
        self.sent.append((str(method), str(url), kwargs))
        return super().request(method, url, **kwargs)

    def _resolve(self, url):
        url = str(url)
        queue = self.sequences.get(url)
        if queue:
            self.calls.append((url, {}))
            status, payload, headers = queue.pop(0)
            if isinstance(payload, Exception):
                raise payload
            return _Response(status, payload, headers)
        resp = super()._resolve(url)
        resp.headers = {}
        return resp


def _run(coroutine):
    return asyncio.run(coroutine)


def _client() -> AmuleAPIClient:
    return AmuleAPIClient(BASE, PASSWORD)


def _logins(session: _Session) -> list[str]:
    return [url for _method, url, _kw in session.sent if LOGIN_PATH in url]


def _targets(session: _Session) -> list[dict]:
    return [kw for _method, url, kw in session.sent if url == TARGET_URL]


# ── 1. el login ──────────────────────────────────────────────────────────────


def test_the_login_posts_the_password_once_and_returns_the_token():
    session = _Session({LOGIN_PATH: LOGIN_OK})

    token = _run(login(session, BASE, PASSWORD))

    assert token == TOKEN
    assert [(m, u) for m, u, _ in session.sent] == [("POST", LOGIN_URL)], (
        "el login es exactamente ?include_token=true, una sola llamada"
    )
    kw = session.sent[0][2]
    assert kw["json"] == {"password": PASSWORD}
    assert kw["headers"] == {"Content-Type": "application/json"}, "JSON al 100%, sin Bearer"


# ── 2. el token se cachea ────────────────────────────────────────────────────


def test_two_requests_share_one_login():
    session = _Session({LOGIN_PATH: LOGIN_OK, TARGET_PATH: (200, {"results": []})})
    client = _client()

    first = _run(client.request(session, "GET", TARGET_PATH))
    second = _run(client.request(session, "GET", TARGET_PATH))

    assert first == second == {"results": []}
    assert len(_logins(session)) == 1, "el token se cachea: dos peticiones, un login"
    assert len(_targets(session)) == 2


def test_the_requests_carry_the_bearer_token():
    session = _Session({LOGIN_PATH: LOGIN_OK, TARGET_PATH: (200, {"results": []})})

    _run(_client().request(session, "GET", TARGET_PATH))

    assert _targets(session)[0]["headers"]["Authorization"] == f"Bearer {TOKEN}"


# ── 3. la regla 401 ──────────────────────────────────────────────────────────


def test_a_rejected_token_relogins_and_retries_once():
    session = _Session({LOGIN_PATH: LOGIN_OK})
    session.sequences[TARGET_URL] = [
        (401, ENVELOPE_401, {}),
        (200, {"results": ["ok"]}, {}),
    ]

    result = _run(_client().request(session, "GET", TARGET_PATH))

    assert result == {"results": ["ok"]}
    assert len(_logins(session)) == 2, "un re-login exactamente, no un bucle"
    assert len(_targets(session)) == 2, "la petición se reintenta una sola vez"


def test_a_second_401_raises_instead_of_looping():
    session = _Session({LOGIN_PATH: LOGIN_OK})
    session.sequences[TARGET_URL] = [
        (401, ENVELOPE_401, {}),
        (401, ENVELOPE_401, {}),
        (200, {"results": []}, {}),
    ]

    with pytest.raises(AmuleAPIError) as exc_info:
        _run(_client().request(session, "GET", TARGET_PATH))

    err = exc_info.value
    assert err.status == 401
    assert err.error_kind == "auth"
    assert session.sequences[TARGET_URL] == [(200, {"results": []}, {})], (
        "sin bucle: la tercera respuesta jamás se consume"
    )
    assert len(_targets(session)) == 2
    assert len(_logins(session)) == 2


# ── 4. el login fallido jamás se reintenta ───────────────────────────────────


@pytest.mark.parametrize("status", [401, 403])
def test_a_rejected_login_is_never_retried(status):
    body = {"error": {"code": "unauthorized", "message": "bad password"}}
    session = _Session({LOGIN_PATH: (status, body)})

    with pytest.raises(AmuleAPIError) as exc_info:
        _run(_client().request(session, "GET", TARGET_PATH))

    assert exc_info.value.status == status
    assert exc_info.value.error_kind == "auth"
    assert [u for _m, u, _kw in session.sent] == [LOGIN_URL], (
        "un intento de login, jamás dos: el limitador son 5 fallos/60 s"
    )


# ── 5. 429 con Retry-After ───────────────────────────────────────────────────


def test_a_limited_response_carries_the_retry_seconds():
    session = _Session({LOGIN_PATH: LOGIN_OK})
    session.sequences[TARGET_URL] = [
        (429, {"error": {"code": "rate_limited", "message": "too many requests"}},
         {"Retry-After": "300"}),
    ]

    with pytest.raises(AmuleAPIError) as exc_info:
        _run(_client().request(session, "GET", TARGET_PATH))

    err = exc_info.value
    assert err.status == 429
    assert "reintentar en 300 s" in err.detail, "el detalle nombra los segundos de Retry-After"


# ── 6. transporte honesto ────────────────────────────────────────────────────


def test_a_transport_timeout_says_the_seconds(monkeypatch):
    monkeypatch.setattr(config, "REQUEST_TIMEOUT", 5)
    session = _Session({LOGIN_PATH: LOGIN_OK, TARGET_PATH: (0, TimeoutError())})

    with pytest.raises(AmuleAPIError) as exc_info:
        _run(_client().request(session, "GET", TARGET_PATH))

    err = exc_info.value
    assert err.status is None
    assert err.error_kind == "timeout"
    assert "sin respuesta tras 5s" in err.detail, "el presupuesto es el detalle, no un «TimeoutError: » pelado"


def test_a_refused_connection_is_honest():
    session = _Session({
        LOGIN_PATH: LOGIN_OK,
        TARGET_PATH: (0, aiohttp.ClientError("connection refused")),
    })

    with pytest.raises(AmuleAPIError) as exc_info:
        _run(_client().request(session, "GET", TARGET_PATH))

    err = exc_info.value
    assert err.error_kind == "unreachable"
    assert "connection refused" in err.detail


# ── 7. guarda de JSON ────────────────────────────────────────────────────────


def test_a_non_json_success_becomes_a_typed_error():
    session = _Session({LOGIN_PATH: LOGIN_OK, TARGET_PATH: (200, "<html>oops</html>")})

    with pytest.raises(AmuleAPIError) as exc_info:
        _run(_client().request(session, "GET", TARGET_PATH))

    err = exc_info.value
    assert err.error_kind == "http"
    assert "JSON" in err.detail, "un cuerpo que no es JSON sube tipado, nunca como traceback"


# ── 8. secretos jamás ────────────────────────────────────────────────────────


def test_a_rejected_login_detail_never_carries_the_password():
    body = {"error": {"code": "unauthorized", "message": f"bad password {PASSWORD}"}}
    session = _Session({LOGIN_PATH: (401, body)})

    with pytest.raises(AmuleAPIError) as exc_info:
        _run(_client().request(session, "GET", TARGET_PATH))

    text = str(exc_info.value) + repr(exc_info.value)
    assert PASSWORD not in text, "la contraseña se coló en el error del login"


def test_a_rejected_request_detail_never_carries_the_password_or_the_token():
    body = {"error": {"code": "unauthorized", "message": f"token {TOKEN} for {PASSWORD} rejected"}}
    session = _Session({LOGIN_PATH: LOGIN_OK})
    session.sequences[TARGET_URL] = [(401, body, {}), (401, body, {})]

    with pytest.raises(AmuleAPIError) as exc_info:
        _run(_client().request(session, "GET", TARGET_PATH))

    text = str(exc_info.value) + repr(exc_info.value)
    assert PASSWORD not in text, "la contraseña se coló en el error de la petición"
    assert TOKEN not in text, "el token se coló en el error de la petición"


def test_the_client_repr_carries_no_secret():
    client = _client()
    client.token = TOKEN

    text = repr(client)

    assert PASSWORD not in text and TOKEN not in text, "el repr del cliente filtra secretos"
