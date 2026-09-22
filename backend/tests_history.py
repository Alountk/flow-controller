"""Tests for the durable operation history.

The point of this module is that operations survive a restart. Without it the
last 50 vanish, which is the opposite of what an app whose job is spotting
pipeline breakage should do.
"""

import sqlite3
import time

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


# ── An unavailable database must never stop the app ──────────────────────────


class TestUnavailableDatabase:
    """init_db runs in the app lifespan, so an escaping error there stops the
    whole server from starting — over a HISTORY database."""

    def test_init_db_survives_an_unwritable_directory(self, tmp_path):
        history.close()
        blocked = tmp_path / "readonly"
        blocked.mkdir()
        blocked.chmod(0o500)  # no write permission
        try:
            history.init_db(blocked / "nested" / "history.db")
            # Must not raise, and must simply report itself as unavailable.
            history.record_operation(_op())
            assert history.recent_operations() == []
        finally:
            blocked.chmod(0o700)
            history.close()

    def test_init_db_survives_a_path_that_is_a_file(self, tmp_path):
        history.close()
        a_file = tmp_path / "not-a-dir"
        a_file.write_text("x")

        # mkdir on a path whose parent is a file raises OSError.
        history.init_db(a_file / "history.db")

        assert history.recent_operations() == []
        history.close()


# ── Auto-copy idempotency markers ────────────────────────────────────────────
#
# The key is `auto_copy_key`'s output; these tests pin the durable half of the
# idempotency promise: once handled, always handled, across a restart.


def test_a_marker_is_written_and_read_back(db):
    history.mark_auto_copy(
        "radarr:467250d5",
        source="radarr",
        title="Your Name.",
        decision="copy",
        reason="el arr no lo importó",
    )

    assert history.is_auto_copy_handled("radarr:467250d5") is True


def test_an_unknown_key_reads_as_not_handled(db):
    assert history.is_auto_copy_handled("radarr:never-seen") is False


def test_re_marking_the_same_key_updates_instead_of_raising(db, tmp_path):
    history.mark_auto_copy("k", source="radarr", title="A", decision="copy", reason="r1")
    history.mark_auto_copy("k", source="radarr", title="B", decision="skip", reason="r2")

    conn = sqlite3.connect(tmp_path / "history.db")
    try:
        rows = conn.execute(
            "SELECT decision, title, reason FROM auto_copy_handled"
        ).fetchall()
    finally:
        conn.close()

    assert len(rows) == 1, "re-marking must upsert, not insert a second row"
    assert rows[0] == ("skip", "B", "r2")


def test_marking_is_a_no_op_when_the_database_is_unavailable():
    history.close()

    # Must not raise: a marker is bookkeeping, not a reason to stop the app.
    history.mark_auto_copy("k", source="radarr", decision="copy")
    assert history.is_auto_copy_handled("k") is False


def test_a_keyless_marker_is_ignored(db):
    history.mark_auto_copy("", source="radarr", decision="copy")

    assert history.is_auto_copy_handled("") is False


# ── The marker means "acted", not "a row exists" ─────────────────────────────
#
# T6 corrected this. Before, ANY row read as handled, so a SAFE_MODE proposal
# would have blocked the real copy forever once safe mode was turned off. Both
# directions matter: a proposal must stay non-blocking, an acted marker must
# block.


def test_an_actioned_marker_counts_as_handled(db):
    history.mark_auto_copy(
        "radarr:467250d5", source="radarr", decision=history.DECISION_ACTIONED
    )

    assert history.is_auto_copy_handled("radarr:467250d5") is True


def test_a_proposed_marker_does_not_count_as_handled(db):
    """A safe-mode proposal must not freeze the work it detected."""
    history.mark_auto_copy(
        "radarr:467250d5",
        source="radarr",
        decision="proposed",
        reason="el arr no lo importó en 30 min",
    )

    assert history.is_auto_copy_handled("radarr:467250d5") is False


def test_a_failed_dispatch_does_not_count_as_handled(db):
    """One transient failure must leave the retry possible."""
    history.mark_auto_copy(
        "radarr:467250d5",
        source="radarr",
        decision="dispatch_failed",
        reason="sin output_path",
    )

    assert history.is_auto_copy_handled("radarr:467250d5") is False


def test_an_actioned_marker_can_replace_an_earlier_proposal(db):
    """The real sequence: propose under safe mode, act with it off."""
    history.mark_auto_copy("k", source="radarr", decision="proposed")
    history.mark_auto_copy("k", source="radarr", decision=history.DECISION_ACTIONED)

    assert history.is_auto_copy_handled("k") is True


def test_an_actioned_marker_can_replace_an_earlier_failure(db):
    """The retry sequence: fail, then act on the next sweep."""
    history.mark_auto_copy("k", source="radarr", decision="dispatch_failed")
    history.mark_auto_copy("k", source="radarr", decision=history.DECISION_ACTIONED)

    assert history.is_auto_copy_handled("k") is True


# The exact operations table a v1 database carried, before auto_copy_handled.
V1_OPERATIONS_SCHEMA = """
CREATE TABLE operations (
    id            TEXT PRIMARY KEY,
    type          TEXT NOT NULL,
    name          TEXT NOT NULL,
    src           TEXT NOT NULL,
    dst           TEXT NOT NULL,
    status        TEXT NOT NULL,
    detail        TEXT,
    import_status TEXT,
    arr_source    TEXT,
    movie_id      INTEGER,
    series_id     INTEGER,
    size_bytes    INTEGER DEFAULT 0,
    copied_bytes  INTEGER DEFAULT 0,
    files_total   INTEGER DEFAULT 0,
    files_done    INTEGER DEFAULT 0,
    created_at    REAL NOT NULL,
    started_at    REAL,
    finished_at   REAL
);
CREATE INDEX idx_operations_created ON operations (created_at DESC);
CREATE INDEX idx_operations_status ON operations (status);
"""


def test_init_db_migrates_a_v1_database_without_an_alter(tmp_path):
    """v2 adds `auto_copy_handled`. `executescript` runs the whole schema with
    CREATE TABLE IF NOT EXISTS on every start, so a real v1 file gains the table
    with no ALTER; user_version only records that the migration happened."""
    path = tmp_path / "history.db"
    history.close()

    conn = sqlite3.connect(path)
    try:
        conn.executescript(V1_OPERATIONS_SCHEMA)
        conn.execute(
            "INSERT INTO operations (id, type, name, src, dst, status, created_at) "
            "VALUES ('legacy', 'copy', 'old.mkv', '/s', '/d', 'done', 1000.0)"
        )
        conn.execute("PRAGMA user_version=1")
        conn.commit()
    finally:
        conn.close()

    history.init_db(path)
    try:
        # The new table exists and is usable on the migrated file.
        history.mark_auto_copy("k", source="radarr", decision="copy")
        assert history.is_auto_copy_handled("k") is True
        # The v1 data survived the migration.
        assert [r["id"] for r in history.recent_operations()] == ["legacy"]
    finally:
        history.close()

    conn = sqlite3.connect(path)
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
    finally:
        conn.close()
    # A v1 file advances all the way to the CURRENT schema (it gained both
    # auto_copy_handled and own_grabs), so this is not pinned to 2 any more.
    assert version == history.SCHEMA_VERSION


# ── Own-grab registry (T5) ───────────────────────────────────────────────────
#
# The rows that let a later sweep tell whether an arr-history grab is one this
# app launched (D3). The reader does not exist yet (T6 owns it), so these read
# the table directly with sqlite3.


def _own_grab_rows(path) -> list[dict]:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute("SELECT * FROM own_grabs ORDER BY id")]
    finally:
        conn.close()


def test_an_own_grab_round_trips(db, tmp_path):
    history.record_own_grab(
        "radarr",
        movie_id=855,
        guid="release-guid-123",
        indexer_id=7,
        grabbed_at=1234.5,
    )

    rows = _own_grab_rows(tmp_path / "history.db")

    assert len(rows) == 1
    assert rows[0]["source"] == "radarr"
    assert rows[0]["movie_id"] == 855
    assert rows[0]["episode_id"] is None
    assert rows[0]["guid"] == "release-guid-123"
    assert rows[0]["indexer_id"] == 7
    assert rows[0]["grabbed_at"] == 1234.5


def test_an_own_grab_defaults_to_now_when_no_instant_is_given(db, tmp_path):
    history.record_own_grab("sonarr", episode_id=2286, series_id=28)

    rows = _own_grab_rows(tmp_path / "history.db")

    assert len(rows) == 1
    assert rows[0]["episode_id"] == 2286
    assert rows[0]["series_id"] == 28
    assert rows[0]["grabbed_at"] > 0


def test_recording_an_own_grab_is_a_no_op_when_the_database_is_unavailable():
    """It runs inside a request handler: it must never raise, and must never
    turn a successful grab into a failed response."""
    history.close()

    history.record_own_grab("radarr", movie_id=1, guid="g", grabbed_at=1.0)


# The exact tables a v2 database carried, before own_grabs.
V2_SCHEMA = V1_OPERATIONS_SCHEMA + """
CREATE TABLE auto_copy_handled (
    key         TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    title       TEXT,
    decision    TEXT NOT NULL,
    reason      TEXT,
    handled_at  REAL NOT NULL
);
"""


def test_init_db_migrates_a_v2_database_without_an_alter(tmp_path):
    """v3 adds `own_grabs`. As with v1->v2, `executescript` runs the whole
    schema with CREATE TABLE IF NOT EXISTS on every start, so a real v2 file
    gains the table with no ALTER; user_version only records the migration."""
    path = tmp_path / "history.db"
    history.close()

    conn = sqlite3.connect(path)
    try:
        conn.executescript(V2_SCHEMA)
        conn.execute(
            "INSERT INTO operations (id, type, name, src, dst, status, created_at) "
            "VALUES ('legacy', 'copy', 'old.mkv', '/s', '/d', 'done', 1000.0)"
        )
        conn.execute(
            "INSERT INTO auto_copy_handled (key, source, decision, handled_at) "
            "VALUES ('k', 'radarr', 'copy', 1000.0)"
        )
        conn.execute("PRAGMA user_version=2")
        conn.commit()
    finally:
        conn.close()

    history.init_db(path)
    try:
        # The new table exists and is usable on the migrated file.
        history.record_own_grab("radarr", movie_id=855, guid="g", grabbed_at=1234.0)
        rows = _own_grab_rows(path)
        assert len(rows) == 1
        assert rows[0]["movie_id"] == 855
        # The earlier tables and their rows survived.
        assert history.is_auto_copy_handled("k") is True
        assert [r["id"] for r in history.recent_operations()] == ["legacy"]
    finally:
        history.close()

    conn = sqlite3.connect(path)
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
    finally:
        conn.close()
    # A v2 file now advances all the way to the CURRENT schema (it also gains
    # auto_copy_seen), so this is not pinned to 3 any more.
    assert version == history.SCHEMA_VERSION


# ── The own-grab reader (T6) ─────────────────────────────────────────────────
#
# The driver reads the registry through this; its shape is the contract T5 wrote
# down, so the driver can hand the rows straight to `matches_own_grab`.


def test_own_grabs_are_read_newest_first_as_plain_dicts(db):
    history.record_own_grab("radarr", movie_id=1, guid="g1", grabbed_at=100.0)
    history.record_own_grab("sonarr", episode_id=2, series_id=9, guid="g2", grabbed_at=200.0)

    rows = history.list_own_grabs(0)

    assert [row["grabbed_at"] for row in rows] == [200.0, 100.0]
    assert set(rows[0]) == {
        "id", "source", "movie_id", "episode_id", "series_id", "guid",
        "indexer_id", "grabbed_at",
    }
    assert rows[0]["source"] == "sonarr"
    assert rows[0]["episode_id"] == 2


def test_own_grabs_before_since_are_excluded(db):
    history.record_own_grab("radarr", movie_id=1, grabbed_at=100.0)
    history.record_own_grab("radarr", movie_id=2, grabbed_at=300.0)

    rows = history.list_own_grabs(200.0)

    assert [row["movie_id"] for row in rows] == [2]


def test_own_grabs_respect_the_limit(db):
    for i in range(5):
        history.record_own_grab("radarr", movie_id=i, grabbed_at=100.0 + i)

    rows = history.list_own_grabs(0, limit=2)

    assert [row["movie_id"] for row in rows] == [4, 3]


def test_list_own_grabs_is_empty_when_the_database_is_unavailable():
    """The reader runs on the sweep path: an unavailable store must read as
    "nothing is provably ours", never raise."""
    history.close()

    assert history.list_own_grabs(0) == []


# ── First-seen reference for the grace window (T10) ──────────────────────────
#
# The durable reference the sweep measures its grace window from. Its semantics
# are the whole reason it exists: a later sweep must still see the ORIGINAL
# instant so the window can elapse, and a stage change must start a fresh
# window at the transition.


def _seen_rows(path) -> list[dict]:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute("SELECT * FROM auto_copy_seen ORDER BY key")]
    finally:
        conn.close()


def test_a_new_key_stores_and_returns_the_reference(db, tmp_path):
    returned = history.note_auto_copy_seen("radarr:abc", "downloaded", seen_at=1234.5)

    assert returned == 1234.5
    rows = _seen_rows(tmp_path / "history.db")
    assert len(rows) == 1
    assert rows[0]["key"] == "radarr:abc"
    assert rows[0]["stage"] == "downloaded"
    assert rows[0]["first_seen_at"] == 1234.5


def test_a_new_key_defaults_to_now_when_no_instant_is_given(db, tmp_path):
    before = time.time()

    returned = history.note_auto_copy_seen("radarr:abc", "downloaded")

    assert before <= returned <= time.time()


def test_the_same_key_and_stage_keeps_and_returns_the_original(db, tmp_path):
    """This is what lets a later sweep observe that the window has elapsed."""
    first = history.note_auto_copy_seen("radarr:abc", "downloaded", seen_at=100.0)
    second = history.note_auto_copy_seen("radarr:abc", "downloaded", seen_at=999.0)

    assert first == 100.0
    assert second == 100.0, "a later sighting must NOT reset the window"
    rows = _seen_rows(tmp_path / "history.db")
    assert len(rows) == 1
    assert rows[0]["first_seen_at"] == 100.0


def test_a_stage_change_resets_the_window(db, tmp_path):
    """A download moving from `downloading` to `downloaded` is a NEW condition:
    its window starts at the transition, not when it was first seen at all."""
    history.note_auto_copy_seen("radarr:abc", "downloading", seen_at=100.0)

    returned = history.note_auto_copy_seen("radarr:abc", "downloaded", seen_at=500.0)

    assert returned == 500.0
    rows = _seen_rows(tmp_path / "history.db")
    assert len(rows) == 1, "the key is the identity; a stage change upserts"
    assert rows[0]["stage"] == "downloaded"
    assert rows[0]["first_seen_at"] == 500.0


def test_noting_a_reference_is_a_no_op_when_the_database_is_unavailable():
    """Degrades to `seen_at`, which reads as "the window just started", so the
    caller waits instead of acting — the safe direction."""
    history.close()

    assert history.note_auto_copy_seen("radarr:abc", "downloaded", seen_at=42.0) == 42.0


def test_a_keyless_reference_returns_the_given_instant():
    history.close()

    assert history.note_auto_copy_seen("", "downloaded", seen_at=7.0) == 7.0


# The exact tables a v3 database carried, before auto_copy_seen.
V3_SCHEMA = V2_SCHEMA + """
CREATE TABLE own_grabs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT NOT NULL,
    movie_id    INTEGER,
    episode_id  INTEGER,
    series_id   INTEGER,
    guid        TEXT,
    indexer_id  INTEGER,
    grabbed_at  REAL NOT NULL
);
CREATE INDEX idx_own_grabs_title ON own_grabs (source, movie_id, episode_id);
"""


def test_init_db_migrates_a_v3_database_without_an_alter(tmp_path):
    """v4 adds `auto_copy_seen`. As with v1->v2 and v2->v3, `executescript` runs
    the whole schema with CREATE TABLE IF NOT EXISTS on every start, so a real
    v3 file gains the table with no ALTER; user_version only records it."""
    path = tmp_path / "history.db"
    history.close()

    conn = sqlite3.connect(path)
    try:
        conn.executescript(V3_SCHEMA)
        conn.execute(
            "INSERT INTO operations (id, type, name, src, dst, status, created_at) "
            "VALUES ('legacy', 'copy', 'old.mkv', '/s', '/d', 'done', 1000.0)"
        )
        conn.execute(
            "INSERT INTO auto_copy_handled (key, source, decision, handled_at) "
            "VALUES ('k', 'radarr', 'copy', 1000.0)"
        )
        conn.execute(
            "INSERT INTO own_grabs (source, movie_id, guid, indexer_id, grabbed_at) "
            "VALUES ('radarr', 855, 'g', 1, 1234.0)"
        )
        conn.execute("PRAGMA user_version=3")
        conn.commit()
    finally:
        conn.close()

    history.init_db(path)
    try:
        # The new table exists and is usable on the migrated file.
        assert history.note_auto_copy_seen("radarr:abc", "downloaded", seen_at=99.0) == 99.0
        rows = _seen_rows(path)
        assert len(rows) == 1
        assert rows[0]["first_seen_at"] == 99.0
        # The earlier tables and their rows survived.
        assert history.is_auto_copy_handled("k") is True
        assert [r["movie_id"] for r in history.list_own_grabs(0)] == [855]
        assert [r["id"] for r in history.recent_operations()] == ["legacy"]
    finally:
        history.close()

    conn = sqlite3.connect(path)
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
    finally:
        conn.close()
    assert version == 4
