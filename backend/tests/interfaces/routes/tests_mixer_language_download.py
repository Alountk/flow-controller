"""POST /api/mixer/alternatives/language-download — one Prowlarr row straight to the client (S7/T4).

Every «Búsqueda en idioma» row offers «Descargar»: the row's `magnet_url` OR
`download_url` (exactly one non-null from T2's normalization) goes to the
`application.gateways.qbit_add_download` seam — the NATIVE qBittorrent client
(S4: login+SID, no aMuTorrent facade). A magnet or a direct .torrent link
needs no Torznab resolve, so the add is one fast POST and the endpoint
answers synchronously with `{ok, detail?}`.

The contract:

1. a magnet row is added BY its magnet — never resolved through a search;
2. a download-url row is added BY its url;
3. an empty / non-http(s) / non-magnet url is a 400 with a Spanish detail and
   NOTHING is sent to the client;
4. a client refusal surfaces `{ok: false, detail}` on the established 200
   (the calendar grab answers a refusal the same way) — the detail is the
   message PASSTHROUGH: the native client already names the destination in
   its own Spanish text (S2/S5), so «aMuTorrent» never appears here again;
5. the endpoint is behind the shared `verify_api_key` like every sibling.

The seam is mocked where the ROUTE reads it — the exact `tests_calendar_direct`
style — so no test here can reach a real qBittorrent.
"""
import os
from unittest.mock import AsyncMock, patch

os.environ.setdefault("FOLDER_OUTPUT_MIXED", "/tmp/mixed-test")

from fastapi.testclient import TestClient
from app import app
from tests._stubs import _StubSession

client = TestClient(app, raise_server_exceptions=False)

MAGNET = "magnet:?xt=urn:btih:abc123"
TORRENT_URL = "https://prowlarr.test:9696/getnzb/1"
TITLE = "Артур и минипуты (2006) BDRip"

#: Where the route reads its collaborators — patched there, never upstream.
ADD = "interfaces.http.routes_mixer.qbit_add_download"
SESSION = "interfaces.http.routes_mixer.http_session"

#: The native client's strings (S2: el detalle nombra el destino).
QBIT_URL = "http://qbit.test:8080"
_ACCEPTED_DETAIL = f"Descarga añadida en qBittorrent ({QBIT_URL}), categoría flow"
_ACCEPTED = {"ok": True, "detail": _ACCEPTED_DETAIL, "category": "flow"}
_REFUSED = {
    "ok": False,
    "detail": f"qBittorrent ({QBIT_URL}) no aceptó la descarga: HTTP 400: Fail.",
}


def _post(body):
    return client.post("/api/mixer/alternatives/language-download", json=body)


class TestAlternativesLanguageDownloadEndpoint:
    """(a)–(e) of the T4 contract, one test each."""

    @patch(SESSION)
    @patch(ADD, new_callable=AsyncMock, return_value=_ACCEPTED)
    def test_a_magnet_row_is_added_by_its_magnet(self, add, mock_session):
        stub = _StubSession({})
        mock_session.return_value = stub

        resp = _post({"url": MAGNET, "title": TITLE})

        assert resp.status_code == 200
        assert resp.json() == {"ok": True, "detail": _ACCEPTED_DETAIL}
        add.assert_awaited_once()
        assert add.await_args.args[0] is stub, "the seam takes the route's own session"
        assert add.await_args.args[1] == MAGNET, "a magnet is added as-is, no Torznab resolve"

    @patch(SESSION)
    @patch(ADD, new_callable=AsyncMock, return_value=_ACCEPTED)
    def test_a_download_url_row_is_added_by_its_url(self, add, mock_session):
        mock_session.return_value = _StubSession({})

        resp = _post({"url": TORRENT_URL, "title": TITLE})

        assert resp.status_code == 200
        assert resp.json() == {"ok": True, "detail": _ACCEPTED_DETAIL}
        add.assert_awaited_once()
        assert add.await_args.args[1] == TORRENT_URL, "the .torrent link is added as-is"

    @patch(SESSION)
    @patch(ADD, new_callable=AsyncMock)
    def test_an_empty_or_foreign_url_is_400_in_spanish(self, add, mock_session):
        mock_session.return_value = _StubSession({})

        for body, detail in (
            ({"title": TITLE}, "Falta la url de la descarga"),
            ({"url": "   ", "title": TITLE}, "Falta la url de la descarga"),
            (
                {"url": "ftp://prowlarr.test/file.torrent", "title": TITLE},
                "url no válida: se espera un magnet o una URL http(s)",
            ),
        ):
            resp = _post(body)
            assert resp.status_code == 400, body
            assert resp.json() == {"detail": detail}

        add.assert_not_awaited(), "a refused url never reaches the client"

    @patch(SESSION)
    @patch(ADD, new_callable=AsyncMock, return_value=_REFUSED)
    def test_a_client_refusal_surfaces_ok_false_with_the_detail(self, add, mock_session):
        mock_session.return_value = _StubSession({})

        resp = _post({"url": MAGNET, "title": TITLE})

        # The established {ok, detail} code: the calendar grab answers a
        # client refusal on 200 the same way — and the detail is the client's
        # own self-describing text (S2/S5): «aMuTorrent» no longer appears.
        assert resp.status_code == 200
        assert resp.json() == _REFUSED
        assert "aMuTorrent" not in resp.text

    @patch("infrastructure.settings_store.auth_required", return_value=True)
    @patch(SESSION)
    @patch(ADD, new_callable=AsyncMock)
    def test_the_endpoint_requires_the_api_key(self, add, mock_session, _auth):
        from interfaces.http import deps as deps_module

        mock_session.return_value = _StubSession({})
        with patch.object(deps_module, "credentials") as creds:
            creds.verify_api_key.return_value = False
            resp = _post({"url": MAGNET, "title": TITLE})

        assert resp.status_code == 401
        add.assert_not_awaited(), "an unauthenticated request never reaches the client"
