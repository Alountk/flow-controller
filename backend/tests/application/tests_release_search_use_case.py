"""C-10 — the release search runs as a job, not inside the POST.

The synchronous `POST /api/calendar/releases` awaited a Radarr × 20-indexer
search measured at 91.6 s against a reverse proxy that cuts at ~60 s: the 504
of 2026-10-07 was masked once by raising `proxy_read_timeout` to 250 s by hand
in nginx. These tests pin the job contract that makes that class of failure
impossible:

* starting the job answers with a task id WITHOUT touching the arr — only the
  worker may call `arr_fetch_releases`;
* the worker's payload lands in the task registry for the status endpoint to
  serve, byte for byte the payload the synchronous handler used to return;
* a failed search settles as `status="error"` with the exact `Error interno:
  ...` detail the synchronous handler used to return, so the frontend's error
  channel needs no new branch.
"""

from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

from application.use_cases.release_search import release_tasks, start_release_search


@asynccontextmanager
async def _session():
    """A session stand-in: the worker only opens it, the mock never uses it."""
    yield object()


async def _identity(result: dict) -> dict:
    """An enrichment that changes nothing — the route's indexer mapping is
    injected from the outside, exactly like every other dependency here."""
    return result


async def _await_settled(task_id: str, *, timeout: float = 2.0) -> dict:
    """Poll the registry until the worker settles the job, or explain why not."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        task = release_tasks.get(task_id)
        if task and task.get("status") in ("done", "error"):
            return task
        await asyncio.sleep(0.01)
    raise AssertionError(f"job {task_id} never settled: {release_tasks.get(task_id)}")


@patch("application.use_cases.release_search.arr_fetch_releases", new_callable=AsyncMock)
def test_start_returns_a_task_id_without_asking_the_arr(mock_fetch):
    """The start answers NOW; the arr is asked exactly once, by the worker."""
    mock_fetch.return_value = {
        "releases": [{"guid": "g1", "indexer": "Torznab"}],
        "detail": "1 releases",
    }

    async def scenario():
        started = start_release_search(
            "radarr",
            {"name": "Radarr"},
            "movie",
            42,
            session_factory=_session,
            enrich=_identity,
        )
        # A task id NOW, still running, with no payload — where the old
        # handler would have been awaiting Radarr for 91.6 s.
        assert started["ok"] is True
        assert started["status"] == "running"
        assert started["task_id"]
        assert "releases" not in started
        # No await has happened yet, so the scheduled worker cannot have run:
        # if the arr is asked here, it is asked BY THE START — the inline
        # search C-10 exists to remove.
        assert mock_fetch.await_count == 0
        task = await _await_settled(started["task_id"])
        return started, task

    started, task = asyncio.run(scenario())
    # Exactly once, by the worker — and the payload it produced is what the
    # status endpoint will serve.
    assert mock_fetch.await_count == 1
    assert task["status"] == "done"
    assert task["releases"] == [{"guid": "g1", "indexer": "Torznab"}]
    assert task["detail"] == "1 releases"
    release_tasks._tasks.pop(started["task_id"], None)


@patch("application.use_cases.release_search.arr_fetch_releases", new_callable=AsyncMock)
def test_episode_job_asks_the_arr_under_the_episode_id(mock_fetch):
    """`type` decides which id the worker passes — movie_id vs episode_id."""
    mock_fetch.return_value = {"releases": [], "detail": "0 releases"}

    async def scenario():
        started = start_release_search(
            "sonarr",
            {"name": "Sonarr"},
            "episode",
            99,
            session_factory=_session,
            enrich=_identity,
        )
        return started, await _await_settled(started["task_id"])

    started, task = asyncio.run(scenario())
    assert task["status"] == "done"
    assert task["releases"] == []
    args, kwargs = mock_fetch.await_args
    assert kwargs == {"episode_id": 99}
    assert args[1] == {"name": "Sonarr"}
    release_tasks._tasks.pop(started["task_id"], None)


@patch("application.use_cases.release_search.arr_fetch_releases", new_callable=AsyncMock)
def test_failed_job_settles_as_error_with_the_sync_detail(mock_fetch):
    """A search that blows up must answer exactly what the old handler did."""
    mock_fetch.side_effect = RuntimeError("arr exploded")

    async def scenario():
        started = start_release_search(
            "radarr",
            {"name": "Radarr"},
            "movie",
            7,
            session_factory=_session,
            enrich=_identity,
        )
        return started, await _await_settled(started["task_id"])

    started, task = asyncio.run(scenario())
    assert task["status"] == "error"
    assert task["detail"] == "Error interno: arr exploded"
    assert task["releases"] == []
    release_tasks._tasks.pop(started["task_id"], None)
