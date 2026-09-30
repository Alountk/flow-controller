"""Shared application state — status cache, log buffer, file queue."""

import asyncio
import collections
import logging
import os
from contextlib import asynccontextmanager

import aiohttp
from pathlib import Path

# ── In-memory log buffer + file persistence ───────────────────────────────────

_LOG_BUFFER: collections.deque[dict] = collections.deque(maxlen=200)
_LOG_FILE = Path(os.environ.get("CONFIG_DIR", "/app/config")) / "logs.json"


class _BufferHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            entry = {
                "time": self.format(record),
                "level": record.levelname,
                "message": record.getMessage(),
            }
            _LOG_BUFFER.append(entry)
            self._persist(entry)
        except Exception:
            pass

    def _persist(self, entry: dict) -> None:
        try:
            _LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
            existing: list[dict] = []
            if _LOG_FILE.exists():
                existing = _LOG_FILE.read_text().splitlines()
            # Keep last 500 lines
            existing.append(
                f'{entry["level"]}: {entry["time"]} — {entry["message"]}'
            )
            if len(existing) > 500:
                existing = existing[-500:]
            _LOG_FILE.write_text("\n".join(existing) + "\n")
        except Exception:
            pass


def _load_log_file() -> list[dict]:
    """Load persisted log lines into buffer on startup."""
    if not _LOG_FILE.exists():
        return []
    entries: list[dict] = []
    try:
        for line in _LOG_FILE.read_text().splitlines():
            if not line.strip():
                continue
            # Parse "LEVEL: time — message" format
            parts = line.split(": ", 1)
            level = parts[0] if len(parts) > 1 else "INFO"
            msg = parts[1] if len(parts) > 1 else line
            entries.append({"level": level, "time": "", "message": msg})
    except Exception:
        pass
    return entries


buf_handler = _BufferHandler()
buf_handler.setFormatter(logging.Formatter("%(asctime)s"))
buf_handler.setLevel(logging.WARNING)

# ── Status cache ──────────────────────────────────────────────────────────────

status_cache: dict = {
    "flow": "unknown",
    "checking": False,
    "updated_at": 0,
    "radarr": "unknown:init",
    "sonarr": "unknown:init",
    "amutorrent": "unknown:init",
}

# ── File queue ────────────────────────────────────────────────────────────────

file_queue: list[dict] = []
queue_lock = asyncio.Lock()
queue_consumer_task: asyncio.Task | None = None
# True while a `_consume_queue` task is meant to be running. The check and the
# flip live under `queue_lock`, which is the same lock the consumer takes to
# decide it has drained — so neither side can miss the other. The task handle is
# consulted too, so a consumer that died without clearing the flag does not
# wedge every later add.
consumer_active: bool = False


# ── HTTP session ────────────────────────────────────────────────────────────
#
# Every route used to build its own `aiohttp.ClientSession`, so no connection
# was ever reused: one TCP setup per outbound call, no keep-alive, and no
# ceiling on how many sockets a burst could open. A lifespan runs exactly one
# event loop for the process, so one session can serve every outbound call and
# pool its connections.

# aiohttp's defaults, stated explicitly: the ceiling should be visible rather
# than implied. Three hosts (radarr, sonarr, amutorrent) and the trace fan-out
# of four calls each sit well inside `limit_per_host`.
_HTTP_LIMIT = 100
_HTTP_LIMIT_PER_HOST = 30

_shared_session: aiohttp.ClientSession | None = None


def open_shared_session() -> None:
    """Create the process-wide session. Called once, from the lifespan."""
    global _shared_session
    if _shared_session is None or _shared_session.closed:
        _shared_session = aiohttp.ClientSession(
            connector=aiohttp.TCPConnector(
                limit=_HTTP_LIMIT, limit_per_host=_HTTP_LIMIT_PER_HOST
            )
        )


async def close_shared_session() -> None:
    """Close the process-wide session at shutdown."""
    global _shared_session
    if _shared_session is not None and not _shared_session.closed:
        await _shared_session.close()
    _shared_session = None


@asynccontextmanager
async def http_session(*args, **kwargs):
    """Yield a session for this scope: the shared one, or a private one.

    Under a lifespan every scope receives THE session, so keep-alive works and
    the connector's limits apply process-wide. Outside a lifespan — which is
    where the test suite lives, since it never enters one — each scope gets its
    own session and closes it on exit, exactly the behaviour every existing
    route test asserts.

    Not for the aMuleTorrent WebSocket helpers: they pass their own
    `cookie_jar` and must keep a private session.
    """
    shared = _shared_session
    if shared is not None and not shared.closed:
        yield shared
        return
    async with aiohttp.ClientSession(*args, **kwargs) as session:
        yield session
