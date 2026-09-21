"""Tests for the durable operation history.

The point of this module is that operations survive a restart. Without it the
last 50 vanish, which is the opposite of what an app whose job is spotting
pipeline breakage should do.
"""

import sqlite3

import pytest

import history


@pytest.fixture
def db(tmp_path):
    """A fresh database per test, isolated from the real config volume."""
    history.close()
    history.init_db(tmp_path / "history.db")
    yield
    history.close()


def _op(**overrides) -> dict:
    op = {
        "id": "op-1",
        "type": "copy",
        "name": "movie.mkv",
        "src": "/src/movie.mkv",
        "dst": "/dst/movie.mkv",
        "status": "pending",
        "detail": None,
        "import_status": None,
        "arr_source": "radarr",
        "movie_id": 42,
        "series_id": None,
        "size_bytes": 1000,
        "copied_bytes": 0,
        "files_total": 1,
        "files_done": 0,
        "created_at": 1000.0,
        "started_at": None,
        "finished_at": None,
    }
    op.update(overrides)
    return op


def test_creating_a_row_is_recorded(db):
    history.record_operation(_op())

    rows = history.recent_operations()

    assert len(rows) == 1
    assert rows[0]["id"] == "op-1"
    assert rows[0]["status"] == "pending"
    assert rows[0]["movie_id"] == 42


def test_recording_the_same_id_updates_rather_than_duplicates(db):
    history.record_operation(_op())
    history.record_operation(_op(status="running", started_at=1005.0))
    history.record_operation(_op(status="done", detail="Completado"))

    rows = history.recent_operations()

    assert len(rows) == 1, "an operation must not be duplicated on every state change"
    assert rows[0]["status"] == "done"
    assert rows[0]["started_at"] == 1005.0


def test_a_partial_update_does_not_wipe_stored_fields(db):
    """The live op dict is always complete, but a future caller passing a
    partial one must not silently destroy data."""
    history.record_operation(_op(started_at=1005.0, movie_id=42))
    history.record_operation({"id": "op-1", "status": "done"})  # partial

    row = history.recent_operations()[0]
    assert row["status"] == "done"
    assert row["started_at"] == 1005.0, "started_at was wiped by a partial update"
    assert row["movie_id"] == 42, "movie_id was wiped by a partial update"


def test_a_finished_operation_gets_an_end_timestamp(db):
    history.record_operation(_op(status="done"))

    assert history.recent_operations()[0]["finished_at"] is not None


def test_an_unfinished_operation_has_no_end_timestamp(db):
    history.record_operation(_op(status="running"))

    assert history.recent_operations()[0]["finished_at"] is None


def test_recent_operations_are_newest_first(db):
    history.record_operation(_op(id="old", created_at=1000.0))
    history.record_operation(_op(id="new", created_at=2000.0))

    assert [row["id"] for row in history.recent_operations()] == ["new", "old"]


def test_limit_and_offset(db):
    for i in range(5):
        history.record_operation(_op(id=f"op-{i}", created_at=1000.0 + i))

    assert [r["id"] for r in history.recent_operations(limit=2)] == ["op-4", "op-3"]
    assert [r["id"] for r in history.recent_operations(limit=2, offset=2)] == ["op-2", "op-1"]


def test_filter_by_status(db):
    history.record_operation(_op(id="ok", status="done"))
    history.record_operation(_op(id="bad", status="failed"))

    rows = history.recent_operations(status="failed")

    assert [r["id"] for r in rows] == ["bad"]


def test_an_empty_database_returns_nothing(db):
    assert history.recent_operations() == []


# ── Restart recovery ─────────────────────────────────────────────────────────


def test_interrupted_operations_are_marked_failed(db):
    """A copy cannot survive the process that was copying, so saying it is
    still running would be a lie."""
    history.record_operation(_op(id="running", status="running"))
    history.record_operation(_op(id="pending", status="pending"))
    history.record_operation(_op(id="done", status="done"))

    marked = history.mark_interrupted()

    assert marked == 2
    by_id = {row["id"]: row for row in history.recent_operations()}
    assert by_id["running"]["status"] == "failed"
    assert "interrumpida por reinicio" in by_id["running"]["detail"]
    assert by_id["pending"]["status"] == "failed"
    assert by_id["done"]["status"] == "done", "a finished operation must be left alone"


def test_history_survives_a_closed_and_reopened_database(tmp_path):
    """The actual promise: data outlives the process."""
    path = tmp_path / "history.db"
    history.close()
    history.init_db(path)
    history.record_operation(_op(id="survivor", status="done"))
    history.close()

    history.init_db(path)
    try:
        assert [r["id"] for r in history.recent_operations()] == ["survivor"]
    finally:
        history.close()


# ── Resilience ───────────────────────────────────────────────────────────────


def test_recording_is_a_no_op_when_the_database_is_unavailable():
    """History is a record, not a requirement for copying files."""
    history.close()

    # Must not raise: a copy should still work with no history database.
    history.record_operation(_op())
    assert history.recent_operations() == []
    assert history.mark_interrupted() == 0


def test_a_row_without_an_id_is_ignored(db):
    history.record_operation(_op(id=""))

    assert history.recent_operations() == []


def test_the_schema_declares_a_version_for_future_migrations(db, tmp_path):
    conn = sqlite3.connect(tmp_path / "history.db")
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
    finally:
        conn.close()

    assert version == history.SCHEMA_VERSION


# ── Wiring: the real queue lifecycle must reach the database ─────────────────


class TestQueueLifecycleIsPersisted:
    """Unit tests on history.py prove the module works; these prove the queue
    actually calls it. A missed call site is the realistic failure here."""

    @pytest.fixture(autouse=True)
    def _isolated_db(self, tmp_path):
        history.close()
        history.init_db(tmp_path / "history.db")
        from state import file_queue

        file_queue.clear()
        yield
        file_queue.clear()
        history.close()

    def _run(self, op: dict):
        import asyncio
        from state import file_queue
        import routes.files

        file_queue.append(op)
        asyncio.run(routes.files._consume_queue())

    def _op_for(self, tmp_path, **overrides) -> dict:
        src = tmp_path / "src.mkv"
        src.write_bytes(b"contenido")
        op = {
            "id": "lifecycle-1",
            "type": "copy",
            "src": str(src),
            "dst": str(tmp_path / "dst.mkv"),
            "name": "src.mkv",
            "status": "pending",
            "created_at": 1000.0,
            "started_at": None,
            "detail": None,
            "progress": 0,
            "copied_bytes": 0,
            "total_bytes": 0,
            "files_done": 0,
            "files_total": 0,
            "cancelled": False,
            "arr_source": "",
            "movie_id": None,
            "series_id": None,
        }
        op.update(overrides)
        return op

    def test_a_completed_operation_is_recorded_as_done(self, tmp_path):
        self._run(self._op_for(tmp_path))

        rows = history.recent_operations()

        assert len(rows) == 1, "the queue never wrote the operation to history"
        assert rows[0]["id"] == "lifecycle-1"
        assert rows[0]["status"] == "done"
        assert rows[0]["finished_at"] is not None
        assert rows[0]["name"] == "src.mkv"

    def test_a_failing_operation_is_recorded_as_failed(self, tmp_path):
        op = self._op_for(tmp_path)
        op["src"] = str(tmp_path / "no-existe.mkv")

        self._run(op)

        rows = history.recent_operations()
        assert rows[0]["status"] == "failed"
        assert rows[0]["detail"], "the failure reason must be persisted"

    def test_a_queued_operation_is_recorded_before_it_starts(self, tmp_path):
        """The realistic case the creation write exists for: several copies are
        queued and the process restarts before they run. Without recording at
        creation they would leave no trace at all."""
        from unittest.mock import AsyncMock, patch

        from fastapi.testclient import TestClient

        from app import app

        src = tmp_path / "queued.mkv"
        src.write_bytes(b"x")
        client = TestClient(app, raise_server_exceptions=False)

        # Stop the consumer so the op stays pending, which is exactly the state
        # a restart would find it in.
        with patch("routes.files._consume_queue", new=AsyncMock()), patch(
            "routes.files._validate_path", side_effect=lambda p: p
        ):
            resp = client.post(
                "/api/files/queue/add",
                json={"source": "copy", "remote_path": str(src), "local_path": str(tmp_path / "out")},
            )

        assert resp.status_code == 200
        rows = history.recent_operations()
        assert len(rows) == 1, "a queued operation left no durable trace"
        assert rows[0]["status"] == "pending"

    def test_the_record_outlives_the_in_memory_queue(self, tmp_path):
        from state import file_queue

        self._run(self._op_for(tmp_path))
        file_queue.clear()  # simulates the process going away

        assert [r["id"] for r in history.recent_operations()] == ["lifecycle-1"]
