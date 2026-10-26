"""async-grab — the grab runs as a job, not inside the POST.

The synchronous `POST /api/calendar/grab` awaited the whole chain inline —
the ED2K resolve alone measures 30-60 s against a reverse proxy that cuts at
~60 s, so the request died as a 504 while the download was already on its way
(masked once by raising `proxy_read_timeout` to 250 s by hand in nginx). These
tests pin the job contract that makes that class of failure impossible:

* starting the job answers with a task id WITHOUT touching the dispatch —
  only the worker may call it;
* the worker's payload lands in the task registry for the status endpoint to
  serve, byte for byte the payload the synchronous handler used to return
  (`ok`/`detail`, plus `direct` on the flow path — there the arr's world is
  bypassed entirely);
* a refusal produced inside the worker settles as `status="done"` with
  `ok=False` and the exact detail the synchronous handler returned, so the
  frontend's error channel needs no new branch;
* an unexpected failure settles as `status="error"` with the same
  `Error interno: ...` string the synchronous handler used to return;
* a grab that actually succeeded is recorded once, best-effort (`direct=True`
  on every success — S2: no add in this flow ever rode `arr_grab_release`),
  and a failed grab is never recorded.

calendario-directo T2 rewired the worker's transport seam: the grab no longer
rides `arr_grab_release` (S2) — the route injects the shape DISPATCH
(`interfaces.http.routes.indexers.dispatch_direct`, `(target, category)`), and
the category is chosen by destination (S3). These tests inject their own
dispatch mock; the shape dispatch itself is covered at the transport level in
`tests_calendar_direct.py` and `tests_grab_release_ec.py`.
"""

from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

import pytest

from application.use_cases.grab_release import grab_tasks, start_grab
from infrastructure.arr_client import direct_link_identity

import event_bus

FOREIGN = "/mnt/storage-6tb/Movies4K"
LIBRARY_ROOT = "/mnt/storage/movies"

#: The category the arr watches for a library grab (S3, literal per source).
WATCHED_CATEGORY = "radarr"


@pytest.fixture(autouse=True)
def _pure_identity():
    """`direct_link_identity` is PURE (`arr_client`): route the worker to the
    real rule without an arr adapter bound (the gateway seam is unbound in
    this module — the old EC tests' precedent)."""
    with patch("application.use_cases.grab_release.direct_link_identity", direct_link_identity):
        yield


@asynccontextmanager
async def _session():
    """A session stand-in: the worker only opens it, the mock never uses it."""
    yield object()


async def _resolve_series_none(session, service, source, episode_id):
    return None


async def _await_settled(task_id: str, *, timeout: float = 2.0) -> dict:
    """Poll the registry until the worker settles the job, or explain why not."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        task = grab_tasks.get(task_id)
        if task and task.get("status") in ("done", "error"):
            return task
        await asyncio.sleep(0.01)
    raise AssertionError(f"grab {task_id} never settled: {grab_tasks.get(task_id)}")


def _start(dispatch, **kwargs) -> dict:
    kwargs.setdefault("source", "radarr")
    kwargs.setdefault("service", {"name": "Radarr"})
    kwargs.setdefault("guid", "g1")
    return start_grab(
        **kwargs,
        session_factory=_session,
        resolve_series=_resolve_series_none,
        dispatch=dispatch,
    )


def _forget(task_id: str) -> None:
    grab_tasks._tasks.pop(task_id, None)


@patch("application.use_cases.grab_release.record_own_grab")
def test_start_returns_a_task_id_without_touching_the_dispatch(mock_record):
    """The start answers NOW; the dispatch is asked exactly once, by the worker.

    (Was `test_start_returns_a_task_id_without_touching_the_gateways`: the
    seam is the injected dispatch now — S2 removed the arr from this flow —
    and the settle/record contracts are unchanged.)"""
    mock_dispatch = AsyncMock(return_value={"ok": True, "detail": "Release encolado"})

    async def scenario():
        started = _start(mock_dispatch)
        # A task id NOW, still running — where the old handler would have
        # been awaiting the arr (30-60 s on the foreign path).
        assert started["ok"] is True
        assert started["status"] == "running"
        assert started["task_id"]
        assert "detail" in started
        # No await has happened yet, so the scheduled worker cannot have run:
        # if the dispatch is asked here, it is asked BY THE START — the inline
        # grab this feature exists to remove.
        assert mock_dispatch.await_count == 0
        return started, await _await_settled(started["task_id"])

    started, task = asyncio.run(scenario())
    # Exactly once, by the worker — and the payload it produced is what the
    # status endpoint will serve.
    assert mock_dispatch.await_count == 1
    assert task["status"] == "done"
    assert task["ok"] is True
    assert task["detail"] == "Release encolado"
    assert task["direct"] is False, "library grab: the arr WILL import it"
    _forget(started["task_id"])


@patch("application.use_cases.grab_release.record_own_grab")
def test_the_library_path_settles_the_old_body_and_records_once(mock_record):
    """A library grab settles `done` with the old body and one registry row —
    dispatched under the arr's WATCHED category (S3), never `arr_grab_release`
    (S2).

    (Was `test_the_arr_path_settles_the_old_body_and_records_once`: the seam
    and the registry `direct` flag changed — S2 records every add of this flow
    as `direct=True` — every other assertion is byte for byte.)"""
    mock_dispatch = AsyncMock(
        return_value={
            "ok": True,
            "detail": f"Descarga añadida en qBittorrent (stub), categoría {WATCHED_CATEGORY}",
        }
    )

    async def scenario():
        started = _start(
            mock_dispatch,
            movie_id=855,
            indexer_id=7,
            quality="Bluray-1080p",
        )
        return started, await _await_settled(started["task_id"])

    started, task = asyncio.run(scenario())
    assert task["status"] == "done"
    assert task["ok"] is True
    assert task["detail"] == f"Descarga añadida en qBittorrent (stub), categoría {WATCHED_CATEGORY}"
    assert task["direct"] is False

    mock_dispatch.assert_awaited_once_with("g1", WATCHED_CATEGORY)

    mock_record.assert_called_once()
    kwargs = mock_record.call_args.kwargs
    assert mock_record.call_args.args == ("radarr",)
    assert kwargs["movie_id"] == 855
    assert kwargs["episode_id"] is None, "0 means 'not a title id', not a title id"
    assert kwargs["guid"] == "g1"
    assert kwargs["indexer_id"] == 7
    assert kwargs["destination"] is None, "library grab: no destination was chosen"
    assert kwargs["quality"] == "Bluray-1080p"
    assert kwargs["direct"] is True, "S2: cada add de este flujo se registra como propio"
    _forget(started["task_id"])


@patch("application.use_cases.grab_release.record_own_grab")
def test_an_explicit_destination_settles_direct_with_the_honesty_suffix(mock_record):
    """A destination outside the library goes straight to the client under our
    own category (S3) and settles `direct: true` — the arr must never learn
    about it.

    (Was `test_the_foreign_path_settles_direct_and_never_asks_the_arr`: the
    roots/resolve/add seams are GONE — S2 dispatches the row's own link with
    no re-search — the settle, the suffix, the registry and the client
    identity assertions are byte for byte, now taken from the row's own link.)"""
    mock_dispatch = AsyncMock(return_value={"ok": True, "detail": "Descarga añadida (categoría flow)"})

    async def scenario():
        started = _start(
            mock_dispatch,
            destination=FOREIGN,
            link="ed2k://|file X.mkv|1|AA|/",
            title="Your.Name.2016.1080p.BluRay.x264-GRP",
        )
        return started, await _await_settled(started["task_id"])

    started, task = asyncio.run(scenario())
    assert task["status"] == "done"
    assert task["ok"] is True
    assert task["direct"] is True
    assert "directa" in task["detail"]

    mock_dispatch.assert_awaited_once_with("ed2k://|file X.mkv|1|AA|/", "flow")
    mock_record.assert_called_once()
    kwargs = mock_record.call_args.kwargs
    assert kwargs["direct"] is True
    assert kwargs["destination"] == FOREIGN
    assert kwargs["client_name"] == "X.mkv"
    _forget(started["task_id"])


@patch("application.use_cases.grab_release.record_own_grab")
def test_a_dispatch_refusal_settles_done_with_ok_false_and_records_nothing(mock_record):
    """A refusal produced by the dispatch settles `done` carrying the body —
    the task ran fine; its PAYLOAD says the grab did not.

    (Was `test_a_failed_arr_grab_settles_done_with_ok_false_and_records_nothing`:
    same contract, the dispatch seam.)"""
    mock_dispatch = AsyncMock(return_value={"ok": False, "detail": "HTTP 404: not found"})

    async def scenario():
        started = _start(mock_dispatch)
        return started, await _await_settled(started["task_id"])

    started, task = asyncio.run(scenario())
    assert task["status"] == "done"
    assert task["ok"] is False
    assert task["detail"] == "HTTP 404: not found"
    mock_record.assert_not_called()
    _forget(started["task_id"])


@patch("application.use_cases.grab_release.record_own_grab")
def test_an_unexpected_failure_settles_error_with_the_sync_detail(mock_record):
    """A raise out of the worker must not leave a `running` task forever: it
    settles as `Error interno: ...`, exactly what the old handler returned."""
    mock_dispatch = AsyncMock(side_effect=RuntimeError("arr exploded"))

    async def scenario():
        started = _start(mock_dispatch)
        return started, await _await_settled(started["task_id"])

    started, task = asyncio.run(scenario())
    assert task["status"] == "error"
    assert task["ok"] is False
    assert task["detail"] == "Error interno: arr exploded"
    mock_record.assert_not_called()
    _forget(started["task_id"])


@patch("application.use_cases.grab_release.record_own_grab")
def test_the_creation_site_tags_the_channel_and_the_settlement_publishes_it(mock_record):
    """T2(a) end to end for grab: the site says `channel="grab"`, and the
    terminal transition publishes exactly that to the SSE bus."""
    mock_dispatch = AsyncMock(return_value={"ok": True, "detail": "Release encolado"})

    async def scenario():
        queue = event_bus.subscribe()
        try:
            started = _start(mock_dispatch)
            task = await _await_settled(started["task_id"])
            event = await asyncio.wait_for(queue.get(), 1)
            return task, event
        finally:
            event_bus.unsubscribe(queue)
            grab_tasks._tasks.pop(started["task_id"], None)

    task, event = asyncio.run(scenario())
    assert task["channel"] == "grab"
    assert event == {
        "kind": "task",
        "channel": "grab",
        "task_id": task["id"],
        "status": "done",
        "detail": "Release encolado",
    }
