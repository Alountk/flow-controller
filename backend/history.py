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

SCHEMA_VERSION = 5

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
-- v3: registry of the grabs this app itself launched (decision D3: act only on
-- our own grabs). Same migration discipline as v2 — `CREATE TABLE IF NOT
-- EXISTS` inside the script `init_db` runs on every start, so a real v2 file
-- gains the table with no ALTER and the version bump only records it.
--
-- `guid` is stored for AUDIT ONLY, and this is the trap: in a grabbed history
-- record `data.guid` is the DOWNLOAD CLIENT's hash, NOT the indexer's release
-- guid (measured against the real API, 2026-09-22). So the release guid cannot
-- be joined against the arr's history. The own-grab match is by (title id +
-- time); `auto_copy.matches_own_grab` implements it. Do not "optimise" this
-- into a guid join.
CREATE TABLE IF NOT EXISTS own_grabs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT NOT NULL,
    movie_id    INTEGER,
    episode_id  INTEGER,
    series_id   INTEGER,
    guid        TEXT,
    indexer_id  INTEGER,
    grabbed_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_own_grabs_title ON own_grabs (source, movie_id, episode_id);
-- v4: the "first time we saw this candidate in this condition" reference. Same
-- migration discipline as v2/v3: `CREATE TABLE IF NOT EXISTS` inside the script
-- `init_db` runs on every start, so a real v3 file gains the table with no ALTER
-- and the version bump only records it.
--
-- Why it exists: the sweep's grace window ("the download finished and the arr
-- never noticed") cannot be measured from the trace. Its only timestamp is the
-- grab `date`, which PRECEDES the download, so starting the clock there would
-- race the arr (D2). The reference has to be persisted the first time we observe
-- the condition. Ours, unlike the arr's, starts where it should.
--
-- `stage` is part of the identity, not decoration: a download that moves from
-- `downloading` to `downloaded` is a NEW condition, and its window must start at
-- that transition. `note_auto_copy_seen` resets `first_seen_at` when it changes.
CREATE TABLE IF NOT EXISTS auto_copy_seen (
    key           TEXT PRIMARY KEY,
    stage         TEXT NOT NULL,
    first_seen_at REAL NOT NULL
);
-- v5: append-only log of auto-copy DECISION TRANSITIONS — one row each time a
-- candidate's outcome CHANGES. Same migration discipline as v2/v3/v4:
-- `CREATE TABLE IF NOT EXISTS` inside the script `init_db` runs on every start,
-- so a real v4 file gains the table with no ALTER and the version bump only
-- records it.
--
-- Why a transition log and not a row per sweep: a sweep can run every 15
-- minutes, so a row per sweep would bury the interesting line under thousands
-- of identical "wait" rows. One row per change keeps the history readable.
--
-- Why `wait` and `skip` are logged too: they are the answer to "why did it NOT
-- copy this?", which is the most common outcome and the least explained. This
-- does NOT contradict "`WAIT` writes nothing": that rule governs the handled
-- MARKER (`auto_copy_handled`), which exists to stop a second copy. A log row
-- claims nothing and blocks nothing — it only records that the outcome was
-- observed to be `wait`/`skip` at that instant. The marker and the log have
-- different jobs and the difference is deliberate.
--
-- The stored `decision` is the sweep's OUTCOME, not the raw policy verdict: the
-- action when there is one (`copied`/`proposed`/`failed`) and the policy's
-- decision otherwise (`wait`/`skip`). One field, so the UI needs no second
-- lookup — and the `proposed` -> `copied` transition (safe mode turned off) is
-- exactly the kind of change worth a row.
CREATE TABLE IF NOT EXISTS auto_copy_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    key       TEXT NOT NULL,
    source    TEXT,
    title     TEXT,
    decision  TEXT NOT NULL,
    reason    TEXT,
    at        REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auto_copy_log_newest ON auto_copy_log (at DESC, id DESC);
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
# One row per candidate the app evaluated. The key is `auto_copy_key`'s output.
# Without a durable record, the window between "copied" and "the arr sees it" (a
# rescan/refresh is not instant) would make the next sweep copy the same file
# again. The module that fails must never be the reason the app goes down, so
# both functions follow the same degrade-not-raise discipline as the rest of the
# module.

#: Stored `decision` value that means the app ACTUALLY acted.
#:
#: `is_auto_copy_handled` counts only rows carrying this value. The marker's
#: question is "did the app actually copy this?", not "is there a row?". A
#: SAFE_MODE sweep records its proposal under a different decision, and a failed
#: dispatch under another; neither may count as handled:
#:
#:   - If a proposal counted, turning safe mode off would make the next sweep
#:     believe the work was done and silently never act — the proposal would
#:     become a permanent lie.
#:   - If a failed dispatch counted, one transient failure would forbid the
#:     retry the operation needs.
#:
#: Before this, `is_auto_copy_handled` returned True for ANY row. The driver
#: (T6) needs the distinction, so the semantics were corrected here. The driver
#: owns the labels it writes for the other two outcomes.
DECISION_ACTIONED = "copy"


def mark_auto_copy(
    key: str,
    *,
    source: str,
    title: str | None = None,
    decision: str,
    reason: str | None = None,
) -> None:
    """Record the outcome for this key. Re-marking is an upsert, not an error.

    `decision` distinguishes an action taken (`DECISION_ACTIONED`) from a
    proposal made under safe mode (`DECISION_PROPOSED`) or a failed dispatch
    (`DECISION_FAILED`); only the first counts as handled when read back.
    """
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
    """Whether an ACTIONED marker exists for this key.

    Only a row recorded as `DECISION_ACTIONED` counts. A SAFE_MODE proposal or
    a failed dispatch must not read as handled, or the earlier sweep's intent
    would suppress the later copy that is actually due — exactly the failure the
    marker exists to prevent.

    Degrades to False when the store is unreadable: the honest reading is "not
    handled", whose worst case is a repeated copy. Reporting True would silently
    skip a copy that is actually due.
    """
    if not key:
        return False
    with _lock:
        if _conn is None:
            return False
        try:
            row = _conn.execute(
                "SELECT 1 FROM auto_copy_handled WHERE key = ? AND decision = ?",
                (key, DECISION_ACTIONED),
            ).fetchone()
            return row is not None
        except sqlite3.Error as exc:
            log.warning("Could not read auto-copy marker %s: %s", key, exc)
            return False


# ── Own-grab registry (T5) ───────────────────────────────────────────────────
#
# One row per grab the APP launched, so a later sweep can tell whether a grab in
# the arr's history is one we asked for (decision D3). Same degrade-not-raise
# discipline as the rest of the module: this runs inside a request handler, and
# a history failure must never take the app down nor turn a successful grab into
# a failed response.
#
# The reader T5 deliberately left out lives below: its only consumer is the T6
# driver, so it was not written until the driver existed. The contract T5 wrote
# down is honoured exactly: `list_own_grabs(...) -> list[dict]` with the
# own_grabs columns (id, source, movie_id, episode_id, series_id, guid,
# indexer_id, grabbed_at) as plain dicts, newest first, ready to hand straight
# to `auto_copy.matches_own_grab(trace, own_grabs)`.


def list_own_grabs(since: float, limit: int = 200) -> list[dict]:
    """Own-grab rows grabbed at or after `since`, newest first, as plain dicts.

    `since` bounds the read: a trace's `date` is fixed at the arr's grab instant,
    so a grab the app launched can still be matched hours later, and the caller
    chooses how far back that is worth loading. Degrades to [] when the store is
    unavailable — the caller treats that as "no grab is provably ours", and the
    policy then skips instead of copying something nobody asked for (D3).
    """
    with _lock:
        if _conn is None:
            return []
        try:
            rows = _conn.execute(
                "SELECT * FROM own_grabs WHERE grabbed_at >= ? "
                "ORDER BY grabbed_at DESC LIMIT ?",
                (since, limit),
            ).fetchall()
            return [dict(row) for row in rows]
        except sqlite3.Error as exc:
            log.warning("Could not read own grabs: %s", exc)
            return []


def own_grabs_latest_map(since: float) -> dict[tuple[str, str, int], float]:
    """Latest own-grab instant per title, for marking wanted items.

    One query aggregates ``MAX(grabbed_at)`` per ``(source, movie_id,
    episode_id, series_id)``. There is deliberately NO ``LIMIT``: the sibling
    reader caps at 200 rows, and applying a cap here would silently drop marks
    for every title past it. A dropped mark reads as "never requested", which is
    a wrong answer on screen, and a wrong answer is worse than a slower query.
    The result is bounded by how many distinct titles were grabbed in the window,
    not by the raw number of grabs.

    Keys are ``(source, kind, id)`` with ``kind`` in ``{"movie", "episode",
    "series"}``. The kind is part of the key because a movie, an episode and a
    series can carry the same numeric id and must not collide.

    One row can contribute MORE THAN ONE key: an episode grab records both the
    episode and its series, because the "Todas" tab shows series cards and a
    series card has to read "we asked for something from this series". The
    series mark is the newest episode grab for that series, computed here rather
    than left to SQL: the grouping is per episode, so several rows can share a
    series and the last row read would otherwise win by accident.

    A row with no movie, episode or series id cannot be keyed and is skipped.

    Degrades to ``{}`` when the store is unavailable: the caller treats that as
    "no marks", which is the safe direction — an unmarked card is the status quo
    and never a claim that the title was not requested.
    """
    with _lock:
        if _conn is None:
            return {}
        try:
            rows = _conn.execute(
                "SELECT source, movie_id, episode_id, series_id, "
                "       MAX(grabbed_at) AS grabbed_at "
                "FROM own_grabs WHERE grabbed_at >= ? "
                "GROUP BY source, movie_id, episode_id, series_id",
                (since,),
            ).fetchall()
        except sqlite3.Error as exc:
            log.warning("Could not read own grab marks: %s", exc)
            return {}

    marks: dict[tuple[str, str, int], float] = {}
    for row in rows:
        source = row["source"]
        grabbed_at = float(row["grabbed_at"])
        # movie_id wins when both are set, matching how the app records a grab:
        # a movie grab carries no episode.
        if row["movie_id"] is not None:
            marks[(source, "movie", int(row["movie_id"]))] = grabbed_at
        elif row["episode_id"] is not None:
            marks[(source, "episode", int(row["episode_id"]))] = grabbed_at
        # Independent of the branch above: an episode grab also marks its series.
        # Keep the newest, because one series is a single key shared by all of
        # its episodes and the rows are not ordered.
        if row["series_id"] is not None:
            series_key = (source, "series", int(row["series_id"]))
            previous = marks.get(series_key)
            if previous is None or grabbed_at > previous:
                marks[series_key] = grabbed_at
    return marks


def record_own_grab(
    source: str,
    *,
    movie_id: int | None = None,
    episode_id: int | None = None,
    series_id: int | None = None,
    guid: str = "",
    indexer_id: int = 0,
    grabbed_at: float | None = None,
) -> None:
    """Record one grab this app launched. Best-effort: never raises.

    `guid` is audit only: the release guid cannot be matched against the arr's
    history (see the schema comment). Matching is by title id + time.
    """
    with _lock:
        if _conn is None:
            return
        try:
            _conn.execute(
                "INSERT INTO own_grabs "
                "(source, movie_id, episode_id, series_id, guid, indexer_id, grabbed_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    source,
                    movie_id,
                    episode_id,
                    series_id,
                    guid or "",
                    indexer_id or 0,
                    time.time() if grabbed_at is None else grabbed_at,
                ),
            )
            _conn.commit()
        except (sqlite3.Error, TypeError, ValueError) as exc:
            # Broader than the other writers on purpose: the caller is a request
            # handler that has ALREADY grabbed successfully, so an escaping error
            # would turn a completed grab into an HTTP 500.
            log.warning("Could not record own grab (%s/%s): %s", source, guid, exc)


# ── First-seen reference for the grace window (T10) ──────────────────────────
#
# The durable half of "wait N minutes before acting". The sweep cannot derive
# this instant from the trace (its `date` is the grab, which precedes the
# download), so the reference is persisted here the first time a candidate is
# seen in a given condition. See the schema comment on `auto_copy_seen`.


def note_auto_copy_seen(
    key: str, stage: str, *, seen_at: float | None = None
) -> float:
    """Record and return the instant `key` was first seen in `stage`.

    The return value is the reference the caller must measure the grace window
    from, and its semantics are the whole point:

      - new key            → store `seen_at` (default: now) and return it;
      - same key, same stage → keep the stored instant and return THAT, so a
        later sweep can still see that the window has elapsed;
      - same key, different stage → the condition changed, so reset the instant
        to `seen_at` and return it: a download moving from `downloading` to
        `downloaded` starts its window at the transition, not when it was first
        seen at all.

    One atomic upsert, not a read then a write: two concurrent sweeps must not
    both see "new" and reset each other's window. The single statement below
    both stores and returns the effective value.

    Degrades to `seen_at` when the store is unavailable. That reads as "the
    window just started", so the caller waits instead of acting — the safe
    direction, because acting on a missing reference would race the arr (D2).
    """
    when = time.time() if seen_at is None else seen_at
    if not key:
        return when
    with _lock:
        if _conn is None:
            return when
        try:
            row = _conn.execute(
                "INSERT INTO auto_copy_seen (key, stage, first_seen_at) "
                "VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET "
                "    first_seen_at = CASE "
                "        WHEN auto_copy_seen.stage = excluded.stage "
                "        THEN auto_copy_seen.first_seen_at "
                "        ELSE excluded.first_seen_at "
                "    END, "
                "    stage = excluded.stage "
                "RETURNING first_seen_at",
                (key, stage, when),
            ).fetchone()
            _conn.commit()
            return float(row[0])
        except sqlite3.Error as exc:
            log.warning("Could not note auto-copy first seen %s: %s", key, exc)
            return when


# ── Decision-transition log (T7) ─────────────────────────────────────────────
#
# The append-only counterpart of the marker above. The marker answers "is the
# work done?" and is state; this log answers "what changed, and why?" and is
# history. Same degrade-not-raise discipline as the rest of the module: a store
# failure must never take down a sweep nor turn the endpoint into a 500.


def latest_auto_copy_decisions() -> dict[str, str]:
    """The most recent logged outcome per key, in ONE grouped query for all keys.

    The sweep reads this once per run, so the transition check costs one query
    per sweep instead of one per trace. Keys with no row yet are simply absent,
    which the caller reads as "no previous outcome".

    Degrades to ``{}`` when the store is unavailable: the caller then treats
    every candidate as new, and because the writer is a no-op too, nothing is
    silently lost by the missing map.
    """
    with _lock:
        if _conn is None:
            return {}
        try:
            rows = _conn.execute(
                "SELECT key, decision FROM auto_copy_log "
                "WHERE id IN (SELECT MAX(id) FROM auto_copy_log GROUP BY key)"
            ).fetchall()
            return {row["key"]: row["decision"] for row in rows}
        except sqlite3.Error as exc:
            log.warning("Could not read last auto-copy decisions: %s", exc)
            return {}


def log_auto_copy_decision(
    key: str,
    *,
    source: str,
    title: str | None = None,
    decision: str,
    reason: str | None = None,
) -> None:
    """Append one row when this key's last logged decision differs.

    An identical repeated outcome appends NOTHING. Without that rule a sweep
    every 15 minutes would bury the interesting transition under thousands of
    identical rows — the whole reason this is a transition log and not a row per
    sweep.

    One statement, not a read followed by a write: the "last decision per key"
    is a grouped subquery inside the INSERT, so two writers cannot both observe
    the old value and both append. The subquery covers all keys — the same shape
    the sweep's batched read uses — while the writer keeps its own check so its
    contract holds for any caller.
    """
    if not key:
        return
    with _lock:
        if _conn is None:
            return
        try:
            _conn.execute(
                "INSERT INTO auto_copy_log (key, source, title, decision, reason, at) "
                "SELECT ?, ?, ?, ?, ?, ? "
                "WHERE NOT EXISTS ("
                "    SELECT 1 FROM ("
                "        SELECT key, decision FROM auto_copy_log "
                "        WHERE id IN (SELECT MAX(id) FROM auto_copy_log GROUP BY key)"
                "    ) AS latest "
                "    WHERE latest.key = ? AND latest.decision = ?"
                ")",
                (key, source, title, decision, reason, time.time(), key, decision),
            )
            _conn.commit()
        except sqlite3.Error as exc:
            log.warning("Could not log auto-copy decision %s: %s", key, exc)


def recent_auto_copy_log(limit: int = 20) -> list[dict]:
    """The log's newest-first rows as plain dicts.

    ``limit`` is clamped to a sane range: a negative value means "no limit" in
    SQLite, so an unchecked query parameter could dump the whole log. Degrades
    to ``[]`` when the store is unavailable; the endpoint reports that honestly
    instead of turning it into a 500.
    """
    limit = max(1, min(int(limit), 200))
    with _lock:
        if _conn is None:
            return []
        try:
            rows = _conn.execute(
                "SELECT * FROM auto_copy_log ORDER BY at DESC, id DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [dict(row) for row in rows]
        except sqlite3.Error as exc:
            log.warning("Could not read auto-copy log: %s", exc)
            return []


def store_available() -> bool:
    """Whether the history database is open.

    The reader's ``[]`` cannot tell "nothing logged yet" from "store down", and
    the endpoint must report those differently, so it asks this instead of
    guessing from an empty list.
    """
    with _lock:
        return _conn is not None


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
