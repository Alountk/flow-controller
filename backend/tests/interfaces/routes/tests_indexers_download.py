"""`POST /api/indexers/download` — one-row download dispatch («indexadores-directos» T5, S5 + enmienda L6).

The free search's «Descargar» button has no arr service and no
movieId/episodeId, so `POST /api/calendar/grab` cannot serve it (L6). This
endpoint takes `{link?, guid?}`, dispatches by the SHAPE of the target,
persists nothing and queries nothing. What these pin down:

* at least one of `link`/`guid` is required — both missing or blank is the
  caller's 400, and a non-string value is the caller's 400 too. Every refusal
  the DISPATCHER can produce is instead a 200 `{"ok": false, "detail"}` (the
  honest-refusal shape of the rest of the repo), never a raw traceback;
* `ed2k://` goes to the direct EC seam `gateways.amule_add_ed2k` OFF the event
  loop (the adapter is sync — `grab_release._ec_add_link`) when
  `AMULE_EC_DIRECT` is unset or anything but `"0"`; with `"0"` the LEGACY
  aMuTorrent bridge takes the link instead (the exact rollback
  `grab_release._ec_direct` pins: the flag is read per call, never cached);
* a 32-hex aMule file hash (the `guid` of rows without a buildable link) goes
  to `gateways.amule_download_search_result` off the loop; with the flag at
  `"0"` it is an HONEST refusal naming the bridge's missing hash-id entry
  point — the legacy flow has no way to download by hash;
* `magnet:` and `http(s)` go to `gateways.qbit_add_download` — the NATIVE
  qBittorrent client (S4: login+SID, no aMuTorrent facade) — with the
  route's own `http_session()`; the answer is the client's own `{ok, detail}`
  PASSTHROUGH (S2 names the destination inside the client's messages, so the
  bridge never re-prefixes) and a successful detail reads «Descarga añadida
  en qBittorrent (URL), categoría flow»;
* with `AMULE_EC_DIRECT=0` the ed2k rollback keeps the LEGACY aMuTorrent
  bridge byte-identical (S7: aMule's domain, not qBittorrent's);
* an unconfigured aMule answers the shared `service_unavailable_reason` text
  VERBATIM (`RuntimeError` is the seam's fail-closed contract), an
  unconfigured qBittorrent answers its own S3 hint, and any
  `apikey=` riding in a link is REDACTED before the detail is answered (T3's
  risk-2 discipline: no secret ever reaches a response).

No real network (the gateways seams and the HTTP session are all stubbed).
"""

import asyncio
import os
from contextlib import asynccontextmanager, contextmanager
from unittest.mock import patch

import aiohttp
from fastapi.testclient import TestClient

import config
from app import app
from application import gateways
from interfaces.http.routes import indexers as indexers_routes

client = TestClient(app, raise_server_exceptions=False)

ED2K = "ed2k://|file|A.mkv|100|0123456789abcdef0123456789abcdef|/"
MAGNET = "magnet:?xt=urn:btih:abc123"
TORRENT_URL = "https://prowlarr.test:9696/getnzb/1"
SECRET_URL = "https://prowlarr.test:9696/getnzb/1?apikey=SEKRET-KEY-9876"
HASH32 = "0123456789abcdef0123456789abcdef"

#: The shared «no está configurado» reason the EC seam raises as `RuntimeError`.
AMULE_REASON = "amule no está configurado (faltan la URL o la API key)"

#: The pinned answers (S5's `{ok, detail}` style). The legacy string belongs to
#: the aMuTorrent bridge (ed2k rollback, S7); the native one names its
#: destination (S2) and is built on the qBittorrent URL this file configures.
EC_ADDED = {"ok": True, "detail": "Descarga añadida"}
BRIDGE_ADDED = {"ok": True, "detail": "Descarga añadida (categoría flow)"}
QBIT_URL = "http://qbit.test:8080"
QBIT_ADDED = {
    "ok": True,
    "detail": f"Descarga añadida en qBittorrent ({QBIT_URL}), categoría flow",
    "category": "flow",
}
QBIT_UNCONFIGURED = "qBittorrent no está configurado — añádelo en Configuración → Servicios"
HASH_REFUSED_FLAG0 = (
    "el puente aMuTorrent no tiene entrada para el hash de aMule: "
    "esta fila sólo puede descargarse con el EC directo (AMULE_EC_DIRECT)"
)
BAD_SCHEME = "link no válido: se espera ed2k://, magnet:, http(s) o un hash de aMule (32 hex)"


def _post(body):
    return client.post("/api/indexers/download", json=body)


def _ran_on_the_event_loop() -> bool:
    """The `tests_offloop` structural spy: `asyncio.get_running_loop()` is
    thread-local, so inside a `to_thread` worker it raises."""
    try:
        asyncio.get_running_loop()
        return True
    except RuntimeError:
        return False


# ── seams ────────────────────────────────────────────────────────────────────

_SESSION = object()


@asynccontextmanager
async def _fake_http_session(*args, **kwargs):
    yield _SESSION


class _Seams:
    """The dispatcher seams, recording every call and WHERE it ran.

    `bridge` is the LEGACY aMuTorrent bridge (ed2k rollback only, S7); `qbit`
    is the native client seam (S4). `on_loop` is `False` only when the seam
    really rode `asyncio.to_thread` — the sync EC adapter must never run on
    the event loop.
    """

    def __init__(self):
        self.add_calls = []
        self.hash_calls = []
        self.bridge_calls = []
        self.qbit_calls = []
        self.add_error = None
        self.hash_error = None
        self.bridge_error = None
        self.qbit_error = None
        self.bridge_answer = dict(BRIDGE_ADDED)
        self.qbit_answer = dict(QBIT_ADDED)

    def add(self, link):
        self.add_calls.append({"link": link, "on_loop": _ran_on_the_event_loop()})
        if self.add_error is not None:
            raise self.add_error

    def hash_add(self, file_hash):
        self.hash_calls.append({"hash": file_hash, "on_loop": _ran_on_the_event_loop()})
        if self.hash_error is not None:
            raise self.hash_error

    async def bridge(self, session, url):
        self.bridge_calls.append({"session": session, "url": url})
        if self.bridge_error is not None:
            raise self.bridge_error
        return dict(self.bridge_answer)

    async def qbit(self, session, url):
        self.qbit_calls.append({"session": session, "url": url})
        if self.qbit_error is not None:
            raise self.qbit_error
        return dict(self.qbit_answer)


@contextmanager
def _seams(**attrs):
    seams = _Seams()
    for key, value in attrs.items():
        setattr(seams, key, value)
    with (
        patch.object(gateways, "amule_add_ed2k", seams.add),
        patch.object(gateways, "amule_download_search_result", seams.hash_add),
        patch.object(gateways, "amutorrent_add_download", seams.bridge),
        patch.object(gateways, "qbit_add_download", seams.qbit),
        patch.object(indexers_routes, "http_session", _fake_http_session),
    ):
        yield seams


@contextmanager
def _flag(value):
    """`AMULE_EC_DIRECT = value` for the duration — `None` removes it."""
    with patch.dict("os.environ"):
        if value is None:
            os.environ.pop("AMULE_EC_DIRECT", None)
        else:
            os.environ["AMULE_EC_DIRECT"] = value
        yield


# ── the body contract ────────────────────────────────────────────────────────


class TestBodyContract:
    """The 400s are the caller's; nothing may reach a seam before them."""

    def test_without_link_and_guid_the_body_is_a_400(self):
        for body in ({}, {"link": "", "guid": "  "}, {"link": None, "guid": None}):
            with _seams() as seams:
                resp = _post(body)

            assert resp.status_code == 400, body
            assert resp.json() == {"detail": "hace falta un link o un guid"}
            assert seams.add_calls == seams.hash_calls == seams.bridge_calls == []

    def test_a_non_string_link_or_guid_is_a_400(self):
        for body in ({"link": 42}, {"guid": ["x"]}, {"link": {"a": 1}}, {"guid": 3.5}):
            with _seams() as seams:
                resp = _post(body)

            assert resp.status_code == 400, body
            assert resp.json() == {"detail": "link y guid deben ser texto"}
            assert seams.add_calls == seams.hash_calls == seams.bridge_calls == []

    def test_an_unsupported_scheme_is_an_honest_spanish_refusal(self):
        with _seams() as seams:
            resp = _post({"link": "ftp://prowlarr.test/file.torrent"})

        assert resp.status_code == 200
        assert resp.json() == {"ok": False, "detail": BAD_SCHEME}
        assert seams.add_calls == seams.hash_calls == seams.bridge_calls == []


# ── dispatch 1: ed2k — the flag differential ─────────────────────────────────


class TestEd2kDispatch:
    def test_ed2k_defaults_to_the_ec_seam_off_the_event_loop(self):
        with _flag(None), _seams() as seams:
            resp = _post({"link": ED2K})

        assert resp.status_code == 200
        assert resp.json() == EC_ADDED
        assert [call["link"] for call in seams.add_calls] == [ED2K]
        assert seams.add_calls[0]["on_loop"] is False, (
            "the sync EC adapter ran ON the event loop"
        )
        assert seams.hash_calls == [] and seams.bridge_calls == []

    def test_ed2k_with_the_flag_at_zero_goes_to_the_amutorrent_bridge(self):
        with _flag("0"), _seams() as seams:
            resp = _post({"link": ED2K})

        assert resp.status_code == 200
        assert resp.json() == BRIDGE_ADDED
        assert [call["url"] for call in seams.bridge_calls] == [ED2K]
        assert seams.bridge_calls[0]["session"] is _SESSION, (
            "the bridge takes the route's own session"
        )
        assert seams.add_calls == [], (
            "the rollback flag must SWITCH the transport, not add to it"
        )

    def test_the_flag_is_read_per_call_and_never_frozen(self):
        """The mandated rollback must take effect on the next request without
        a restart (`grab_release._ec_direct`)."""
        with _seams() as seams:
            with _flag("0"):
                first = _post({"link": ED2K})
            with _flag(None):
                second = _post({"link": ED2K})

        assert first.json() == BRIDGE_ADDED
        assert second.json() == EC_ADDED
        assert [call["url"] for call in seams.bridge_calls] == [ED2K]
        assert [call["link"] for call in seams.add_calls] == [ED2K]

    def test_an_ed2k_guid_without_a_link_dispatches_the_same(self):
        with _flag(None), _seams() as seams:
            resp = _post({"guid": ED2K})

        assert resp.status_code == 200
        assert resp.json() == EC_ADDED
        assert [call["link"] for call in seams.add_calls] == [ED2K]


# ── dispatch 2: the 32-hex aMule hash-id ─────────────────────────────────────


class TestHashDispatch:
    def test_a_32_hex_guid_goes_to_amule_download_search_result_off_the_loop(self):
        with _flag(None), _seams() as seams:
            resp = _post({"guid": HASH32})

        assert resp.status_code == 200
        assert resp.json() == EC_ADDED
        assert [call["hash"] for call in seams.hash_calls] == [HASH32]
        assert seams.hash_calls[0]["on_loop"] is False, (
            "the sync EC adapter ran ON the event loop"
        )
        assert seams.add_calls == [] and seams.bridge_calls == []

    def test_a_hash_guid_with_the_flag_at_zero_refuses_naming_the_bridge_gap(self):
        with _flag("0"), _seams() as seams:
            resp = _post({"guid": HASH32})

        assert resp.status_code == 200
        assert resp.json() == {"ok": False, "detail": HASH_REFUSED_FLAG0}
        assert seams.hash_calls == seams.add_calls == seams.bridge_calls == [], (
            "a refused hash never reaches any client"
        )

    def test_the_hash_shape_is_recognised_by_its_value(self):
        """A 32-hex target is the hash-id shape wherever it arrived from."""
        with _flag(None), _seams() as seams:
            resp = _post({"link": HASH32, "guid": "row-12"})

        assert resp.status_code == 200
        assert [call["hash"] for call in seams.hash_calls] == [HASH32]
        assert seams.add_calls == [] and seams.bridge_calls == []

    def test_the_link_wins_over_the_guid_when_both_are_present(self):
        with _flag(None), _seams() as seams:
            resp = _post({"link": MAGNET, "guid": HASH32})

        assert resp.status_code == 200
        assert [call["url"] for call in seams.qbit_calls] == [MAGNET]
        assert seams.hash_calls == [] and seams.add_calls == [] and seams.bridge_calls == []


# ── dispatch 3: magnet / http(s) → the bridge ────────────────────────────────


class TestBridgeLinks:
    def test_a_magnet_is_added_by_the_native_qbit_client(self):
        # S6: magnet/http → nativo qbit (S4/S5); el detalle nombra el destino (S2).
        with _seams() as seams:
            resp = _post({"link": MAGNET})

        assert resp.status_code == 200
        assert resp.json() == {"ok": True, "detail": QBIT_ADDED["detail"]}
        assert [call["url"] for call in seams.qbit_calls] == [MAGNET]
        assert seams.qbit_calls[0]["session"] is _SESSION, (
            "the bridge takes the route's own session"
        )
        assert seams.add_calls == [] and seams.hash_calls == [] and seams.bridge_calls == []

    def test_an_http_link_is_added_the_same(self):
        with _seams() as seams:
            resp = _post({"link": TORRENT_URL})

        assert resp.status_code == 200
        assert resp.json() == {"ok": True, "detail": QBIT_ADDED["detail"]}
        assert [call["url"] for call in seams.qbit_calls] == [TORRENT_URL]


# ── honest refusals (200 + ok:false) ─────────────────────────────────────────


class TestRefusals:
    def test_an_unconfigured_amule_answers_the_shared_reason_verbatim(self):
        with _seams(add_error=RuntimeError(AMULE_REASON)):
            resp = _post({"link": ED2K})

        assert resp.status_code == 200
        assert resp.json() == {"ok": False, "detail": AMULE_REASON}

    def test_a_qbit_refusal_travels_with_its_own_self_describing_detail(self):
        # S5/S6: passthrough SIN prefijo «aMuTorrent» — el cliente nativo ya
        # nombra el destino en su propio mensaje (S2).
        refused = {
            "ok": False,
            "detail": f"qBittorrent ({QBIT_URL}) no aceptó la descarga: HTTP 400: Fail.",
        }
        with _seams(qbit_answer=refused):
            resp = _post({"link": MAGNET})

        assert resp.status_code == 200
        assert resp.json() == refused
        assert "aMuTorrent" not in resp.text

    def test_a_transport_error_on_the_ec_seam_keeps_the_short_shape(self):
        with _seams(add_error=OSError("EC caído")):
            resp = _post({"link": ED2K})

        assert resp.status_code == 200
        assert resp.json() == {"ok": False, "detail": "OSError: EC caído"}

    def test_a_failing_qbit_seam_is_a_refusal_not_a_traceback(self):
        with _seams(qbit_error=aiohttp.ClientError("connection refused")):
            resp = _post({"link": MAGNET})

        assert resp.status_code == 200
        assert resp.json() == {"ok": False, "detail": "ClientError: connection refused"}

    def test_an_unconfigured_qbit_answers_the_configuration_hint(self, monkeypatch):
        # S3: sin url/user/password el cliente nativo responde su pista y NO
        # inventa un éxito — aquí el seam real corre entero (sin parchear).
        monkeypatch.setattr(config, "QBIT_URL", "")
        monkeypatch.setattr(config, "QBIT_USER", "")
        monkeypatch.setattr(config, "QBIT_PASSWORD", "")

        with patch.object(indexers_routes, "http_session", _fake_http_session):
            resp = _post({"link": MAGNET})

        assert resp.status_code == 200
        assert resp.json() == {"ok": False, "detail": QBIT_UNCONFIGURED}


# ── risk-2 discipline: no secret in a response, ever ─────────────────────────


class TestSecretDiscipline:
    def test_an_apikey_in_the_link_never_reaches_the_response(self):
        with _seams(qbit_error=aiohttp.ClientError(f"cannot fetch {SECRET_URL}")):
            resp = _post({"link": SECRET_URL})

        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is False
        assert "SEKRET-KEY-9876" not in resp.text, "an api_key leaked into the response"
        assert "apikey=****" in body["detail"], (
            "the apikey= value must be masked, not merely hidden in this case"
        )


class TestAuth:
    def test_the_endpoint_requires_the_api_key(self):
        from interfaces.http import deps as deps_module

        with (
            patch("infrastructure.settings_store.auth_required", return_value=True),
            patch.object(deps_module, "credentials") as creds,
            _seams() as seams,
        ):
            creds.verify_api_key.return_value = False
            resp = _post({"link": MAGNET})

        assert resp.status_code == 401
        assert seams.bridge_calls == [], (
            "an unauthenticated request never reaches the client"
        )
