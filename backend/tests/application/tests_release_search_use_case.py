"""T1/S1 (calendario-directo) — the release-search job asks OUR sources.

History worth keeping: the synchronous `POST /api/calendar/releases` awaited
Radarr × 20 indexers for 91.6 s inside the request — longer than the proxy's
~60 s cut — so the 504 of 2026-10-07 was masked once by raising
`proxy_read_timeout` by hand in nginx. The job machinery that fixed it (C-10)
stays byte-identical; what changed in S1 is WHO the job asks: an injected
`fetcher` that fans out over the project's own direct sources (Torznab
registry + aMule EC + Prowlarr), never `arr_fetch_releases`.

Pinned here:

* starting the job answers with a task id WITHOUT running the search inline;
* the query (the item's title) travels verbatim to the fetcher;
* a fan-out where EVERY source failed settles as `status="error"` with the
  reasons — never `releases: []` dressed as a success (S1);
* a raised error keeps the old `Error interno: ...` settle;
* `channel="release"` still travels into the terminal SSE event.
"""

from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock

from application.use_cases.release_search import release_tasks, start_release_search


async def _await_settled(task_id: str, *, timeout: float = 2.0) -> dict:
    """Poll the registry until the worker settles the job, or explain why not."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        task = release_tasks.get(task_id)
        if task and task.get("status") in ("done", "error"):
            return task
        await asyncio.sleep(0.01)
    raise AssertionError(f"job {task_id} never settled: {release_tasks.get(task_id)}")


def test_the_job_asks_the_fetcher_once_and_never_inline():
    """The start answers NOW; the fan-out is asked exactly once, by the
    worker — and only after the start has already returned."""
    fetcher = AsyncMock(
        return_value={
            "ok": True,
            "releases": [{"guid": "g1", "title": "Rel1"}],
            "detail": "1 releases",
        }
    )

    async def scenario():
        started = start_release_search(
            "radarr",
            "movie",
            42,
            query="Blade Runner 1982",
            fetcher=fetcher,
        )
        assert started["ok"] is True
        assert started["status"] == "running"
        assert started["task_id"]
        assert "releases" not in started
        # Nothing awaited yet: an inline search would have run inside the start.
        assert fetcher.await_count == 0
        task = await _await_settled(started["task_id"])
        return started, task

    started, task = asyncio.run(scenario())
    assert fetcher.await_count == 1
    assert task["status"] == "done"
    assert task["releases"] == [{"guid": "g1", "title": "Rel1"}]
    assert task["detail"] == "1 releases"
    release_tasks._tasks.pop(started["task_id"], None)


def test_the_item_title_travels_verbatim_to_the_fetcher():
    """S1: the query is the item's title, exactly as the caller sent it —
    the route owns any trimming, the job never rewrites the search text."""
    fetcher = AsyncMock(return_value={"ok": True, "releases": [], "detail": "0 releases"})

    async def scenario():
        started = start_release_search(
            "sonarr",
            "episode",
            99,
            query="  Via Láctea  ",
            fetcher=fetcher,
        )
        return started, await _await_settled(started["task_id"])

    started, task = asyncio.run(scenario())
    assert fetcher.await_args.args == ("  Via Láctea  ",)
    assert task["status"] == "done"
    assert task["source"] == "sonarr"
    assert task["req_type"] == "episode"
    assert task["req_id"] == 99
    release_tasks._tasks.pop(started["task_id"], None)


def test_every_source_failing_settles_the_job_as_an_error_with_the_reasons():
    """S1: all-sources-failed is an ERROR settle carrying the fan-out's
    reasons — a silent `releases: []` under `status="done"` would read as
    «sin resultados» and that is the one answer S1 refuses to give."""
    reasons = (
        "todas las fuentes seleccionadas fallaron — "
        "amule: no está configurado; torznab: sin indexadores habilitados"
    )
    fetcher = AsyncMock(return_value={"ok": False, "releases": [], "detail": reasons})

    async def scenario():
        started = start_release_search(
            "radarr",
            "movie",
            7,
            query="Dune 2021",
            fetcher=fetcher,
        )
        return started, await _await_settled(started["task_id"])

    started, task = asyncio.run(scenario())
    assert task["status"] == "error"
    assert task["detail"] == reasons
    assert task["releases"] == []
    release_tasks._tasks.pop(started["task_id"], None)


def test_a_fetcher_that_raises_settles_error_interno():
    """A transport blow-up keeps the exact settle the synchronous handler
    used to return, so the frontend's error branch needs no new shape."""
    fetcher = AsyncMock(side_effect=RuntimeError("las fuentes explotaron"))

    async def scenario():
        started = start_release_search(
            "radarr",
            "movie",
            7,
            query="Dune 2021",
            fetcher=fetcher,
        )
        return started, await _await_settled(started["task_id"])

    started, task = asyncio.run(scenario())
    assert task["status"] == "error"
    assert task["detail"] == "Error interno: las fuentes explotaron"
    assert task["releases"] == []
    release_tasks._tasks.pop(started["task_id"], None)


def test_the_creation_site_tags_the_channel_and_the_settlement_publishes_it():
    """End to end for release search: `channel="release"` travels from the
    creation site into the terminal SSE event."""
    fetcher = AsyncMock(return_value={"ok": True, "releases": [], "detail": "0 releases"})

    async def scenario():
        import event_bus

        queue = event_bus.subscribe()
        try:
            started = start_release_search(
                "radarr",
                "movie",
                42,
                query="Blade Runner 1982",
                fetcher=fetcher,
            )
            task = await _await_settled(started["task_id"])
            event = await asyncio.wait_for(queue.get(), 1)
            return started, task, event
        finally:
            event_bus.unsubscribe(queue)

    started, task, event = asyncio.run(scenario())
    assert task["channel"] == "release"
    assert event["kind"] == "task"
    assert event["channel"] == "release"
    assert event["task_id"] == task["id"]
    assert event["status"] == "done"
    release_tasks._tasks.pop(started["task_id"], None)
