"""The release search as a background job — C-10.

The synchronous `POST /api/calendar/releases` awaited a Radarr × 20-indexer
search measured at 91.6 s against a reverse proxy that cuts at ~60 s: the 504
of 2026-10-07 was masked once by raising `proxy_read_timeout` to 250 s by hand
in nginx. The fix is the machinery this app already has — a `TaskManager`
registry (the same class behind `copy_tasks` and `mux_tasks`) plus
`asyncio.create_task` — so the POST answers in milliseconds with a task id and
the proxy's latency stops mattering.

S1 (calendario-directo): the job asks an injected fetcher over our own
sources, never the arr.

The contracts that must not move:

* **The payload of a finished job is the old synchronous response**, byte for
  byte: `releases` and `detail`. `GET /api/calendar/releases/{task_id}` serves
  it in the same `{"ok": True, **task}` shape `GET /api/tasks/{task_id}` already answers.
* **A failed job settles as `status="error"` with `detail` set to the exact
  string the synchronous handler used to return** (`Error interno: ...`), so
  the frontend's error channel needs no new branch.

Everything the job needs arrives as an argument — the query and the fetcher
included — because that is how this layer stays testable without an arr in
the room.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Awaitable, Callable

from task_manager import TaskManager

log = logging.getLogger("flow-controller")

#: One registry for release searches: its own `TaskManager` instance (the same
#: class copy_engine and media_mixer share) so a copy task id can never collide
#: with a search id, and the copy endpoint never has to serve search payloads.
release_tasks = TaskManager(ttl=600)

#: The injected fan-out over our own sources (S1): one query in, the
#: `{ok, releases, detail}` answer out — the route's `_direct_release_fetch`
#: owns the row shape, this layer only carries it.
Fetcher = Callable[[str], Awaitable[dict]]


def start_release_search(
    source: str,
    req_type: str,
    req_id: int,
    *,
    query: str,
    fetcher: Fetcher,
) -> dict:
    """Register the job, schedule the worker, and answer immediately.

    This whole function is the C-10 fix: no arr call, no session, nothing to
    wait for — the response carries the task id the status endpoint collects
    under. The query (the item's title) travels to the worker verbatim; the
    route owns any trimming, the job never rewrites the search text.
    """
    task_id = str(uuid.uuid4())
    release_tasks.create(
        task_id,
        channel="release",
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
            req_type,
            req_id,
            query=query,
            fetcher=fetcher,
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
    req_type: str,
    req_id: int,
    *,
    query: str,
    fetcher: Fetcher,
) -> None:
    """The worker: ask OUR sources through the fetcher, settle the task. Never raises.

    A raise out of here would die as an unhandled task exception and leave the
    poller waiting on a `running` task forever, so every failure settles as
    `status="error"` with the exact detail the synchronous handler returned.
    An answered fan-out where every source failed is an ERROR settle carrying
    its reasons — never `releases: []` dressed as «sin resultados» (S1).
    """
    try:
        if req_type not in ("movie", "episode"):
            # The route validates before starting; this keeps the use case
            # honest when it is driven from somewhere else.
            raise ValueError(f"Tipo desconocido: {req_type}")
        result = await fetcher(query)
        if not result.get("ok"):
            release_tasks.update(
                task_id,
                status="error",
                detail=result.get("detail") or "La búsqueda en nuestras fuentes no respondió",
                releases=[],
            )
        else:
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
