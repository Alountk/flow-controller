"""C-02: the blocked column can be acted on, not just read.

``reintentar`` already rides the ACTION machinery (``POST /api/actions/
retry_import``, covered in ``tests_interfaces/tests.py``). This file covers
the missing half — **limpiar** — and pins the three properties that make it
honest:

* the acknowledgement removes the trace from the SAME list ``/api/trace``
  counts, so the kanban column and the dashboard Stuck count drop together;
* it is keyed to one INCIDENT (trace identity + arr queue entry), so a later
  re-block of the same download shows again;
* an unidentified trace can never be acknowledged: its key would carry the
  shared ``unidentified`` sentinel and hide unrelated downloads.
"""

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app import app
from infrastructure import sqlite_history as history

client = TestClient(app, raise_server_exceptions=False)

#: One blocked trace with every field the ack key derives from.
_BLOCKED = {
    "source": "radarr",
    "title": "Transformers (2007)",
    "download_id": "abc123",
    "matched_hash": "abc123",
    "stage": "import_blocked",
    "category_ok": None,
    "ids": {"queue_id": 7, "episode_id": None, "movie_id": 603, "series_id": None},
}


@pytest.fixture
def store(tmp_path):
    """A fresh history database, isolated from the real config volume."""
    history.close()
    history.init_db(tmp_path / "history.db")
    _cold()
    yield history
    history.close()
    _cold()


def _cold():
    """Age the shared trace cache out so each GET builds what the test hands it."""
    from application.use_cases import trace_cache

    trace_cache._trace_cache = None


def _get():
    return client.get("/api/trace")


def _ack(trace: dict = _BLOCKED):
    return client.post(
        "/api/trace/blocked/ack",
        json={
            "source": trace.get("source", ""),
            "download_id": trace.get("download_id", ""),
            "ids": trace.get("ids") or {},
        },
    )


class TestLimpiarClearsTheBlockedColumn:
    def test_acknowledging_a_blocked_trace_clears_it_from_the_board(self, store):
        """The contract: one click, then the card and the count are gone.

        The second GET is served from the cache the FIRST one populated —
        the filter therefore has to run after the cache, or the clear would
        take effect only once the TTL expired.
        """
        with patch(
            "application.use_cases.trace_cache.build_traces",
            new_callable=AsyncMock,
        ) as build:
            build.return_value = [dict(_BLOCKED)]
            assert _get().json()["summary"]["import_blocked"] == 1

            resp = _ack()
            assert resp.status_code == 200, resp.text
            assert resp.json()["ok"] is True

            body = _get().json()

        assert body["traces"] == [], "the acked trace left the board"
        assert body["summary"]["import_blocked"] == 0, (
            "the count is derived from the SAME list the column draws — "
            "dashboard Stuck and kanban must not disagree"
        )

    def test_a_different_blocked_trace_stays_on_the_board(self, store):
        """Acknowledging one incident must not hide another download's."""
        other = dict(_BLOCKED, download_id="ffff01", title="Heat (1995)")
        with patch(
            "application.use_cases.trace_cache.build_traces",
            new_callable=AsyncMock,
        ) as build:
            build.return_value = [dict(_BLOCKED), other]
            assert _ack().json()["ok"] is True, "pre-implementation this is a 404"
            body = _get().json()

        assert [t["download_id"] for t in body["traces"]] == ["ffff01"]
        assert body["summary"]["import_blocked"] == 1

    def test_the_ack_expires_when_the_trace_leaves_the_blocked_stage(self, store):
        """The key names one incident (identity + queue entry): once the trace
        is observed in another stage the ack must stop hiding it, or a later,
        genuinely different blockage of the same download would be invisible.
        """
        with patch(
            "application.use_cases.trace_cache.build_traces",
            new_callable=AsyncMock,
        ) as build:
            assert _ack().json()["ok"] is True, "pre-implementation this is a 404"
            build.return_value = [dict(_BLOCKED, stage="sent")]
            _cold()
            body = _get().json()

        assert [t["stage"] for t in body["traces"]] == ["sent"], (
            "a trace the arr has moved on must show in its true column"
        )

    def test_a_re_block_of_the_same_download_shows_again(self, store):
        """Same identity, NEW queue entry → new incident → visible."""
        with patch(
            "application.use_cases.trace_cache.build_traces",
            new_callable=AsyncMock,
        ) as build:
            assert _ack().json()["ok"] is True, "pre-implementation this is a 404"
            build.return_value = [dict(_BLOCKED, ids=dict(_BLOCKED["ids"], queue_id=8))]
            _cold()
            body = _get().json()

        assert len(body["traces"]) == 1


class TestLimpiarRefusesWhatItCannotName:
    def test_an_unidentified_trace_is_refused_not_hidden(self, store):
        """Its key would end in the shared ``unidentified`` sentinel — one ack
        would hide every unidentified blocked download at once."""
        resp = _ack({"source": "radarr", "download_id": "", "ids": {}})

        assert resp.status_code == 200, resp.text
        assert resp.json()["ok"] is False
        assert "identificador" in resp.json()["error"]
        assert history.blocked_acks() == set(), "nothing was persisted"

    def test_the_ack_fails_honestly_when_the_store_is_closed(self):
        """A closed history database degrades to an error, never a 500 and
        never a success that did not persist — the card would come back on
        the next poll and the button would have lied."""
        history.close()

        resp = _ack()

        assert resp.status_code == 200, resp.text
        assert resp.json()["ok"] is False
        assert history.blocked_acks() == set()

    def test_the_endpoint_requires_the_api_key(self, store):
        from interfaces.http import deps as deps_module

        with patch(
            "infrastructure.settings_store.auth_required", return_value=True
        ), patch.object(deps_module, "credentials") as creds:
            creds.verify_api_key.return_value = False
            unauth = TestClient(app, raise_server_exceptions=False)
            resp = unauth.post(
                "/api/trace/blocked/ack",
                json={"source": "radarr", "download_id": "abc", "ids": {}},
            )

        assert resp.status_code == 401


def test_the_ack_filter_lives_at_the_response_not_in_the_cache(store):
    """Acknowledging is attention-management, never pipeline control.

    The sweep injects ``build_traces`` directly (``auto_copy_driver``), and
    the cache layer is shared with anyone else who asks for traces. Hiding
    inside the cache would make an ack silently change what other readers
    see; the filter belongs to the ``/api/trace`` response, where the column
    and the summary are drawn from the same filtered list.
    """
    import asyncio

    from application.use_cases import trace_cache

    with patch(
        "application.use_cases.trace_cache.build_traces",
        new_callable=AsyncMock,
    ) as build:
        build.return_value = [dict(_BLOCKED)]
        assert _ack().json()["ok"] is True, "pre-implementation this is a 404"
        _cold()
        raw = asyncio.run(trace_cache.get_traces())

    assert [t["download_id"] for t in raw] == ["abc123"], (
        "the ack filter belongs to the /api/trace response, not the cache"
    )
