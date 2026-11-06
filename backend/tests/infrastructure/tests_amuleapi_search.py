"""El seam `amuleapi_search` (T4b/S2): resultados REST → la fila amule del fan-out.

El contrato observable del fan-out no cambia: una fila de la REST debe ser
IGUAL a la fila EC de `_amule_row` (`routes/indexers.py`) — `sources` sigue
siendo un recuento de fuentes ED2K (el `sources.total` de REFERENCE.md) y
NUNCA se aliasa a `seeders`. El seam lee `config.AMULEAPI_URL` /
`config.AMULEAPI_PASSWORD` en cada llamada (la regla restart-free: `config.X`
al llamar, nunca al importar) y presupuesta la búsqueda ED2K en
`config.REQUEST_TIMEOUT * 12` (el precedente medido de ~30 s).
"""

import asyncio

import config
from infrastructure import amuleapi_client, arr_client
from tests._stubs import _StubSession

BASE = "http://amuleapi.test:4713"
PASSWORD = "AMULEAPI-PASS-SECRETO-9999"
TOKEN = "AMULEAPI-TOKEN-SECRETO-8888"

HASH32 = "8b54a3c2d4e5f60718293a4b5c6d7e8f"
NAME = "example-distribution-26.04-amd64.iso"

#: La forma REST de REFERENCE.md, tal como `search()` la devuelve (más
#: `ed2k_link`, que el mapper ignora: compone el enlace como `_amule_row`).
REST_ROW = {
    "hash": HASH32,
    "name": NAME,
    "size_bytes": 3825205248,
    "sources": {"total": 217, "complete": 142},
    "already_downloaded": False,
    "rating": 0,
    "status": "new",
    "file_type": "video",
    "directory": "",
    "media": None,
    "alternate_names": [],
    "kad_comment_lookup_running": False,
    "comments": [],
}
LINK = f"ed2k://|file|{NAME}|3825205248|{HASH32}|/"

FINISHED = {
    "results": [REST_ROW],
    "search_id": 42,
    "progress": {"state": "finished", "type": "global", "kad_active": False, "percent": 100},
}


class _RestSession(_StubSession):
    """`_StubResponse` no lleva `.headers` y el cliente JWT los lee."""

    def _resolve(self, url):
        resp = super()._resolve(url)
        resp.headers = {}
        return resp


def _session() -> _RestSession:
    """Login + arranque + resultados en un solo sondeo (state=finished).

    El orden de los fragmentos manda en `_StubSession`: la página de
    resultados contiene también «/api/v1/search», así que va primero.
    """
    return _RestSession({
        "auth/login": (200, {"token": TOKEN}),
        "/results?limit=": (200, FINISHED),
        "/api/v1/search": (202, {"search_id": 42}),
    })


def _run(coroutine):
    return asyncio.run(coroutine)


# ── el mapper REST → la forma exacta de `_amule_row` ──────────────────────────


def test_a_rest_row_maps_to_the_exact_amule_row_shape():
    row = arr_client._amuleapi_result_row({**REST_ROW, "ed2k_link": LINK})

    assert row == {
        "source": "amule",
        "name": NAME,
        "size": 3825205248,
        "sources": 217,
        "guid": HASH32,
        "link": LINK,
    }


def test_the_source_count_is_the_total_of_ed2k_sources_never_seeders():
    """La regla de honestidad de `_amule_row`: `sources` es un recuento de
    fuentes ED2K — ni «complete», ni seeders (magnitudes distintas)."""
    row = arr_client._amuleapi_result_row(REST_ROW)

    assert row["sources"] == 217
    assert "seeders" not in row


def test_missing_fields_are_omitted_not_invented():
    row = arr_client._amuleapi_result_row({})

    assert row == {"source": "amule", "name": "", "size": None}
    assert "sources" not in row
    assert "guid" not in row
    assert "link" not in row


def test_a_sources_object_without_total_reports_no_count():
    row = arr_client._amuleapi_result_row({"sources": {"complete": 3}})

    assert "sources" not in row


def test_the_ed2k_link_needs_name_size_and_hash_like_the_ec_mapper():
    without_name = arr_client._amuleapi_result_row(
        {"name": "", "size_bytes": 5, "hash": HASH32}
    )
    zero_size = arr_client._amuleapi_result_row(
        {"name": "X", "size_bytes": 0, "hash": HASH32}
    )

    assert without_name["guid"] == HASH32
    assert "link" not in without_name
    assert zero_size["link"] == f"ed2k://|file|X|0|{HASH32}|/"


# ── el seam: config en cada llamada y presupuesto ×12 ────────────────────────


def test_the_seam_reads_config_at_call_time_and_budgets_the_x12(monkeypatch):
    seen = []

    async def fake_search(client, session, query, *, deadline_seconds, **kwargs):
        seen.append((client.base_url, client.password, query, deadline_seconds))
        return {"search_id": 42, "results": [REST_ROW]}

    monkeypatch.setattr(amuleapi_client, "search", fake_search)
    monkeypatch.setattr(config, "AMULEAPI_URL", BASE)
    monkeypatch.setattr(config, "AMULEAPI_PASSWORD", PASSWORD)

    rows = _run(arr_client.amuleapi_search(object(), "ubuntu desktop iso"))

    assert seen == [(BASE, PASSWORD, "ubuntu desktop iso", config.REQUEST_TIMEOUT * 12)]
    assert rows == [arr_client._amuleapi_result_row(REST_ROW)]


def test_a_saved_config_change_reaches_the_next_call_without_a_restart(monkeypatch):
    seen = []

    async def fake_search(client, session, query, *, deadline_seconds, **kwargs):
        seen.append((client.base_url, client.password))
        return {"search_id": 42, "results": []}

    monkeypatch.setattr(amuleapi_client, "search", fake_search)
    monkeypatch.setattr(config, "AMULEAPI_URL", BASE)
    monkeypatch.setattr(config, "AMULEAPI_PASSWORD", PASSWORD)
    _run(arr_client.amuleapi_search(object(), "q"))
    monkeypatch.setattr(config, "AMULEAPI_URL", "http://amuleapi2.test:4713")
    monkeypatch.setattr(config, "AMULEAPI_PASSWORD", "OTRA-CONTRASEÑA")
    _run(arr_client.amuleapi_search(object(), "q"))

    assert seen == [
        (BASE, PASSWORD),
        ("http://amuleapi2.test:4713", "OTRA-CONTRASEÑA"),
    ], "config.X al llamar: lo guardado en settings llega al siguiente request"


# ── la cadena completa contra la REST fingida ────────────────────────────────


def test_the_full_chain_answers_the_fan_out_rows(monkeypatch):
    monkeypatch.setattr(config, "AMULEAPI_URL", BASE)
    monkeypatch.setattr(config, "AMULEAPI_PASSWORD", PASSWORD)
    session = _session()

    rows = _run(arr_client.amuleapi_search(session, "ubuntu desktop iso"))

    assert rows == [{
        "source": "amule",
        "name": NAME,
        "size": 3825205248,
        "sources": 217,
        "guid": HASH32,
        "link": LINK,
    }]
    urls = [url for url, _ in session.calls]
    assert any("auth/login" in url for url in urls)
    assert all(":4000" not in url for url in urls), "jamás por aMuTorrent (S2)"
