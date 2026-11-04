"""El canal de avisos ntfy (C-01, S1/S2/S7).

El contrato es la API **JSON publish** de ntfy, no el «POST al topic con
cabeceras»: `Title`/`Tags` son cabeceras HTTP y los títulos de este panel
llevan acentos («Películas», «añadida»), que en una cabecera son terreno
movedizo. Con JSON el topic y los textos viajan en el cuerpo, en UTF-8.

Sólo se falsea el transporte (`_StubSession`), así que el cuerpo real de
`send` corre — el mismo estilo que `tests_arr_client.py`.
"""

import asyncio
from unittest.mock import patch

import pytest

from application.use_cases import notifier
from infrastructure import settings_store
from tests._stubs import _StubSession


class _RecordingSession(_StubSession):
    """Stub que además guarda el cuerpo y las cabeceras del POST.

    El contrato vive ahí: el topic y los textos en el JSON, el token en
    `Authorization`, y nunca el token dentro de la URL.
    """

    def __init__(self, routes=None):
        super().__init__(routes)
        self.posts: list[dict] = []

    def post(self, url, **kwargs):
        self.posts.append({"url": str(url), "json": kwargs.get("json"), "headers": kwargs.get("headers") or {}, "data": kwargs.get("data")})
        return self._resolve(str(url))


@pytest.fixture(autouse=True)
def _restore_settings():
    before = settings_store._settings
    yield
    settings_store._settings = before


def _channel(url="http://ntfy.test:8080", topic="flowcontroller", token="", enabled=True):
    settings_store._settings = {
        "notifications": {"ntfy": {"url": url, "topic": topic, "token": token, "enabled": enabled}}
    }


def _send(session, **kwargs):
    with patch.object(notifier, "http_session", return_value=session):
        return asyncio.run(notifier.send(**kwargs))


def test_without_a_channel_nothing_is_sent_and_the_result_says_so():
    settings_store._settings = {"notifications": {"ntfy": {"url": "", "topic": "", "token": "", "enabled": True}}}
    session = _RecordingSession()

    result = _send(session, title="Descarga terminada", message="Dune")

    assert result["ok"] is False
    assert result["error"] == "not-configured"
    assert session.posts == [], "un canal sin URL/topic no debe tocar la red"


def test_a_configured_but_disabled_channel_stays_silent():
    _channel(enabled=False)
    session = _RecordingSession()

    result = _send(session, title="Descarga terminada", message="Dune")

    assert result["ok"] is False
    assert result["error"] == "not-configured"
    assert session.posts == []


def test_the_aviso_reaches_ntfy_as_a_json_publish():
    _channel()
    session = _RecordingSession({"ntfy.test": (200, {"id": "abc", "topic": "flowcontroller"})})

    result = _send(session, title="Descarga terminada", message="Dune (2021) 2160p", tags=["arrow_down"])

    assert result["ok"] is True
    assert result["status"] == 200
    assert isinstance(result["elapsed_ms"], int) and result["elapsed_ms"] >= 0
    (posted,) = session.posts
    assert posted["url"] == "http://ntfy.test:8080"
    body = posted["json"]
    assert body["topic"] == "flowcontroller"
    assert body["title"] == "Descarga terminada"
    assert body["message"] == "Dune (2021) 2160p"
    assert body["tags"] == ["arrow_down"]


def test_the_token_travels_in_the_authorization_header_and_never_in_the_url():
    _channel(url="http://ntfy.test:8080", token="tk_secret_value")
    session = _RecordingSession({"ntfy.test": (200, {"id": "abc"})})

    result = _send(session, title="Aviso", message="contenido")

    assert result["ok"] is True
    (posted,) = session.posts
    assert posted["headers"]["Authorization"] == "Bearer tk_secret_value"
    assert "tk_secret_value" not in posted["url"]


def test_a_broken_channel_reports_the_failure_instead_of_raising():
    _channel()
    session = _RecordingSession({"ntfy.test": (0, ConnectionRefusedError("rechazado"))})

    result = _send(session, title="Descarga terminada", message="Dune")

    assert result["ok"] is False
    assert result["status"] is None
    assert result["error"], "un fallo de transporte tiene que dejar motivo"


def test_a_rejected_publish_is_not_reported_as_success():
    _channel(token="tk_bad")
    session = _RecordingSession({"ntfy.test": (403, {"error": "unauthorized"})})

    result = _send(session, title="Descarga terminada", message="Dune")

    assert result["ok"] is False
    assert result["status"] == 403
    assert isinstance(result["elapsed_ms"], int)


def test_the_aviso_texts_travel_in_utf8():
    """Un título con acentos en una cabecera HTTP es terreno movedizo."""
    _channel()
    session = _RecordingSession({"ntfy.test": (200, {"id": "abc"})})

    _send(session, title="Película importada", message="Amélie (2001) — añadida a la biblioteca")

    (posted,) = session.posts
    assert posted["json"]["title"] == "Película importada"
    assert posted["json"]["message"] == "Amélie (2001) — añadida a la biblioteca"
    assert all(value.isascii() for value in posted["headers"].values())
