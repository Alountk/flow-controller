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

T4a/S2 añade búsqueda ed2k (`search`: arranque exacto, sondeo hasta
`finished`, presupuesto que dispara stop + error timeout tipado), `free_search`
(DELETE que libera), `ensure_category` (listar, crear UNA vez si falta) y
`promote_result` (cuerpo exacto). Todo pasa por la misma caché de token y la
regla 401: un 401 a mitad de sondeo re-logina UNA vez, sin bucle.
"""

import asyncio

import aiohttp
import pytest

import config
from infrastructure.amuleapi_client import (
    AmuleAPIError, AmuleAPIClient, ensure_category, free_search, login, promote_result, search,
)
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


# ── 9. T4a: búsqueda ed2k — arranque y cuerpo exactos ─────────────────────────

SEARCH_PATH = "/api/v1/search"
SEARCH_URL = f"{BASE}{SEARCH_PATH}"
SEARCH_ID = 42
RESULTS_PATH = f"{SEARCH_PATH}/{SEARCH_ID}/results?limit=1000000000"
RESULTS_URL = f"{BASE}{RESULTS_PATH}"
STOP_URL = f"{BASE}{SEARCH_PATH}/{SEARCH_ID}/stop"
DELETE_URL = f"{BASE}{SEARCH_PATH}/{SEARCH_ID}"
CATEGORIES_PATH = "/api/v1/categories"
CATEGORIES_URL = f"{BASE}{CATEGORIES_PATH}?limit=1000000000"
CREATE_URL = f"{BASE}{CATEGORIES_PATH}"
RESULT_HASH = "8b54a3c2d4e5f60718293a4b5c6d7e8f"
PROMOTE_URL = f"{BASE}/api/v1/search/results/{RESULT_HASH}/download"

SEARCH_ROW = {
    "search_id": 42, "query": "ubuntu desktop iso", "type": "global", "state": "running",
    "client_ecid": None, "started_at": 1750412400,
    "file_type": None, "extension": None, "min_size_bytes": None, "max_size_bytes": None,
    "min_source_count": None, "min_bitrate_kilobits_per_second": None,
    "min_duration_seconds": None, "codec": None, "title": None, "album": None, "artist": None,
}
RESULT_ROW = {
    "hash": RESULT_HASH,
    "name": "example-distribution-26.04-amd64.iso",
    "size_bytes": 3825205248,
    "sources": {"total": 217, "complete": 142},
    "already_downloaded": False,
    "rating": 0,
    "status": "new",
    "file_type": "video",
    "directory": "",
    "media": {"duration_seconds": 5400, "bitrate_kilobits_per_second": 1500,
              "codec": "H.264", "artist": "", "album": "", "title": ""},
    "alternate_names": [
        {"ecid": 621, "name": "example-distribution-26.04.iso",
         "sources": {"total": 40, "complete": 22}, "directory": ""},
    ],
    "kad_comment_lookup_running": False,
    "comments": [],
}
RESULT_ROW_2 = {
    "hash": "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
    "name": "example-distro-2604-amd64.iso",
    "size_bytes": 123456,
    "sources": {"total": 3, "complete": 1},
    "already_downloaded": True,
    "rating": 4,
    "status": "downloaded",
    "file_type": "unknown",
    "directory": "distros",
    "media": None,
    "alternate_names": [],
    "kad_comment_lookup_running": False,
    "comments": [],
}
LINK_1 = f"ed2k://|file|{RESULT_ROW['name']}|{RESULT_ROW['size_bytes']}|{RESULT_HASH}|/"
LINK_2 = f"ed2k://|file|{RESULT_ROW_2['name']}|{RESULT_ROW_2['size_bytes']}|{RESULT_ROW_2['hash']}|/"
RUNNING = {
    "results": [RESULT_ROW], "search_id": 42, "query": "ubuntu desktop iso",
    "progress": {"state": "running", "type": "global", "kad_active": False, "percent": 40},
}
FINISHED = {
    "results": [RESULT_ROW, RESULT_ROW_2], "search_id": 42, "query": "ubuntu desktop iso",
    "progress": {"state": "finished", "type": "global", "kad_active": False, "percent": 100},
}
ENVELOPE_503 = {"error": {"code": "ec_unavailable", "message": "EC down"}}


def _sent(session: _Session, url: str) -> list[tuple[str, dict]]:
    return [(m, kw) for m, u, kw in session.sent if u == url]


def test_search_starts_with_the_exact_path_and_body():
    session = _Session({LOGIN_PATH: LOGIN_OK})
    session.sequences[SEARCH_URL] = [(202, SEARCH_ROW, {})]
    session.sequences[RESULTS_URL] = [(200, FINISHED, {})]

    result = _run(search(_client(), session, "ubuntu desktop iso", deadline_seconds=5, poll_interval=0))

    assert [(m, u) for m, u, _kw in session.sent if u == SEARCH_URL] == [("POST", SEARCH_URL)]
    kw = _sent(session, SEARCH_URL)[0][1]
    assert kw["json"] == {"query": "ubuntu desktop iso", "type": "global"}, (
        "el arranque es POST /api/v1/search con sólo las claves de REFERENCE.md"
    )
    assert kw["headers"]["Authorization"] == f"Bearer {TOKEN}"
    assert result["search_id"] == SEARCH_ID


def test_the_start_body_carries_only_the_filters_the_caller_gave():
    session = _Session({LOGIN_PATH: LOGIN_OK})
    session.sequences[SEARCH_URL] = [(202, SEARCH_ROW, {})]
    session.sequences[RESULTS_URL] = [(200, FINISHED, {})]

    _run(search(
        _client(), session, "concert", deadline_seconds=5, poll_interval=0,
        search_type="kad", file_type="audio", extension="flac", min_size_bytes=1000,
        min_bitrate_kilobits_per_second=320, artist="Example Artist",
    ))

    assert _sent(session, SEARCH_URL)[0][1]["json"] == {
        "query": "concert", "type": "kad", "file_type": "audio", "extension": "flac",
        "min_size_bytes": 1000, "min_bitrate_kilobits_per_second": 320, "artist": "Example Artist",
    }, "sólo las claves dadas, con los nombres exactos del cuerpo de REFERENCE.md"


# ── 10. T4a: el sondeo devuelve los ítems neutros ─────────────────────────────


def test_the_poll_returns_every_reference_field_plus_the_ed2k_link():
    session = _Session({LOGIN_PATH: LOGIN_OK})
    session.sequences[SEARCH_URL] = [(202, SEARCH_ROW, {})]
    session.sequences[RESULTS_URL] = [(200, RUNNING, {}), (200, FINISHED, {})]

    result = _run(search(_client(), session, "ubuntu desktop iso", deadline_seconds=5, poll_interval=0))

    assert [(m, u) for m, u, _kw in session.sent if u == RESULTS_URL] == [
        ("GET", RESULTS_URL), ("GET", RESULTS_URL),
    ], "el sondeo pide la página entera (?limit=…) y sigue mientras «state == running»"
    assert result["search_id"] == SEARCH_ID
    assert result["results"] == [{**RESULT_ROW, "ed2k_link": LINK_1}, {**RESULT_ROW_2, "ed2k_link": LINK_2}], (
        "todos los campos de REFERENCE.md, sin filtrar ni ordenar, más el enlace ed2k compuesto"
    )


def test_the_whole_lifecycle_shares_one_login():
    session = _Session({LOGIN_PATH: LOGIN_OK})
    session.sequences[SEARCH_URL] = [(202, SEARCH_ROW, {})]
    session.sequences[RESULTS_URL] = [(200, RUNNING, {}), (200, FINISHED, {})]

    _run(search(_client(), session, "q", deadline_seconds=5, poll_interval=0))

    assert len(_logins(session)) == 1, "arranque y sondeos comparten el token cacheado"
    auths = [kw["headers"]["Authorization"] for _m, _u, kw in session.sent
             if "Authorization" in kw.get("headers", {})]
    assert auths == [f"Bearer {TOKEN}"] * 3


# ── 11. T4a: el presupuesto del llamador manda ────────────────────────────────


def test_the_deadline_stops_the_search_and_raises_the_typed_timeout():
    session = _Session({LOGIN_PATH: LOGIN_OK})
    session.sequences[SEARCH_URL] = [(202, SEARCH_ROW, {})]
    session.sequences[RESULTS_URL] = [(200, RUNNING, {})] * 8
    session.sequences[STOP_URL] = [(204, {}, {})]

    with pytest.raises(AmuleAPIError) as exc_info:
        _run(search(_client(), session, "q", deadline_seconds=0.3, poll_interval=0.05))

    err = exc_info.value
    assert err.status is None and err.error_kind == "timeout"
    assert "0.3" in err.detail, "el detalle nombra los segundos del presupuesto"
    polls = _sent(session, RESULTS_URL)
    assert 2 <= len(polls) <= 8, f"sondeos acotados por el presupuesto, nunca un bucle: {len(polls)}"
    assert [(m, u) for m, u, _kw in session.sent if u == STOP_URL] == [("POST", STOP_URL)], (
        "agotado el presupuesto: stop (conserva resultados), exactamente una vez"
    )
    assert _sent(session, DELETE_URL) == [], "el delete LIBERA los resultados y aquí no se elige"


def test_the_timeout_survives_a_failing_best_effort_stop():
    session = _Session({LOGIN_PATH: LOGIN_OK})
    session.sequences[SEARCH_URL] = [(202, SEARCH_ROW, {})]
    session.sequences[RESULTS_URL] = [(200, RUNNING, {})] * 8
    session.sequences[STOP_URL] = [(503, ENVELOPE_503, {})]

    with pytest.raises(AmuleAPIError) as exc_info:
        _run(search(_client(), session, "q", deadline_seconds=0.3, poll_interval=0.05))

    err = exc_info.value
    assert err.error_kind == "timeout", "el stop es mejor esfuerzo: jamás tapa el timeout"
    assert len(_sent(session, STOP_URL)) == 1


# ── 12. T4a: 401 a mitad de sondeo sigue la regla terminal ────────────────────


def test_a_401_mid_poll_relogins_once_and_never_loops():
    session = _Session({LOGIN_PATH: LOGIN_OK})
    session.sequences[SEARCH_URL] = [(202, SEARCH_ROW, {})]
    session.sequences[RESULTS_URL] = [(200, RUNNING, {}), (401, ENVELOPE_401, {}), (200, FINISHED, {})]

    result = _run(search(_client(), session, "q", deadline_seconds=5, poll_interval=0))

    assert result["search_id"] == SEARCH_ID
    assert len(_logins(session)) == 2, "re-login exactamente una vez, sin bucle"
    assert len(_sent(session, RESULTS_URL)) == 3, "el sondeo 401 se reintenta una sola vez"


# ── 13. T4a: liberar la búsqueda y promover a la cola ─────────────────────────


def test_freeing_a_search_deletes_it_exactly_once():
    session = _Session({LOGIN_PATH: LOGIN_OK})
    session.sequences[DELETE_URL] = [(204, {}, {})]

    _run(free_search(_client(), session, SEARCH_ID))

    assert [(m, u) for m, u, _kw in session.sent if u == DELETE_URL] == [("DELETE", DELETE_URL)]


def test_promote_posts_the_exact_path_and_body():
    session = _Session({LOGIN_PATH: LOGIN_OK})
    session.sequences[PROMOTE_URL] = [(202, {}, {})]

    _run(promote_result(_client(), session, RESULT_HASH, category_index=2, ecid=621))

    assert [(m, u) for m, u, _kw in session.sent if u == PROMOTE_URL] == [("POST", PROMOTE_URL)]
    assert _sent(session, PROMOTE_URL)[0][1]["json"] == {"category_index": 2, "ecid": 621}


def test_promote_without_options_sends_an_empty_body():
    session = _Session({LOGIN_PATH: LOGIN_OK})
    session.sequences[PROMOTE_URL] = [(202, {}, {})]

    _run(promote_result(_client(), session, RESULT_HASH))

    assert _sent(session, PROMOTE_URL)[0][1]["json"] == {}, "ambas claves son opcionales en REFERENCE.md"


# ── 14. T4a: ensure_category — listar, crear UNA vez si falta ─────────────────

DEFAULT_ROW = {"index": 0, "name": "Default", "save_path": "/home/user/aMule/Incoming",
               "comment": "", "color": "#1664c0", "priority": "low"}
PELIS_ROW = {"index": 3, "name": "Pelis", "save_path": "/in/Pelis", "comment": "",
             "color": "#1664c0", "priority": "high"}
SERIES_ROW = {"index": 5, "name": "Series", "save_path": "/in/Series",
              "comment": "Series only", "color": "#ff0000", "priority": "normal"}
X_ROW = {"index": 7, "name": "X", "save_path": "/in/X", "comment": "",
         "color": "#1664c0", "priority": "low"}


def _page(rows):
    return {"categories": rows, "total": len(rows), "offset": 0, "limit": len(rows)}


def test_an_existing_category_comes_back_without_a_create():
    session = _Session({LOGIN_PATH: LOGIN_OK})
    session.sequences[CATEGORIES_URL] = [(200, _page([DEFAULT_ROW, PELIS_ROW]), {})]

    row = _run(ensure_category(_client(), session, "Pelis"))

    assert row == PELIS_ROW, "la fila tal cual, con su índice"
    assert len(_sent(session, CATEGORIES_URL)) == 1, "un solo listado"
    assert _sent(session, CREATE_URL) == [], "existente: ni un create"


def test_a_missing_category_is_created_exactly_once_with_the_right_body():
    session = _Session({LOGIN_PATH: LOGIN_OK})
    session.sequences[CATEGORIES_URL] = [
        (200, _page([DEFAULT_ROW]), {}),
        (200, _page([DEFAULT_ROW, SERIES_ROW]), {}),
    ]
    session.sequences[CREATE_URL] = [(202, {}, {})]

    row = _run(ensure_category(
        _client(), session, "Series", save_path="/in/Series", comment="Series only",
        color="#ff0000", priority="normal",
    ))

    assert row == SERIES_ROW, "el índice llega del re-listado (REFERENCE: el 202 no lo trae)"
    assert [(m, u) for m, u, _kw in session.sent if u == CREATE_URL] == [("POST", CREATE_URL)], (
        "exactamente un create"
    )
    assert _sent(session, CREATE_URL)[0][1]["json"] == {
        "name": "Series", "save_path": "/in/Series", "comment": "Series only",
        "color": "#ff0000", "priority": "normal",
    }
    assert len(_sent(session, CATEGORIES_URL)) == 2, "listar → crear → re-leer para el índice"


def test_a_create_with_no_options_carries_only_the_name():
    session = _Session({LOGIN_PATH: LOGIN_OK})
    session.sequences[CATEGORIES_URL] = [(200, _page([DEFAULT_ROW]), {}), (200, _page([X_ROW]), {})]
    session.sequences[CREATE_URL] = [(202, {}, {})]

    _run(ensure_category(_client(), session, "X"))

    assert _sent(session, CREATE_URL)[0][1]["json"] == {"name": "X"}, "claves opcionales: omitidas"


def test_a_category_that_never_appears_is_an_honest_typed_error():
    session = _Session({LOGIN_PATH: LOGIN_OK})
    session.sequences[CATEGORIES_URL] = [(200, _page([DEFAULT_ROW]), {})] * 2
    session.sequences[CREATE_URL] = [(202, {}, {})]

    with pytest.raises(AmuleAPIError) as exc_info:
        _run(ensure_category(_client(), session, "Fantasma"))

    assert exc_info.value.error_kind == "http"
    assert "Fantasma" in exc_info.value.detail, "el detalle dice qué categoría no aparece"
    assert len(_sent(session, CREATE_URL)) == 1, "un create jamás dos"


# ── 15. T4a: secretos jamás en los caminos nuevos ─────────────────────────────

SECRET_ENVELOPE = {"error": {"code": "bad_request", "message": f"denied {TOKEN} {PASSWORD}"}}


@pytest.mark.parametrize("failing", ["start", "results", "category", "promote"])
def test_every_new_failure_path_keeps_the_password_and_the_token_out(failing):
    session = _Session({LOGIN_PATH: LOGIN_OK})
    session.sequences[SEARCH_URL] = [(202, SEARCH_ROW, {})]
    session.sequences[RESULTS_URL] = [(200, RUNNING, {}), (500, SECRET_ENVELOPE, {})]
    session.sequences[CATEGORIES_URL] = [(200, _page([DEFAULT_ROW]), {})]
    session.sequences[CREATE_URL] = [(403, SECRET_ENVELOPE, {})]
    session.sequences[PROMOTE_URL] = [(400, SECRET_ENVELOPE, {})]
    if failing == "start":
        session.sequences[SEARCH_URL] = [(400, SECRET_ENVELOPE, {})]
    client = _client()

    with pytest.raises(AmuleAPIError) as exc_info:
        if failing in ("start", "results"):
            _run(search(client, session, "q", deadline_seconds=5, poll_interval=0))
        elif failing == "category":
            _run(ensure_category(client, session, "Series"))
        else:
            _run(promote_result(client, session, RESULT_HASH))

    text = str(exc_info.value) + repr(exc_info.value)
    assert PASSWORD not in text, "la contraseña se coló en un fallo nuevo"
    assert TOKEN not in text, "el token se coló en un fallo nuevo"
