"""The release search as a background job — C-10.

The synchronous `POST /api/calendar/releases` awaited a Radarr × 20-indexer
search measured at 91.6 s against a reverse proxy that cuts at ~60 s: the 504
of 2026-10-07 was masked once by raising `proxy_read_timeout` to 250 s by hand
in nginx. The fix is the machinery this app already has — a `TaskManager`
registry (the same class behind `copy_tasks` and `mux_tasks`) plus
`asyncio.create_task` — so the POST answers in milliseconds with a task id and
the proxy's latency stops mattering.

The contracts that must not move:

* **The payload of a finished job is the old synchronous response**, byte for
  byte: `releases` (enriched with `indexerId` by the route's injected `enrich`)
  and `detail`. `GET /api/calendar/releases/{task_id}` serves it in the same
  `{"ok": True, **task}` shape `GET /api/tasks/{task_id}` already answers.
* **A failed job settles as `status="error"` with `detail` set to the exact
  string the synchronous handler used to return** (`Error interno: ...`), so
  the frontend's error channel needs no new branch.

Everything the job needs arrives as an argument — the session factory and the
indexer enrichment included — because that is how this layer stays testable
without an arr in the room.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Awaitable, Callable

from application.gateways import arr_fetch_releases
from task_manager import TaskManager

log = logging.getLogger("flow-controller")

#: One registry for release searches: its own `TaskManager` instance (the same
#: class copy_engine and media_mixer share) so a copy task id can never collide
#: with a search id, and the copy endpoint never has to serve search payloads.
release_tasks = TaskManager(ttl=600)

#: The route's indexer enrichment, injected: the name→id cache it reads also
#: serves `GET /api/calendar/indexers`, which lives in the route module.
Enrich = Callable[[dict], Awaitable[dict]]
#: `state.http_session`, handed in so this layer never imports delivery state.
SessionFactory = Callable[[], Any]


def start_release_search(
    source: str,
    service: dict,
    req_type: str,
    req_id: int,
    *,
    session_factory: SessionFactory,
    enrich: Enrich,
) -> dict:
    """Register the job, schedule the worker, and answer immediately.

    This whole function is the C-10 fix: no arr call, no session, nothing to
    wait for — the response carries the task id the status endpoint collects
    under.
    """
    task_id = str(uuid.uuid4())
    release_tasks.create(
        task_id,
        status="running",
        source=source,
        req_type=req_type,
        req_id=req_id,
        detail="Búsqueda de releases lanzada",
    )
    asyncio.create_task(
        run_release_search(
            task_id,
            source,
            service,
            req_type,
            req_id,
            session_factory=session_factory,
            enrich=enrich,
        )
    )
    return {
        "ok": True,
        "task_id": task_id,
        "status": "running",
        "detail": "Búsqueda de releases lanzada",
    }


async def run_release_search(
    task_id: str,
    source: str,
    service: dict,
    req_type: str,
    req_id: int,
    *,
    session_factory: SessionFactory,
    enrich: Enrich,
) -> None:
    """The worker: ask the arr, enrich, settle the task. Never raises.

    A raise out of here would die as an unhandled task exception and leave the
    poller waiting on a `running` task forever, so every failure settles as
    `status="error"` with the exact detail the synchronous handler returned.
    """
    try:
        if req_type == "movie":
            kwargs = {"movie_id": req_id}
        elif req_type == "episode":
            kwargs = {"episode_id": req_id}
        else:
            # The route validates before starting; this keeps the use case
            # honest when it is driven from somewhere else.
            raise ValueError(f"Tipo desconocido: {req_type}")
        async with session_factory() as session:
            result = await arr_fetch_releases(session, service, **kwargs)
        result = await enrich(result)
        release_tasks.update(
            task_id,
            status="done",
            detail=result.get("detail", ""),
            releases=result.get("releases", []),
        )
    except Exception as exc:
        log.exception("release_search job %s (%s) error: %s", task_id, source, exc)
        release_tasks.update(
            task_id,
            status="error",
            detail=f"Error interno: {exc}",
            releases=[],
        )
