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
  byte: `ok`, `detail`, and `direct` when the download bypasses the arr's
  world entirely — the flow case the honesty suffix names (calendario-directo
  T2 keeps that flag's meaning: a library grab under the arr's watched
  category settles `direct: false` because the arr WILL import it).
  `GET /api/calendar/grab/{task_id}` serves it in the same
  `{"ok": True, **task}` shape `GET /api/tasks/{task_id}` already answers —
  where a settled `ok: false` is a refusal the worker produced, not a failed
  status read (that one carries `error`, and no `status`).
* **A refusal produced inside the worker** (a target the dispatch will not
  recognise, a client that says no) settles as `status="done"` with
  `ok=False`: the task RAN fine, its payload says the grab did not.
* **A failed job settles as `status="error"` with `detail` set to the exact
  string the synchronous handler used to return** (`Error interno: ...`), so
  the frontend's error channel needs no new branch.

Validation that needs no session — unknown service, destination outside the
allowed roots — stays in the route and refuses synchronously, in the old
shape: a request that could never run never gets a job id. Everything the
worker needs arrives as an argument — the session factory, the route's series
lookup, and the DISPATCH included — because that is how this layer stays
testable without an arr in the room.

The grab no longer passes through the arr at all (calendario-directo T2/S2):
the worker dispatches the row's own target by its SHAPE — `ed2k://` → direct
EC, a 32-hex aMule hash → EC `DOWNLOAD_SEARCH_RESULT`, `magnet:`/`http(s)` →
the qBittorrent client — exactly like `POST /api/indexers/download`, whose
`interfaces.http.routes.indexers.dispatch_direct` the route injects here (this
layer may not import `interfaces/`; `AMULE_EC_DIRECT=0` rides along inside the
dispatch as the mandated aMuTorrent rollback). NO link is re-searched — the
row already carries `link`/`guid` — and `arr_grab_release` is gone from this
flow. The client category is chosen by DESTINATION (S3, `category_for`), and
every successful add is recorded with `direct=True` plus the client identity
so `traces`+sweep can join the client's download with no arr history row to
match on.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Awaitable, Callable

from application.gateways import (
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
#: The shape dispatch (`interfaces.http.routes.indexers.dispatch_direct`),
#: handed in for the same reason: one target in, `{ok, detail}` out.
Dispatch = Callable[[str, str | None], Awaitable[dict]]

#: S3: the category our own downloads take when they leave the library — the
#: literal the client bridges use (`infrastructure.qbit_client.DIRECT_DOWNLOAD_
#: CATEGORY`, and `arr_client`'s same-named copy). Replicated here on purpose:
#: this layer may not import an adapter, and the `_inside` precedent says a
#: pure value travels with the code that needs it.
DIRECT_CATEGORY = "flow"


def category_for(source: str, destination: str | None) -> str:
    """The client category for a direct add — chosen by DESTINATION (S3).

    `destination is None` is the library: the add takes the category the arr
    WATCHES in qBittorrent, literal per source — `radarr` for Radarr,
    `tv-sonarr` for Sonarr — so the arr imports and organises as before
    (Step 6: the arrs are file maintenance, never search/grab). An explicit
    destination (4K/3D/out-of-library) leaves the library: `flow`, our own
    category the arr never polls, and the copy to the destination is the
    sweep's job via `own_grabs(direct=True, destination)`. Only radarr/sonarr
    reach this function: both routes gate on `find_service(source, "arr")`.
    """
    if destination is not None:
        return DIRECT_CATEGORY
    return "radarr" if source == "radarr" else "tv-sonarr"


def start_grab(
    source: str,
    service: dict,
    *,
    destination: str | None = None,
    guid: str,
    link: str = "",
    indexer_id: int = 0,
    movie_id: int = 0,
    episode_id: int = 0,
    quality: str = "",
    title: str = "",
    session_factory: SessionFactory,
    resolve_series: ResolveSeries,
    dispatch: Dispatch,
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
            link=link,
            indexer_id=indexer_id,
            movie_id=movie_id,
            episode_id=episode_id,
            quality=quality,
            title=title,
            session_factory=session_factory,
            resolve_series=resolve_series,
            dispatch=dispatch,
        )
    )
    return {
        "ok": True,
        "task_id": task_id,
        "status": "running",
        "detail": "Descarga lanzada",
    }


async def run_grab(
    task_id: str,
    source: str,
    service: dict,
    *,
    destination: str | None = None,
    guid: str,
    link: str = "",
    indexer_id: int = 0,
    movie_id: int = 0,
    episode_id: int = 0,
    quality: str = "",
    title: str = "",
    session_factory: SessionFactory,
    resolve_series: ResolveSeries,
    dispatch: Dispatch,
) -> None:
    """The worker: dispatch, record, settle. Never raises.

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
        # to the arr the grab relates to, so a second session would only add
        # another connection. `resolve_series` cannot raise, so a failed
        # lookup can never turn a successful grab into the error settle.
        async with session_factory() as session:
            # S2: the row already carries its link — the target is `link or
            # guid` (the `link ?? guid` precedent) and it is dispatched by
            # SHAPE, exactly like `POST /api/indexers/download`: ed2k → direct
            # EC, 32-hex aMule hash → EC `DOWNLOAD_SEARCH_RESULT`,
            # magnet/http(s) → the qBittorrent client. No search, no resolve,
            # no arr — and the client category is chosen by destination (S3).
            target = link or guid
            added = await dispatch(target, category_for(source, destination))
            if added.get("ok"):
                # `direct` in the PAYLOAD keeps its old meaning: the download
                # bypasses the arr's world entirely and the arr will neither
                # see nor import it — exactly the flow case the honesty suffix
                # names. The REGISTRY row is `direct=True` for EVERY add in
                # this flow (S2: none of them rides `arr_grab_release`), and it
                # carries the client identity so `traces`+sweep can join the
                # client's download with no arr history row to match on.
                direct = destination is not None
                client_name, client_hash = direct_link_identity(target, title)
                series_id = (
                    await resolve_series(session, service, source, episode_id)
                    if episode_id
                    else None
                )
                detail = added.get("detail", "")
                if direct:
                    detail += " — directa: el arr no la verá ni la importará"
                result = {"ok": True, "detail": detail}
                if direct:
                    result["direct"] = True
            else:
                # A dispatch refusal travels VERBATIM as `{ok: False, detail}`
                # — the honest `_BAD_SCHEME`-style answer of the dispatch («no
                # se envió nada»). The task RAN fine; its payload says the grab
                # did not.
                result = {
                    "ok": False,
                    "detail": added.get("detail") or "no se pudo despachar la descarga",
                }
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
    # rather than a bogus id. `direct=True` on every success (S2: this flow
    # adds to the client itself, so no arr grab-history row will ever exist).
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
            direct=True,
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
