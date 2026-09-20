"""Shared application state — status cache, log buffer, file queue."""

import asyncio
import collections
import logging
import os
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
