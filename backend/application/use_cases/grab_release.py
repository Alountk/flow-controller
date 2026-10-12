"""The grab as a background job — async-grab.

The synchronous `POST /api/calendar/grab` awaited the whole chain inline —
the ED2K resolve alone measures 30-60 s server-side against a reverse proxy
that cuts at ~60 s, so the request died as a 504 while the download was
already on its way to the client (the class of timeouts #193's ×12 only
bandaged). The fix is the machinery C-10 already proved: a `TaskManager`
registry of its own plus `asyncio.create_task`, so the POST answers in
milliseconds with a task id and the proxy's latency stops mattering.

The contracts that must not move:

* **The payload of a finished job is the old synchronous response**, byte for
  byte: `ok`, `detail`, and `direct` when the download bypassed the arr.
  `GET /api/calendar/grab/{task_id}` serves it in the same
  `{"ok": True, **task}` shape `GET /api/tasks/{task_id}` already answers —
  where a settled `ok: false` is a refusal the worker produced, not a failed
  status read (that one carries `error`, and no `status`).
* **A refusal produced inside the worker** (missing title, a link the
  indexer will not resolve, a client that says no) settles as
  `status="done"` with `ok=False`: the task RAN fine, its payload says the
  grab did not.
* **A failed job settles as `status="error"` with `detail` set to the exact
  string the synchronous handler used to return** (`Error interno: ...`), so
  the frontend's error channel needs no new branch.

Validation that needs no session — unknown service, destination outside the
allowed roots — stays in the route and refuses synchronously, in the old
shape: a request that could never run never gets a job id. Everything the
worker needs arrives as an argument — the session factory and the route's
series lookup included — because that is how this layer stays testable
without an arr in the room.
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from typing import Any, Awaitable, Callable

from application.gateways import (
    amutorrent_add_download,
    amutorrent_search_link,
    arr_grab_release,
    arr_root_folders,
    direct_link_identity,
    record_own_grab,
)
from task_manager import TaskManager

log = logging.getLogger("flow-controller")

#: One registry for grabs: its own `TaskManager` instance (the same class
#: copy_engine, media_mixer and release_search share) so a grab task id can
#: never collide with a copy or search id, and none of those endpoints ever
#: has to serve a grab payload.
grab_tasks = TaskManager(ttl=600)

#: `state.http_session`, handed in so this layer never imports delivery state.
SessionFactory = Callable[[], Any]
#: The route's `_resolve_series_id`, handed in for the same reason: it lives
#: in the delivery module the synchronous batch route also uses.
ResolveSeries = Callable[..., Awaitable[int | None]]


def start_grab(
    source: str,
    service: dict,
    *,
    destination: str | None = None,
    guid: str,
    indexer_id: int = 0,
    movie_id: int = 0,
    episode_id: int = 0,
    quality: str = "",
    title: str = "",
    size: int = 0,
    session_factory: SessionFactory,
    resolve_series: ResolveSeries,
) -> dict:
    """Register the job, schedule the worker, and answer immediately.

    This whole function is the async-grab fix: no session, no roots, no arr
    call, nothing to wait for — the response carries the task id the status
    endpoint collects under.
    """
    task_id = str(uuid.uuid4())
    grab_tasks.create(
        task_id,
        channel="grab",
        status="running",
        detail="Descarga lanzada",
    )
    asyncio.create_task(
        run_grab(
            task_id,
            source,
            service,
            destination=destination,
            guid=guid,
            indexer_id=indexer_id,
            movie_id=movie_id,
            episode_id=episode_id,
            quality=quality,
            title=title,
            size=size,
            session_factory=session_factory,
            resolve_series=resolve_series,
        )
    )
    return {
        "ok": True,
        "task_id": task_id,
        "status": "running",
        "detail": "Descarga lanzada",
    }


def _inside(path: str, root: str) -> bool:
    """`path` is `root` or below it, without the `/a/b`-matches-`/a/bc` trap.

    The same rule the calendar route and sweep_downloads each keep: a layer
    may not import a delivery module's helper, so the pure predicate travels
    with the code that needs it.
    """
    normalized_path = os.path.normpath(path)
    normalized_root = os.path.normpath(root)
    return normalized_path == normalized_root or normalized_path.startswith(
        normalized_root.rstrip("/") + "/"
    )


async def run_grab(
    task_id: str,
    source: str,
    service: dict,
    *,
    destination: str | None = None,
    guid: str,
    indexer_id: int = 0,
    movie_id: int = 0,
    episode_id: int = 0,
    quality: str = "",
    title: str = "",
    size: int = 0,
    session_factory: SessionFactory,
    resolve_series: ResolveSeries,
) -> None:
    """The worker: gate, route, grab, record, settle. Never raises.

    A raise out of here would die as an unhandled task exception and leave
    the poller waiting on a `running` task forever, so every failure settles
    as `status="error"` with the exact detail the synchronous handler
    returned.
    """
    direct = False
    client_name = ""
    client_hash = None
    series_id = None
    try:
        # The series lookup rides the grab's own session: it is a single GET
        # to the arr the grab just hits, so a second session would only add
        # another connection. `resolve_series` cannot raise, so a failed
        # lookup can never turn a successful grab into the error settle.
        async with session_factory() as session:
            # A destination OUTSIDE every arr root means the file is leaving
            # the library — and if the download goes through the arr, the arr
            # imports it on completion and REPLACES what the library already
            # holds (the 4K-cannibalises-the-1080p incident). Such a download
            # never touches the arr: straight to the client, our own category.
            # Fails closed: an unreadable root list proves nothing, so the
            # grab stays on the arr path it has always taken.
            foreign = False
            if destination is not None:
                roots = await arr_root_folders(session, service)
                foreign = bool(roots) and not any(
                    _inside(destination, root) for root in roots
                )

            if foreign:
                if not title:
                    result = {
                        "ok": False,
                        "detail": "Falta el título del release para resolver el enlace directo",
                    }
                else:
                    resolved = await amutorrent_search_link(
                        session, title, guid=guid, size=size
                    )
                    if not resolved.get("ok"):
                        # No search, no add, nothing sent to the arr: the
                        # refusal says which of the three reasons it was
                        # (other indexer, no answer, no match) and what to do
                        # instead.
                        result = {
                            "ok": False,
                            "detail": resolved.get("detail") or "no se pudo resolver el enlace",
                        }
                    else:
                        link = resolved["link"]
                        added = await amutorrent_add_download(session, link)
                        if not added.get("ok"):
                            result = {
                                "ok": False,
                                "detail": f"aMuTorrent no aceptó la descarga: {added.get('detail')}",
                            }
                        else:
                            direct = True
                            client_name, client_hash = direct_link_identity(link, title)
                            series_id = (
                                await resolve_series(session, service, source, episode_id)
                                if episode_id
                                else None
                            )
                            result = {
                                "ok": True,
                                "detail": f"{added.get('detail')} — directa: el arr no la verá ni la importará",
                                "direct": True,
                            }
            else:
                result = await arr_grab_release(
                    session, service, guid, indexer_id, movie_id, episode_id
                )
                series_id = (
                    await resolve_series(session, service, source, episode_id)
                    if result.get("ok")
                    else None
                )
    except Exception as exc:
        log.exception("grab job %s (%s) error: %s", task_id, source, exc)
        grab_tasks.update(
            task_id,
            status="error",
            ok=False,
            detail=f"Error interno: {exc}",
            direct=False,
        )
        return

    # Only a grab that actually succeeded enters the own-grab registry (D3),
    # and the recording is best-effort: `record_own_grab` never raises, so it
    # stays outside any try that could fail the task — a row that cannot be
    # written must not change the outcome the operator is waiting on. `0` is
    # the request's "not this kind of title" default, so it becomes NULL
    # rather than a bogus id.
    if result.get("ok"):
        await asyncio.to_thread(
            record_own_grab,
            source,
            movie_id=movie_id or None,
            episode_id=episode_id or None,
            series_id=series_id,
            guid=guid,
            indexer_id=indexer_id,
            destination=destination,
            quality=quality or None,
            direct=direct,
            client_name=client_name,
            client_hash=client_hash,
        )
    grab_tasks.update(
        task_id,
        status="done",
        ok=bool(result.get("ok")),
        detail=result.get("detail", ""),
        direct=bool(result.get("direct", False)),
    )
