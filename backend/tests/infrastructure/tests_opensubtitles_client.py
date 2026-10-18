"""Cliente OpenSubtitles: búsqueda aplanada por fichero y descarga gzip (S6/T6).

Contrato fijado aquí:

- `search_subtitles` pide `GET /api/v1/subtitles` con `query`, `languages`,
  `order_by=download_count` y `order_direction=desc`, autenticando con
  `Api-Key` + `User-Agent: flow-controller/0.1.0` + `Accept: application/json`;
  devuelve UNA entrada por fichero de `files` (`file_id`, `language`,
  `release`, `title`, `file_name`) limitada a `limit`; sin `data` → `[]`;
- `download_subtitle` pide `POST /api/v1/download` con `{"file_id": …}` y la
  misma autenticación + `Content-Type: application/json`, sigue el `link`
  devuelto y descomprime el gzip a texto `.srt` (UTF-8, errors="replace");
- todo fallo sube como `OpenSubtitlesError` con mensaje corto y SIN la API
  key — jamás se registra ni se devuelve la clave.

Todo stubbeado en la capa HTTP (`httpx.MockTransport`): aquí no hay red.
"""

import gzip
import json

import httpx
import pytest

from infrastructure import opensubtitles_client
from infrastructure.opensubtitles_client import OpenSubtitlesError

API_KEY = "test-opensubtitles-key"
SRT_TEXT = "1\n00:00:01,000 --> 00:00:02,000\nHola\n"

#: Una entrada `data` de la API real: atributos + varios `files`.
_ITEM_TWO_FILES = {
    "id": "1234",
    "attributes": {
        "language": "es",
        "release": "Mixer.2024.1080p.WEB-DL",
        "feature_details": {"title": "Mixer"},
        "files": [
            {"file_id": 42, "file_name": "Mixer.es.srt"},
            {"file_id": 43, "file_name": "Mixer.es.Forced.srt"},
        ],
    },
}


def _stub(monkeypatch, handler):
    """Send the client's HTTP through MockTransport — the request pipeline is
    real, the network is not."""
    monkeypatch.setattr(
        opensubtitles_client,
        "_client",
        lambda timeout: httpx.Client(transport=httpx.MockTransport(handler), timeout=timeout),
    )


def _item(file_id: int, language: str = "es") -> dict:
    return {
        "id": str(file_id),
        "attributes": {
            "language": language,
            "release": f"release-{file_id}",
            "feature_details": {"title": "Mixer"},
            "files": [{"file_id": file_id, "file_name": f"Mixer.{file_id}.srt"}],
        },
    }


# ── Búsqueda ────────────────────────────────────────────────────────────────


def test_search_queries_by_language_and_orders_by_downloads(monkeypatch):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = request.url
        seen["headers"] = request.headers
        return httpx.Response(200, json={"data": [_item(1)]})

    _stub(monkeypatch, handler)

    results = opensubtitles_client.search_subtitles(API_KEY, "Mixer", "spa,eng", limit=5)

    assert seen["url"].path == "/api/v1/subtitles"
    assert seen["url"].params["query"] == "Mixer"
    assert seen["url"].params["languages"] == "spa,eng"
    assert seen["url"].params["order_by"] == "download_count"
    assert seen["url"].params["order_direction"] == "desc"
    assert seen["headers"]["Api-Key"] == API_KEY
    assert seen["headers"]["User-Agent"] == "flow-controller/0.1.0"
    assert seen["headers"]["Accept"] == "application/json"
    assert len(results) == 1


def test_search_flattens_one_entry_per_file(monkeypatch):
    _stub(monkeypatch, lambda request: httpx.Response(200, json={"data": [_ITEM_TWO_FILES]}))

    results = opensubtitles_client.search_subtitles(API_KEY, "Mixer", "spa")

    assert results == [
        {
            "file_id": 42,
            "language": "es",
            "release": "Mixer.2024.1080p.WEB-DL",
            "title": "Mixer",
            "file_name": "Mixer.es.srt",
        },
        {
            "file_id": 43,
            "language": "es",
            "release": "Mixer.2024.1080p.WEB-DL",
            "title": "Mixer",
            "file_name": "Mixer.es.Forced.srt",
        },
    ]


def test_search_caps_the_flat_list_at_the_limit(monkeypatch):
    _stub(monkeypatch, lambda request: httpx.Response(
        200, json={"data": [_ITEM_TWO_FILES, _item(7)]}
    ))

    results = opensubtitles_client.search_subtitles(API_KEY, "Mixer", "spa", limit=2)

    assert [r["file_id"] for r in results] == [42, 43]


def test_search_without_data_is_empty(monkeypatch):
    _stub(monkeypatch, lambda request: httpx.Response(200, json={}))

    assert opensubtitles_client.search_subtitles(API_KEY, "Mixer", "spa") == []


def test_search_with_empty_data_list_is_empty(monkeypatch):
    _stub(monkeypatch, lambda request: httpx.Response(200, json={"data": []}))

    assert opensubtitles_client.search_subtitles(API_KEY, "Mixer", "spa") == []


def test_search_without_an_api_key_raises(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no debe llegar a la red sin clave")

    _stub(monkeypatch, handler)

    with pytest.raises(OpenSubtitlesError):
        opensubtitles_client.search_subtitles("", "Mixer", "spa")


def test_search_on_a_non_2xx_raises_without_leaking_the_key(monkeypatch):
    _stub(monkeypatch, lambda request: httpx.Response(401, json={"message": "unauthorized"}))

    with pytest.raises(OpenSubtitlesError) as excinfo:
        opensubtitles_client.search_subtitles("super-secret-key", "Mixer", "spa")

    assert "super-secret-key" not in str(excinfo.value)


def test_search_on_malformed_json_raises(monkeypatch):
    _stub(monkeypatch, lambda request: httpx.Response(200, text="<html>no json</html>"))

    with pytest.raises(OpenSubtitlesError):
        opensubtitles_client.search_subtitles(API_KEY, "Mixer", "spa")


# ── Descarga ────────────────────────────────────────────────────────────────


def test_download_posts_the_file_id_and_returns_the_srt_text(monkeypatch):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/api/v1/download"):
            seen["post_body"] = json.loads(request.content)
            seen["headers"] = request.headers
            return httpx.Response(200, json={"link": "https://dl.test/sub.gz"})
        seen["link"] = str(request.url)
        return httpx.Response(200, content=gzip.compress(SRT_TEXT.encode("utf-8")))

    _stub(monkeypatch, handler)

    assert opensubtitles_client.download_subtitle(API_KEY, 42) == SRT_TEXT
    assert seen["post_body"] == {"file_id": 42}
    assert seen["headers"]["Api-Key"] == API_KEY
    assert seen["headers"]["Content-Type"] == "application/json"
    assert seen["headers"]["User-Agent"] == "flow-controller/0.1.0"
    assert seen["link"] == "https://dl.test/sub.gz"


def test_download_keeps_the_api_key_off_the_download_link_host(monkeypatch):
    """El `link` es un CDN de terceros: la clave solo va a api.opensubtitles.com."""
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/api/v1/download"):
            return httpx.Response(200, json={"link": "https://dl.test/sub.gz"})
        seen["link_headers"] = request.headers
        return httpx.Response(200, content=gzip.compress(SRT_TEXT.encode("utf-8")))

    _stub(monkeypatch, handler)

    opensubtitles_client.download_subtitle(API_KEY, 42)

    assert "api-key" not in seen["link_headers"]


def test_download_without_a_link_raises(monkeypatch):
    _stub(monkeypatch, lambda request: httpx.Response(200, json={"remaining": 0}))

    with pytest.raises(OpenSubtitlesError):
        opensubtitles_client.download_subtitle(API_KEY, 42)


def test_download_on_a_non_2xx_raises(monkeypatch):
    _stub(monkeypatch, lambda request: httpx.Response(503, json={"message": "nope"}))

    with pytest.raises(OpenSubtitlesError):
        opensubtitles_client.download_subtitle(API_KEY, 42)


def test_download_on_malformed_json_raises(monkeypatch):
    _stub(monkeypatch, lambda request: httpx.Response(200, text="not json"))

    with pytest.raises(OpenSubtitlesError):
        opensubtitles_client.download_subtitle(API_KEY, 42)


def test_download_without_an_api_key_raises(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no debe llegar a la red sin clave")

    _stub(monkeypatch, handler)

    with pytest.raises(OpenSubtitlesError):
        opensubtitles_client.download_subtitle("", 42)


def test_download_of_a_body_that_is_not_gzip_raises(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/api/v1/download"):
            return httpx.Response(200, json={"link": "https://dl.test/sub.gz"})
        return httpx.Response(200, content=b"plain text, not gzip")

    _stub(monkeypatch, handler)

    with pytest.raises(OpenSubtitlesError):
        opensubtitles_client.download_subtitle(API_KEY, 42)


def test_download_replacing_invalid_utf8_keeps_the_rest(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/api/v1/download"):
            return httpx.Response(200, json={"link": "https://dl.test/sub.gz"})
        return httpx.Response(200, content=gzip.compress(b"caf\xe9\n"))

    _stub(monkeypatch, handler)

    assert opensubtitles_client.download_subtitle(API_KEY, 42) == "caf�\n"
