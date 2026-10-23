"""`/api/indexers` CRUD + the `t=caps` test endpoint («indexadores-directos» T3/S3).

What these pin down:

* every endpoint is behind `verify_api_key` (401 without the header);
* the round-trip runs against the REAL store on a private tmp database;
* GET (and every other response) shows the api_key MASKED — never the raw
  value, never in logs, never inside an error detail;
* an EMPTY (or masked) `api_key` in a PUT body keeps the stored one — the
  historic bug was saving the mask back over the real credential;
* `POST /{id}/test` calls `torznab_caps` with the row's url+key, persists
  NOTHING, answers 200 with `{"ok": true, "caps"}` or `{"ok": false,
  "detail"}` and maps `aiohttp.ClientError`/timeout to the failure shape
  with the exception's short text — never a raw traceback, never a key;

No real network (the Torznab client is stubbed at the composition seam) and
no real keys: `FAKE_KEY` is obviously fake and the tests assert it NEVER
leaks — no test asserts a raw key inside any HTTP response.
"""

import asyncio
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import aiohttp
import pytest
from fastapi.testclient import TestClient

from app import app
from infrastructure import sqlite_history as history
from interfaces.http.routes import indexers as indexers_routes

client = TestClient(app, raise_server_exceptions=False)

FAKE_KEY = "FAKE-KEY-do-not-use-9876"
MASKED = "****9876"
URL = "http://indexer.test/torznab/api"

#: Honest fake caps — the shape `torznab_caps` really answers (S1/T2).
CAPS = {
    "searches": {"search": {"available": True, "supported_params": ["q"]}},
    "categories": [{"id": 2000, "name": "Movies"}],
}


@pytest.fixture
def store(tmp_path):
    """A fresh history database, isolated from the real config volume."""
    history.close()
    history.init_db(tmp_path / "history.db")
    yield history
    history.close()


def _create(name="NoNaMe", url=URL, api_key=FAKE_KEY, **extra):
    body = {"name": name, "url": url, "api_key": api_key}
    body.update(extra)
    return client.post("/api/indexers", json=body)


# ── the key contract ─────────────────────────────────────────────────────────

_CALLS = [
    ("get", "/api/indexers"),
    ("post", "/api/indexers"),
    ("put", "/api/indexers/1"),
    ("delete", "/api/indexers/1"),
    ("post", "/api/indexers/1/test"),
]


@pytest.mark.parametrize("method,path", _CALLS)
def test_every_endpoint_requires_the_api_key(store, method, path):
    with patch("infrastructure.settings_store.auth_required", return_value=True):
        kwargs = {"json": {}} if method in ("post", "put") else {}
        resp = getattr(client, method)(path, **kwargs)

    assert resp.status_code == 401, f"{method.upper()} {path} answered {resp.status_code}"


# ── CRUD round-trip ──────────────────────────────────────────────────────────


def test_post_creates_and_gets_back_a_masked_row(store):
    resp = _create(categories="2000,100000", enabled=False)

    assert resp.status_code == 200, resp.text
    assert resp.json()["ok"] is True
    assert resp.json()["indexer"]["api_key"] == MASKED

    body = client.get("/api/indexers").json()
    assert len(body["indexers"]) == 1
    row = body["indexers"][0]
    assert row["name"] == "NoNaMe"
    assert row["url"] == URL
    assert row["categories"] == "2000,100000"
    assert row["enabled"] == 0
    assert row["api_key"] == MASKED


def test_no_response_of_the_round_trip_ever_carries_the_raw_key(store):
    _create()
    put = client.put(f"/api/indexers/{client.get('/api/indexers').json()['indexers'][0]['id']}",
                     json={"name": "Renombrado", "api_key": ""})
    listing = client.get("/api/indexers")

    for resp in (put, listing):
        assert FAKE_KEY not in resp.text


def test_put_with_an_empty_key_keeps_the_stored_one(store):
    _create()
    row_id = client.get("/api/indexers").json()["indexers"][0]["id"]

    resp = client.put(f"/api/indexers/{row_id}", json={"name": "Renombrado", "api_key": ""})

    assert resp.status_code == 200, resp.text
    assert resp.json()["indexer"]["api_key"] == MASKED
    assert history.indexers_raw(indexer_id=row_id)[0]["api_key"] == FAKE_KEY
    assert client.get("/api/indexers").json()["indexers"][0]["name"] == "Renombrado"


def test_put_with_the_masked_form_also_keeps_the_stored_one(store):
    """The historic bug: saving the mask back destroyed the real credential."""
    _create()
    row_id = client.get("/api/indexers").json()["indexers"][0]["id"]

    resp = client.put(f"/api/indexers/{row_id}", json={"api_key": MASKED})

    assert resp.status_code == 200
    assert history.indexers_raw(indexer_id=row_id)[0]["api_key"] == FAKE_KEY


def test_put_with_a_new_key_replaces_it(store):
    _create()
    row_id = client.get("/api/indexers").json()["indexers"][0]["id"]

    client.put(f"/api/indexers/{row_id}", json={"api_key": "NEW-FAKE-KEY-1234"})

    assert history.indexers_raw(indexer_id=row_id)[0]["api_key"] == "NEW-FAKE-KEY-1234"
    assert client.get("/api/indexers").json()["indexers"][0]["api_key"] == "****1234"


def test_put_can_toggle_enabled(store):
    _create()
    row_id = client.get("/api/indexers").json()["indexers"][0]["id"]

    client.put(f"/api/indexers/{row_id}", json={"enabled": False})
    assert client.get("/api/indexers").json()["indexers"][0]["enabled"] == 0

    client.put(f"/api/indexers/{row_id}", json={"enabled": True})
    assert client.get("/api/indexers").json()["indexers"][0]["enabled"] == 1


def test_delete_removes_the_row_and_then_404s(store):
    _create()
    row_id = client.get("/api/indexers").json()["indexers"][0]["id"]

    resp = client.delete(f"/api/indexers/{row_id}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["ok"] is True
    assert client.get("/api/indexers").json()["indexers"] == []

    assert client.delete(f"/api/indexers/{row_id}").status_code == 404
    assert client.put(f"/api/indexers/{row_id}", json={"name": "X"}).status_code == 404


# ── validation and duplicates ────────────────────────────────────────────────


def test_create_validates_name_and_url(store):
    assert _create(name="").status_code == 422
    assert _create(url="").status_code == 422
    resp = _create(url="ftp://indexer.test/api")
    assert resp.status_code == 422
    assert "http" in resp.json()["detail"]


def test_create_refuses_a_masked_key_instead_of_storing_the_mask(store):
    resp = _create(api_key=MASKED)

    assert resp.status_code == 422
    assert history.indexers_list() == [], "the mask must never become a credential"


def test_duplicate_name_or_url_is_a_409_naming_the_field(store):
    _create(name="NoNaMe", url="http://a.test/api")

    # Exact-stripped duplicates (documented policy): only the identical name
    # collides — "noname" is a different row, and gets one.
    by_name = _create(name="noname", url="http://b.test/api", api_key="")
    assert by_name.status_code == 200
    dup_name = _create(name="NoNaMe", url="http://c.test/api", api_key="")
    assert dup_name.status_code == 409
    assert "nombre" in dup_name.json()["detail"]

    dup_url = _create(name="Otra", url="http://a.test/api", api_key="")
    assert dup_url.status_code == 409
    assert "URL" in dup_url.json()["detail"]

    row_id = client.get("/api/indexers").json()["indexers"][0]["id"]
    renamed = client.put(f"/api/indexers/{row_id}", json={"name": "Otra", "url": "http://b.test/api"})
    assert renamed.status_code == 409


# ── POST /api/indexers/{id}/test — t=caps probe ──────────────────────────────


@contextmanager
def _stub(caps=None, error=None):
    """The composition seam `app.py` hands the adapter to, stubbed — never a
    real network call."""
    probe = AsyncMock(return_value=CAPS if caps is None else caps)
    if error is not None:
        probe.side_effect = error
    with patch.object(indexers_routes, "torznab", SimpleNamespace(torznab_caps=probe)):
        yield probe


def test_test_endpoint_answers_ok_with_the_caps_and_persists_nothing(store):
    _create()
    before = client.get("/api/indexers").json()["indexers"][0]

    with _stub() as probe:
        resp = client.post(f"/api/indexers/{before['id']}/test")

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True, "caps": CAPS}
    # The probe gets the RAW key — that is the call path — but only the stub
    # sees it; no response and no stored row may carry it.
    assert probe.await_args.args == (URL, FAKE_KEY)

    after = client.get("/api/indexers").json()["indexers"][0]
    assert after == before, "testing must persist NOTHING"


def test_test_endpoint_maps_client_errors_to_ok_false_without_leaking(store):
    _create()
    row_id = client.get("/api/indexers").json()["indexers"][0]["id"]
    boom = aiohttp.ClientError(f"HTTP 500: rechazada apikey={FAKE_KEY} ({FAKE_KEY})")

    with _stub(error=boom):
        resp = client.post(f"/api/indexers/{row_id}/test")

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert "HTTP 500" in body["detail"], "the exception's short text, honestly"
    assert FAKE_KEY not in resp.text
    assert "Traceback" not in resp.text


def test_test_endpoint_maps_timeouts_to_ok_false(store):
    _create()
    row_id = client.get("/api/indexers").json()["indexers"][0]["id"]

    with _stub(error=asyncio.TimeoutError()):
        resp = client.post(f"/api/indexers/{row_id}/test")

    assert resp.status_code == 200
    assert resp.json()["ok"] is False
    assert resp.json()["detail"]


def test_test_endpoint_on_a_missing_row_is_ok_false(store):
    with _stub() as probe:
        resp = client.post("/api/indexers/999/test")

    assert resp.status_code == 200
    assert resp.json()["ok"] is False
    probe.assert_not_awaited()


def test_test_endpoint_refuses_an_undecryptable_key_before_calling(store, monkeypatch):
    monkeypatch.setenv("FC_SECRET", "first-secret")
    _create()
    row_id = client.get("/api/indexers").json()["indexers"][0]["id"]
    monkeypatch.setenv("FC_SECRET", "second-secret")

    with _stub() as probe:
        resp = client.post(f"/api/indexers/{row_id}/test")

    assert resp.status_code == 200
    assert resp.json()["ok"] is False
    assert "descifrar" in resp.json()["detail"]
    probe.assert_not_awaited()
    assert FAKE_KEY not in resp.text


# ── the store-down contract ──────────────────────────────────────────────────


def test_get_is_an_honest_empty_list_with_a_reason_when_the_store_is_down(store):
    history.close()

    resp = client.get("/api/indexers")

    assert resp.status_code == 200
    body = resp.json()
    assert body["indexers"] == []
    assert body.get("error")


def test_writes_report_an_unavailable_store_without_lying(store):
    history.close()

    assert _create().status_code == 503
    assert client.put("/api/indexers/1", json={"name": "X"}).status_code == 503
    assert client.delete("/api/indexers/1").status_code == 503
    down = client.post("/api/indexers/1/test")
    assert down.status_code == 200 and down.json()["ok"] is False


# ── the risk-2 pin: a full pass with every channel watched ───────────────────


def test_the_raw_key_never_appears_in_responses_or_logs(store, caplog):
    """Create, list, update, a failing test and a successful one — the fake
    key may live in the request bodies and inside the probe stub, nowhere
    else."""
    import logging

    caplog.set_level(logging.DEBUG)
    created = _create()
    row_id = created.json()["indexer"]["id"]
    ok = client.get("/api/indexers")
    updated = client.put(f"/api/indexers/{row_id}", json={"api_key": ""})
    with _stub(error=aiohttp.ClientError(f"boom {FAKE_KEY}")):
        failed = client.post(f"/api/indexers/{row_id}/test")
    with _stub():
        tested = client.post(f"/api/indexers/{row_id}/test")

    for resp in (created, ok, updated, failed, tested):
        assert FAKE_KEY not in resp.text, f"leak in response: {resp.text[:200]}"
    assert FAKE_KEY not in caplog.text, "leak in the application log"
