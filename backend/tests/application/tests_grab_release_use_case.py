"""async-grab — the grab runs as a job, not inside the POST.

The synchronous `POST /api/calendar/grab` awaited the whole chain inline —
the ED2K resolve alone measures 30-60 s against a proxy that cuts at ~60 s,
so the request died as a 504 while the download was already on its way
(masked once by raising `proxy_read_timeout` by hand in nginx). These tests
pin the job contract that makes that class of failure impossible:

* starting the job answers with a task id WITHOUT touching any gateway —
  only the worker may ask the arr or aMuTorrent;
* the worker's payload lands in the task registry for the status endpoint to
  serve, byte for byte the payload the synchronous handler used to return
  (`ok`/`detail`, plus `direct` on the foreign path);
* a refusal produced inside the worker settles as `status="done"` with
  `ok=False` and the exact detail the synchronous handler returned, so the
  frontend's error channel needs no new branch;
* an unexpected failure settles as `status="error"` with the same
  `Error interno: ...` string the synchronous handler used to return;
* a grab that actually succeeded is recorded once, best-effort, and a failed
  grab is never recorded.
"""

from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

from application.use_cases.grab_release import grab_tasks, start_grab

import event_bus

FOREIGN = "/mnt/storage-6tb/Movies4K"
LIBRARY_ROOT = "/mnt/storage/movies"


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


def _start(**kwargs) -> dict:
    kwargs.setdefault("source", "radarr")
    kwargs.setdefault("service", {"name": "Radarr"})
    kwargs.setdefault("guid", "g1")
    return start_grab(
        **kwargs,
        session_factory=_session,
        resolve_series=_resolve_series_none,
    )


def _forget(task_id: str) -> None:
    grab_tasks._tasks.pop(task_id, None)


@patch("application.use_cases.grab_release.record_own_grab")
@patch("application.use_cases.grab_release.arr_grab_release", new_callable=AsyncMock)
def test_start_returns_a_task_id_without_touching_the_gateways(mock_grab, mock_record):
    """The start answers NOW; the arr is asked exactly once, by the worker."""
    mock_grab.return_value = {"ok": True, "detail": "Release encolado"}

    async def scenario():
        started = _start()
        # A task id NOW, still running — where the old handler would have
        # been awaiting the arr (30-60 s on the foreign path).
        assert started["ok"] is True
        assert started["status"] == "running"
        assert started["task_id"]
        assert "detail" in started
        # No await has happened yet, so the scheduled worker cannot have run:
        # if the arr is asked here, it is asked BY THE START — the inline
        # grab this feature exists to remove.
        assert mock_grab.await_count == 0
        return started, await _await_settled(started["task_id"])

    started, task = asyncio.run(scenario())
    # Exactly once, by the worker — and the payload it produced is what the
    # status endpoint will serve.
    assert mock_grab.await_count == 1
    assert task["status"] == "done"
    assert task["ok"] is True
    assert task["detail"] == "Release encolado"
    assert task["direct"] is False
    _forget(started["task_id"])


@patch("application.use_cases.grab_release.record_own_grab")
@patch("application.use_cases.grab_release.arr_grab_release", new_callable=AsyncMock)
def test_the_arr_path_settles_the_old_body_and_records_once(mock_grab, mock_record):
    """A library grab settles `done` with the old body and one registry row."""
    mock_grab.return_value = {"ok": True, "detail": "Release encolado para descarga"}

    async def scenario():
        started = _start(
            movie_id=855,
            indexer_id=7,
            quality="Bluray-1080p",
        )
        return started, await _await_settled(started["task_id"])

    started, task = asyncio.run(scenario())
    assert task["status"] == "done"
    assert task["ok"] is True
    assert task["detail"] == "Release encolado para descarga"
    assert task["direct"] is False

    mock_record.assert_called_once()
    kwargs = mock_record.call_args.kwargs
    assert mock_record.call_args.args == ("radarr",)
    assert kwargs["movie_id"] == 855
    assert kwargs["episode_id"] is None, "0 means 'not a title id', not a title id"
    assert kwargs["guid"] == "g1"
    assert kwargs["indexer_id"] == 7
    assert kwargs["destination"] is None, "library grab: no destination was chosen"
    assert kwargs["quality"] == "Bluray-1080p"
    assert kwargs["direct"] is False
    _forget(started["task_id"])


@patch("application.use_cases.grab_release.direct_link_identity")
@patch("application.use_cases.grab_release.record_own_grab")
@patch("application.use_cases.grab_release.arr_grab_release", new_callable=AsyncMock)
@patch("application.use_cases.grab_release.amutorrent_add_download", new_callable=AsyncMock)
@patch("application.use_cases.grab_release.amutorrent_search_link", new_callable=AsyncMock)
@patch("application.use_cases.grab_release.arr_root_folders", new_callable=AsyncMock)
def test_the_foreign_path_settles_direct_and_never_asks_the_arr(
    mock_roots, mock_search, mock_add, mock_grab, mock_record, mock_identity
):
    """A destination outside every arr root goes straight to the client and
    settles `direct: true` — the arr must never learn about it."""
    mock_roots.return_value = [LIBRARY_ROOT]
    mock_search.return_value = {"ok": True, "link": "ed2k://|file X.mkv|1|AA|/", "detail": "query"}
    mock_add.return_value = {"ok": True, "detail": "Descarga añadida (categoría flow)"}
    mock_identity.return_value = ("X.mkv", None)

    async def scenario():
        started = _start(
            destination=FOREIGN,
            title="Your.Name.2016.1080p.BluRay.x264-GRP",
        )
        return started, await _await_settled(started["task_id"])

    started, task = asyncio.run(scenario())
    assert task["status"] == "done"
    assert task["ok"] is True
    assert task["direct"] is True
    assert "directa" in task["detail"]

    mock_roots.assert_awaited_once()
    mock_search.assert_awaited_once()
    mock_add.assert_awaited_once()
    mock_grab.assert_not_awaited(), "the arr must never be told about this download"
    mock_record.assert_called_once()
    kwargs = mock_record.call_args.kwargs
    assert kwargs["direct"] is True
    assert kwargs["destination"] == FOREIGN
    assert kwargs["client_name"] == "X.mkv"
    _forget(started["task_id"])


@patch("application.use_cases.grab_release.record_own_grab")
@patch("application.use_cases.grab_release.arr_grab_release", new_callable=AsyncMock)
def test_a_failed_arr_grab_settles_done_with_ok_false_and_records_nothing(
    mock_grab, mock_record
):
    """A refusal produced by the arr settles `done` carrying the old body —
    the task ran fine; its PAYLOAD says the grab did not."""
    mock_grab.return_value = {"ok": False, "detail": "HTTP 404: not found"}

    async def scenario():
        started = _start()
        return started, await _await_settled(started["task_id"])

    started, task = asyncio.run(scenario())
    assert task["status"] == "done"
    assert task["ok"] is False
    assert task["detail"] == "HTTP 404: not found"
    mock_record.assert_not_called()
    _forget(started["task_id"])


@patch("application.use_cases.grab_release.record_own_grab")
@patch("application.use_cases.grab_release.arr_grab_release", new_callable=AsyncMock)
def test_an_unexpected_failure_settles_error_with_the_sync_detail(
    mock_grab, mock_record
):
    """A raise out of the worker must not leave a `running` task forever: it
    settles as `Error interno: ...`, exactly what the old handler returned."""
    mock_grab.side_effect = RuntimeError("arr exploded")

    async def scenario():
        started = _start()
        return started, await _await_settled(started["task_id"])

    started, task = asyncio.run(scenario())
    assert task["status"] == "error"
    assert task["ok"] is False
    assert task["detail"] == "Error interno: arr exploded"
    mock_record.assert_not_called()
    _forget(started["task_id"])


@patch("application.use_cases.grab_release.amutorrent_search_link", new_callable=AsyncMock)
@patch("application.use_cases.grab_release.arr_root_folders", new_callable=AsyncMock)
@patch("application.use_cases.grab_release.record_own_grab")
def test_a_foreign_grab_without_a_title_settles_the_old_refusal(
    mock_record, mock_roots, mock_search
):
    """The title check needs the roots, so it moved into the worker — and it
    must settle the same refusal the synchronous handler returned."""
    mock_roots.return_value = [LIBRARY_ROOT]

    async def scenario():
        started = _start(destination=FOREIGN, title="")
        return started, await _await_settled(started["task_id"])

    started, task = asyncio.run(scenario())
    assert task["status"] == "done"
    assert task["ok"] is False
    assert "título" in task["detail"]
    mock_search.assert_not_awaited()
    mock_record.assert_not_called()
    _forget(started["task_id"])


@patch("application.use_cases.grab_release.record_own_grab")
@patch("application.use_cases.grab_release.arr_grab_release", new_callable=AsyncMock)
def test_the_creation_site_tags_the_channel_and_the_settlement_publishes_it(
    mock_grab, mock_record
):
    """T2(a) end to end for grab: the site says `channel="grab"`, and the
    terminal transition publishes exactly that to the SSE bus."""
    mock_grab.return_value = {"ok": True, "detail": "Release encolado"}

    async def scenario():
        queue = event_bus.subscribe()
        try:
            started = _start()
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
