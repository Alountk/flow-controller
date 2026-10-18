"""T1/S3 — manual completion of stuck queue operations (POST /complete/{op_id}).

The queue can go quiet behind the user's back: a consumer that dies mid-op, a
process restart that leaves an old ``running`` row in SQLite, or an import
never re-checked. The files ARE there — only the UI state stays blocked. This
endpoint is the human's override: it flips an active (pending/running) op to
``done`` in both sources of truth, and refuses everything else, mirroring the
cancel route's contract.

Routes are exercised through their public HTTP interface; ``file_queue`` is
fixture setup (the queue's own data structure, as ``tests_mixer_api`` does with
``mux_tasks``). The durable ``db`` fixture is autouse so every assertion over
``/api/files/queue/status`` is deterministic: with a fresh history database the
endpoint's own ``record_operation`` writes are the only rows in play, and the
serializer's "prefer durable" branch never hides the op under test.
"""

import pytest
from fastapi.testclient import TestClient

from app import app
from infrastructure import sqlite_history as history
from state import file_queue

client = TestClient(app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def db(tmp_path):
    """Fresh history database per test — same isolation as tests_history."""
    history.close()
    history.init_db(tmp_path / "history.db")
    yield
    history.close()


def _op(op_id: str, status: str = "pending", **overrides) -> dict:
    op = {
        "id": op_id,
        "type": "copy",
        "name": "Dune.Parte.Dos.2024.1080p.mkv",
        "src": "/mnt/storage/downloads/Dune.Parte.Dos.2024.1080p.mkv",
        "dst": "/mnt/movies/Dune.Parte.Dos.2024.1080p.mkv",
        "status": status,
        "detail": None,
        "import_status": "",
        "arr_source": "",
        "movie_id": None,
        "series_id": None,
        "size_bytes": 1000,
        "copied_bytes": 500,
        "files_total": 1,
        "files_done": 0,
        "created_at": 1000.0,
        "started_at": 1100.0,
        "finished_at": None,
        "progress": 50,
        "total_bytes": 1000,
        "cancelled": False,
    }
    op.update(overrides)
    return op


def _enqueue(op: dict) -> dict:
    # Direct mutation is how tests_history drives file_queue too: queue_lock is
    # asyncio state for the consumer's loop, and test setup runs outside it.
    file_queue.append(op)
    return op


def _drain() -> None:
    file_queue.clear()


def _complete(op_id: str) -> dict:
    res = client.post(f"/api/files/queue/complete/{op_id}")
    assert res.status_code == 200
    return res.json()


def _rows(op_id: str) -> tuple[list[dict], list[dict]]:
    """(active, archived) as the status endpoint the UI renders reports them."""
    status = client.get("/api/files/queue/status").json()
    return (
        [o for o in status["queue"] if o["id"] == op_id],
        [o for o in status["completed"] if o["id"] == op_id],
    )


def test_complete_moves_a_pending_op_to_done_everywhere():
    _drain()
    _enqueue(_op("t1", "pending"))

    data = _complete("t1")

    assert data["ok"] is True
    active, archived = _rows("t1")
    assert active == [], "a completed op must leave the active queue"
    assert archived and archived[0]["status"] == "done"
    assert archived[0]["detail"] == "Completada manualmente"


def test_complete_moves_a_running_op_to_done():
    _drain()
    _enqueue(_op("t2", "running"))

    data = _complete("t2")

    assert data["ok"] is True
    active, archived = _rows("t2")
    assert active == []
    assert archived and archived[0]["status"] == "done"


def test_complete_rejects_a_terminal_op_without_changing_it():
    _drain()
    _enqueue(_op("t3", "failed"))

    data = _complete("t3")

    assert data["ok"] is False
    assert "estado" in data["detail"]
    active, archived = _rows("t3")
    assert active == []
    assert archived and archived[0]["status"] == "failed", "a rejected call must not flip the state"


def test_complete_reports_an_unknown_operation():
    _drain()

    data = _complete("nope")

    assert data["ok"] is False
    assert "no encontrada" in data["detail"]


def test_complete_falls_back_to_a_stuck_history_row(db):
    """After a restart the op is NOT in memory — only its SQLite row survives."""
    _drain()
    history.record_operation(_op("t5", "running"))

    data = _complete("t5")

    assert data["ok"] is True
    active, archived = _rows("t5")
    assert active == []
    assert archived and archived[0]["status"] == "done"
    assert archived[0]["detail"] == "Completada manualmente"
    assert archived[0]["progress"] == 100
    row = history.get_operation("t5")
    assert row["status"] == "done"
    assert row["finished_at"], "a terminal history row gets its end timestamp"


def test_complete_rejects_a_terminal_history_row(db):
    _drain()
    history.record_operation(_op("t6", "cancelled"))

    data = _complete("t6")

    assert data["ok"] is False
    assert "estado" in data["detail"]
    assert history.get_operation("t6")["status"] == "cancelled"
