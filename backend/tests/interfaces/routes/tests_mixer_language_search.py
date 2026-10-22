"""POST /api/mixer/alternatives/language-search — Prowlarr search in a chosen language (S6/T2).

The «Buscar y descargar alternativa» modal searches Prowlarr with THE TERM THE
USER WROTE — a Russian title for a Russian release, which Radarr never finds
(feature doc S2/S3). The contract:

1. happy path → `{releases: [...]}` normalized snake_case (`title`, `indexer`,
   `size`, `seeders`, `guid`, and `magnet_url`/`download_url` ONLY when
   non-null);
2. the relevance filter runs BEFORE the response — year-only junk never
   reaches the UI;
3. no Prowlarr configured → the established not-configured error shape
   (`service_unavailable_reason`, HTTP 502 like the alternatives-lookup
   precedent) and the search is never attempted;
4. empty/whitespace query → 400 like the other request models.

The whole stack runs for real except the HTTP transport (a `_StubSession`
reached through `routes_mixer.http_session`) and the service lookups, so the
shape asserted here is the shape production serves. Nothing here touches the
network.
"""
import os
from unittest.mock import patch

os.environ.setdefault("FOLDER_OUTPUT_MIXED", "/tmp/mixed-test")

from fastapi.testclient import TestClient
from app import app
from tests._stubs import _StubSession

client = TestClient(app, raise_server_exceptions=False)

_PROWLARR_SERVICE = {
    "key": "prowlarr",
    "kind": "prowlarr",
    "url": "http://prowlarr.test:9696",
    "api_key": "test-key",
}

_JUNK_YEAR_ONLY = {
    "title": "[rutor] Случайный.Фильм.2006.HDTVRip",
    "indexer": "dmhy",
    "size": 700_000_000,
    "seeders": 3,
    "guid": "junk-1",
}
_JUNK_YEAR_ONLY_2 = {
    "title": "[KinoZal] Ещё.Один.2006.BDRip",
    "indexer": "dmhy",
    "size": 1_400_000_000,
    "seeders": 1,
    "guid": "junk-2",
}
_REAL = {
    "title": "Артур и минипуты (2006) BDRip",
    "indexer": "NoNaMe Club",
    "size": 2_000_000_000,
    "seeders": 42,
    "guid": "real-1",
    "magnetUrl": "magnet:?xt=urn:btih:abc123",
}


def _stub(payload):
    return _StubSession({"/api/v1/search": (200, payload)})


class TestAlternativesLanguageSearchEndpoint:
    """(a)–(d) of the T2 contract, one test each."""

    def test_missing_query_is_400(self):
        resp = client.post("/api/mixer/alternatives/language-search", json={})
        assert resp.status_code == 400
        assert resp.json() == {"detail": "query is required"}

    def test_blank_query_is_400(self):
        resp = client.post(
            "/api/mixer/alternatives/language-search", json={"query": "   "}
        )
        assert resp.status_code == 400
        assert resp.json() == {"detail": "query is required"}

    @patch("interfaces.http.routes_mixer.http_session")
    @patch("interfaces.http.routes_mixer.find_service", return_value=None)
    def test_unconfigured_prowlarr_is_the_not_configured_error(self, _find, mock_session):
        """(c) the established shape: `service_unavailable_reason`, HTTP 502 —
        exactly like `alternatives/lookup` answers an unconfigured radarr."""
        stub = _stub([])
        mock_session.return_value = stub

        resp = client.post(
            "/api/mixer/alternatives/language-search", json={"query": "Артур"}
        )

        assert resp.status_code == 502
        assert resp.json() == {
            "detail": "prowlarr no está configurado (faltan la URL o la API key)"
        }
        assert stub.calls == [], "sin servicio configurado jamás se sale a la red"

    @patch("config.find_service", return_value=_PROWLARR_SERVICE)
    @patch("interfaces.http.routes_mixer.find_service", return_value=_PROWLARR_SERVICE)
    @patch("interfaces.http.routes_mixer.http_session")
    def test_the_happy_path_returns_normalized_releases(
        self, mock_session, _route_find, _config_find
    ):
        """(a) `{releases: [...]}` snake_case; download urls only when non-null."""
        both_urls = dict(
            _REAL,
            downloadUrl="http://prowlarr.test:9696/getnzb/1",
        )
        mock_session.return_value = _stub([both_urls, _REAL])

        resp = client.post(
            "/api/mixer/alternatives/language-search",
            json={"query": "Артур и минимоны", "language": "ru", "movieId": 550},
        )

        assert resp.status_code == 200
        body = resp.json()
        assert set(body) == {"releases"}
        assert body["releases"] == [
            {
                "title": "Артур и минипуты (2006) BDRip",
                "indexer": "NoNaMe Club",
                "size": 2_000_000_000,
                "seeders": 42,
                "guid": "real-1",
                "magnet_url": "magnet:?xt=urn:btih:abc123",
                "download_url": "http://prowlarr.test:9696/getnzb/1",
            },
            {
                "title": "Артур и минипуты (2006) BDRip",
                "indexer": "NoNaMe Club",
                "size": 2_000_000_000,
                "seeders": 42,
                "guid": "real-1",
                "magnet_url": "magnet:?xt=urn:btih:abc123",
            },
        ]

    @patch("config.find_service", return_value=_PROWLARR_SERVICE)
    @patch("interfaces.http.routes_mixer.find_service", return_value=_PROWLARR_SERVICE)
    @patch("interfaces.http.routes_mixer.http_session")
    def test_year_only_junk_never_reaches_the_response(
        self, mock_session, _route_find, _config_find
    ):
        """(b) the filter drops dmhy's year-only matches before the answer."""
        mock_session.return_value = _stub([_JUNK_YEAR_ONLY, _REAL, _JUNK_YEAR_ONLY_2])

        resp = client.post(
            "/api/mixer/alternatives/language-search", json={"query": "Артур и минимоны"}
        )

        assert resp.status_code == 200
        assert [r["guid"] for r in resp.json()["releases"]] == ["real-1"]

    @patch("config.find_service", return_value=_PROWLARR_SERVICE)
    @patch("interfaces.http.routes_mixer.find_service", return_value=_PROWLARR_SERVICE)
    @patch("interfaces.http.routes_mixer.http_session")
    def test_a_prowlarr_failure_is_502(self, mock_session, _route_find, _config_find):
        import aiohttp

        stub = _StubSession({})
        stub.routes["/api/v1/search"] = (200, aiohttp.ClientError("connection refused"))
        mock_session.return_value = stub

        resp = client.post(
            "/api/mixer/alternatives/language-search", json={"query": "Артур"}
        )

        assert resp.status_code == 502
        assert resp.json() == {"detail": "Prowlarr search failed: connection refused"}

    @patch("config.find_service", return_value=_PROWLARR_SERVICE)
    @patch("interfaces.http.routes_mixer.find_service", return_value=_PROWLARR_SERVICE)
    @patch("interfaces.http.routes_mixer.http_session")
    def test_movie_id_accepts_both_the_spec_and_the_repo_spellings(
        self, mock_session, _route_find, _config_find
    ):
        """T2 says «(query, language, movieId)»; the repo's request models say
        `movie_id`. Both must land so T3/T4 can send either."""
        mock_session.return_value = _stub([])

        for payload in (
            {"query": "Arthur", "movieId": 550},
            {"query": "Arthur", "movie_id": 550},
        ):
            resp = client.post(
                "/api/mixer/alternatives/language-search", json=payload
            )
            assert resp.status_code == 200, payload
            assert resp.json() == {"releases": []}
