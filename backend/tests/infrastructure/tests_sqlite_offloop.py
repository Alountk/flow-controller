"""SQLite on the hot path.

`history.py`'s own docstring states the contract: writes are rare, so the
synchronous API is used and **callers hand it to `asyncio.to_thread`**. Roughly
eight call sites never did.

The one that matters is `attach_grabbed_at`: it runs on **every**
`/api/wanted`, `/api/wanted/all`, `/api/wanted/series/all` and `/api/calendar`
response, and it reads `own_grabs` with `WHERE grabbed_at >= ?` and **no index
on `grabbed_at`** — an unindexed full scan, synchronously, on the loop, for the
mark that the whole "descarga pedida" feature is built on.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from app import app
from fastapi.testclient import TestClient

client = TestClient(app, raise_server_exceptions=False)


def _ran_on_the_event_loop() -> bool:
    """Thread-local: inline code finds the loop, a pool thread does not."""
    try:
        asyncio.get_running_loop()
        return True
    except RuntimeError:
        return False


_EMPTY_PAGE = {"items": [], "total": 0, "page": 1, "page_size": 50}


class TestTheGrabMarkReadIsOffTheEventLoop:
    def _spy_history(self, seen: dict) -> MagicMock:
        hist = MagicMock()

        def read_rows(since):
            seen["rows"] = _ran_on_the_event_loop()
            return []

        hist.own_grabs_latest_rows.side_effect = read_rows
        hist.own_grabs_latest_map.return_value = {}
        return hist

    def test_wanted_reads_the_mark_off_the_loop(self):
        seen: dict = {}
        with patch("interfaces.http.routes.wanted.fetch_wanted_movies", new_callable=AsyncMock,
                   return_value=dict(_EMPTY_PAGE)), \
             patch("interfaces.http.route_helpers.history", new=self._spy_history(seen)):
            resp = client.get("/api/wanted?source=radarr")

        assert resp.status_code == 200, resp.text
        assert "rows" in seen, "the mark was never read"
        assert seen["rows"] is False, "an unindexed own_grabs scan ran on the event loop"

    def test_the_all_listing_reads_the_mark_off_the_loop(self):
        seen: dict = {}
        with patch("interfaces.http.routes.wanted.fetch_all_movies_detailed", new_callable=AsyncMock,
                   return_value=dict(_EMPTY_PAGE)), \
             patch("interfaces.http.route_helpers.history", new=self._spy_history(seen)):
            resp = client.get("/api/wanted/all")

        assert resp.status_code == 200, resp.text
        assert "rows" in seen, "the mark was never read"
        assert seen["rows"] is False, "a different route hit the same inline scan"


class TestTheAutoCopyHistoryReadIsOffTheEventLoop:
    def test_the_history_route_reads_off_the_loop(self):
        seen: dict = {}

        def read(limit):
            seen["log"] = _ran_on_the_event_loop()
            return []

        with patch("interfaces.http.routes.auto_copy.recent_auto_copy_log", side_effect=read), \
             patch("interfaces.http.routes.auto_copy.store_available", return_value=True):
            resp = client.get("/api/auto-copy/history")

        assert resp.status_code == 200, resp.text
        assert "log" in seen, "the log was never read"
        assert seen["log"] is False, "a sqlite read ran inline on the event loop"
