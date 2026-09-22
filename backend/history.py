"""Durable record of file operations, backed by SQLite.

The in-memory queue in ``state.py`` is the live execution queue; this module is
the durable record of what happened. Without it, the last 50 operations vanish
on every restart — the opposite of what an app whose job is spotting pipeline
breakage should do.

Why SQLite: it is in the standard library, it is a single file next to
``settings.json``, it gives real queries and transactions, and it needs no
service to run. Writes are rare (a few per operation), so the synchronous
``sqlite3`` API is used and callers hand it to ``asyncio.to_thread``.

Schema changes go through ``PRAGMA user_version`` so future migrations — a
``users`` table if app-level accounts are ever wanted — are possible without a
rewrite.
"""

import logging
import os
import sqlite3
import threading
import time
from pathlib import Path

log = logging.getLogger("flow-controller")

SCHEMA_VERSION = 2

SCHEMA = """
CREATE TABLE IF NOT EXISTS operations (
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
CREATE INDEX IF NOT EXISTS idx_operations_created ON operations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operations_status ON operations (status);
-- v2: a new table lands on an existing database WITHOUT an ALTER. init_db runs
-- this whole script on every start and `CREATE TABLE IF NOT EXISTS` is a no-op
-- once the table exists, so a v1 file simply gains the table. Bumping
-- SCHEMA_VERSION only records that the migration happened; it does not drive
-- it. That is why this table needs no per-version ALTER block.
CREATE TABLE IF NOT EXISTS auto_copy_handled (
    key         TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    title       TEXT,
    decision    TEXT NOT NULL,
    reason      TEXT,
    handled_at  REAL NOT NULL
);
"""

# Columns mirrored from the in-memory op. Kept explicit so an unexpected key
# cannot silently reshape the table.
_COLUMNS = (
    "id", "type", "name", "src", "dst", "status", "detail", "import_status",
    "arr_source", "movie_id", "series_id", "size_bytes", "copied_bytes",
    "files_total", "files_done", "created_at", "started_at", "finished_at",
)

_conn: sqlite3.Connection | None = None
_lock = threading.RLock()


def _default_path() -> Path:
    return Path(os.environ.get("CONFIG_DIR", "/app/config")) / "history.db"


def init_db(path: Path | None = None) -> None:
    """Open the database and apply the schema. Safe to call more than once."""
    global _conn

    target = Path(path) if path else _default_path()
    with _lock:
        if _conn is not None:
            return
        try:
            # The mkdir can raise OSError (unwritable or missing config
            # directory) and connect can raise sqlite3.Error. Both must degrade,
            # never raise: this runs in the app lifespan, so an escaping error
            # would stop the whole server from starting over a HISTORY database.
            target.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(target, check_same_thread=False)
            # WAL lets readers work while a write is in flight.
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            # row_factory is a sqlite3 hook: it makes every row subscriptable by
            # column name, which `dict(row)` below depends on. Static analysis
            # cannot see the call, so vulture reports it as unused.
            conn.row_factory = sqlite3.Row  # noqa
            conn.executescript(SCHEMA)

            version = conn.execute("PRAGMA user_version").fetchone()[0]
            if version < SCHEMA_VERSION:
                conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            conn.commit()
            _conn = conn
            log.info("History database ready at %s (schema v%d)", target, SCHEMA_VERSION)
        except (OSError, sqlite3.Error) as exc:
            # Never take the app down over history: it is a record, not a
            # requirement for copying files.
            log.warning("History database unavailable at %s: %s", target, exc)
            _conn = None


def record_operation(op: dict) -> None:
    """Insert or update one operation. Missing fields default sensibly."""
    with _lock:
        if _conn is None:
            return
        row = {column: op.get(column) for column in _COLUMNS}
        row["id"] = str(row["id"] or "")
        if not row["id"]:
            return
        row["type"] = row["type"] or "copy"
        row["name"] = row["name"] or ""
        row["src"] = row["src"] or ""
        row["dst"] = row["dst"] or ""
        row["status"] = row["status"] or "pending"
        row["created_at"] = row["created_at"] or 0
        # A finished operation gets an end timestamp unless one is already set.
        if row["status"] in ("done", "failed", "cancelled") and not row["finished_at"]:
            row["finished_at"] = time.time()

        placeholders = ", ".join(f":{c}" for c in _COLUMNS)
        # COALESCE keeps a stored value when the incoming one is NULL, so a
        # partial update can never silently wipe data (for example dropping the
        # movie_id that links the operation to its library entry). The live op
        # dict is always complete today; this guards the next caller.
        updates = ", ".join(
            f"{c}=COALESCE(excluded.{c}, operations.{c})" for c in _COLUMNS if c != "id"
        )
        try:
            _conn.execute(
                f"INSERT INTO operations ({', '.join(_COLUMNS)}) VALUES ({placeholders}) "
                f"ON CONFLICT(id) DO UPDATE SET {updates}",
                row,
            )
            _conn.commit()
        except sqlite3.Error as exc:
            log.warning("Could not record operation %s: %s", row["id"], exc)


def recent_operations(limit: int = 10, offset: int = 0, status: str | None = None) -> list[dict]:
    """Most recent operations, newest first."""
    with _lock:
        if _conn is None:
            return []
        sql = "SELECT * FROM operations"
        params: list = []
        if status:
            sql += " WHERE status = ?"
            params.append(status)
        sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        try:
            return [dict(row) for row in _conn.execute(sql, params).fetchall()]
        except sqlite3.Error as exc:
            log.warning("Could not read operation history: %s", exc)
            return []


# ── Auto-copy idempotency markers ────────────────────────────────────────────
#
# One row per candidate the app decided to copy. The key is `auto_copy_key`'s
# output. Without a durable record, the window between "copied" and "the arr
# sees it" (a rescan/refresh is not instant) would make the next sweep copy the
# same file again. The module that fails must never be the reason the app goes
# down, so both functions follow the same degrade-not-raise discipline as the
# rest of the module.


def mark_auto_copy(
    key: str,
    *,
    source: str,
    title: str | None = None,
    decision: str,
    reason: str | None = None,
) -> None:
    """Record that this key was handled. Re-marking is an upsert, not an error."""
    if not key:
        return
    with _lock:
        if _conn is None:
            return
        try:
            _conn.execute(
                "INSERT INTO auto_copy_handled "
                "(key, source, title, decision, reason, handled_at) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET "
                "    source=excluded.source, "
                "    title=COALESCE(excluded.title, auto_copy_handled.title), "
                "    decision=excluded.decision, "
                "    reason=COALESCE(excluded.reason, auto_copy_handled.reason), "
                "    handled_at=excluded.handled_at",
                (key, source, title, decision, reason, time.time()),
            )
            _conn.commit()
        except sqlite3.Error as exc:
            log.warning("Could not mark auto-copy %s: %s", key, exc)


def is_auto_copy_handled(key: str) -> bool:
    """Whether a marker exists for this key.

    Degrades to False when the store is unreadable: the honest reading is "not
    handled", whose worst case is a repeated copy. Reporting True would silently
    skip a copy that is actually due, which is the failure this marker exists to
    prevent.
    """
    if not key:
        return False
    with _lock:
        if _conn is None:
            return False
        try:
            row = _conn.execute(
                "SELECT 1 FROM auto_copy_handled WHERE key = ?", (key,)
            ).fetchone()
            return row is not None
        except sqlite3.Error as exc:
            log.warning("Could not read auto-copy marker %s: %s", key, exc)
            return False


def mark_interrupted() -> int:
    """Mark operations left running by a restart as failed.

    An operation cannot survive the process that was copying the file, so
    leaving it "running" forever would be a lie. This is the honest record.
    """
    with _lock:
        if _conn is None:
            return 0
        try:
            cursor = _conn.execute(
                "UPDATE operations "
                "SET status='failed', "
                "    detail=COALESCE(detail, '') || ' (interrumpida por reinicio)', "
                "    finished_at=COALESCE(finished_at, ?) "
                "WHERE status IN ('pending', 'running')",
                (time.time(),),
            )
            _conn.commit()
            if cursor.rowcount:
                log.info("Marked %d interrupted operation(s) as failed", cursor.rowcount)
            return cursor.rowcount
        except sqlite3.Error as exc:
            log.warning("Could not mark interrupted operations: %s", exc)
            return 0


def close() -> None:
    global _conn
    with _lock:
        if _conn is not None:
            _conn.close()
            _conn = None
