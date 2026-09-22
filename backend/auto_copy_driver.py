"""Driver for one auto-copy sweep.

The policy lives in ``auto_copy.py`` and stays pure; this module is where the
I/O lives: the traces the app already computes, the own-grab registry, the arr
probe, the durable idempotency marker and the copy engine.

The trigger is deliberate: an explicit ``POST /api/auto-copy/sweep`` (see
``routes/auto_copy.py``), never a background loop and never a side effect of the
``GET /api/trace`` the UI polls every 15 s. Copying into the library is a
mutation, so it must be an explicit action: hooking the polled GET would turn a
read into a write and make two open tabs two sweeps. Unattended operation is the
user's external timer (cron/systemd) calling that endpoint.
"""

import asyncio
import logging
import time

from auto_copy import (
    COPY,
    DEFAULT_GRACE_SECONDS,
    SKIP,
    UNIDENTIFIED,
    WAIT,
    auto_copy_key,
    decide_copy,
    matches_own_grab,
)
from clients import arr_has_file
from config import find_service
from copy_engine import do_action
from history import (
    DECISION_ACTIONED,
    is_auto_copy_handled,
    list_own_grabs,
    mark_auto_copy,
    note_auto_copy_seen,
)
from traces import build_traces

log = logging.getLogger("flow-controller")

#: Stored decision labels the driver writes for the outcomes that are NOT an
#: action taken. history.py owns `DECISION_ACTIONED` (the only value its reader
#: counts); these two live here because they describe what the driver did.
PROPOSED_DECISION = "proposed"
FAILED_DECISION = "dispatch_failed"

#: How far back the own-grab registry is read. A trace's `date` is fixed at the
#: arr's grab instant, so a grab we launched can still match a live trace hours
#: later; the lookback only has to outlive the traces we still see. Traces are
#: capped per arr (TRACE_LIMIT), so anything older has already fallen off the
#: list this sweep can act on.
OWN_GRAB_LOOKBACK_SECONDS = 30 * 24 * 3600.0

#: Upper bound on registry rows loaded per sweep. The registry is small (one row
#: per grab the user made from the app) and the lookback above already bounds it.
OWN_GRAB_LIMIT = 500

#: Stages whose trace can still reach a COPY decision. Used to decide whether an
#: arr `has_file` probe is worth a request (see `_arr_probe`).
_ACTIONABLE_STAGES = frozenset({"import_blocked", "downloaded"})

#: The shared sentinel suffix `auto_copy_key` returns for a trace with no
#: identifier at all. Every such trace shares it, so a marker built from it would
#: block unrelated downloads; these traces are skipped without reading or
#: writing a marker.
_UNIDENTIFIED_SUFFIX = f":title:{UNIDENTIFIED}"


def _grace_relevant(stage: str | None, trace: dict) -> bool:
    """Whether the grace window can decide this trace's outcome.

    Only two branches of the policy call the grace gate: `downloaded` and
    `import_blocked` WITHOUT an import warning. Every other stage resolves before
    it (a warning copies at once; an in-progress or failed download resolves
    earlier), so persisting a first-seen reference for them would only fill the
    table with rows nothing ever reads.
    """
    if stage == "downloaded":
        return True
    if stage == "import_blocked":
        queue = trace.get("queue") or {}
        return queue.get("status") != "warning"
    return False


#: One sweep at a time. Two concurrent triggers must not both dispatch: the
#: marker protects against a later sweep, not against a second copy racing the
#: first. The lock is module-level so every caller shares it; a second caller
#: gets an honest "already running" result instead of being queued behind the
#: first.
_sweep_lock = asyncio.Lock()


def _zero_counts() -> dict:
    return {
        "traces": 0,
        "copy": 0,
        "copied": 0,
        "proposed": 0,
        "wait": 0,
        "skip": 0,
        "failed": 0,
    }


def _entry(
    key: str,
    source: str,
    title: str,
    decision: str,
    reason: str,
    *,
    action: str | None = None,
    detail: str | None = None,
) -> dict:
    """One per-trace line of the summary. `reason` is user-facing (Spanish)."""
    return {
        "key": key,
        "source": source,
        "title": title,
        "decision": decision,
        "reason": reason,
        "action": action,
        "detail": detail,
    }


def _summary(
    *,
    ok: bool,
    running: bool,
    safe_mode: bool | None,
    counts: dict,
    entries: list[dict],
    errors: list[str],
    detail: str = "",
    started_at: int | None = None,
) -> dict:
    return {
        "ok": ok,
        "running": running,
        "safe_mode": safe_mode,
        "detail": detail,
        "counts": counts,
        "entries": entries,
        "errors": errors,
        "started_at": started_at,
        "finished_at": int(time.time()),
    }


def _already_running(safe_mode: bool) -> dict:
    """Honest refusal when a sweep is in flight: no queueing, no second run."""
    return _summary(
        ok=False,
        running=True,
        safe_mode=safe_mode,
        counts=_zero_counts(),
        entries=[],
        errors=[],
        detail="ya hay un barrido en curso",
    )


async def sweep(
    session,
    *,
    now: float | None = None,
    safe_mode: bool,
    grace_seconds: float | None = None,
) -> dict:
    """Run ONE sweep over the current traces and return its summary.

    Single-flight: a second concurrent call returns immediately with
    ``running=True`` instead of queueing. Never raises: an unavailable database
    or arr degrades to empty inputs and unknown answers, which the policy turns
    into "do not act", and the summary says so.
    """
    if _sweep_lock.locked():
        return _already_running(safe_mode)
    # No await between the check and the acquire, and an uncontended
    # `Lock.acquire()` does not yield, so this pair is atomic in asyncio.
    await _sweep_lock.acquire()
    try:
        return await _run_sweep(
            session, now=now, safe_mode=safe_mode, grace_seconds=grace_seconds
        )
    finally:
        _sweep_lock.release()


async def _run_sweep(
    session,
    *,
    now: float | None,
    safe_mode: bool,
    grace_seconds: float | None,
) -> dict:
    started = time.time()
    current = time.time() if now is None else now
    grace = DEFAULT_GRACE_SECONDS if grace_seconds is None else grace_seconds
    counts = _zero_counts()
    entries: list[dict] = []
    errors: list[str] = []

    try:
        traces = await build_traces(session)
    except Exception as exc:  # noqa: BLE001 — the endpoint must never 500
        log.warning("auto-copy sweep: no se pudieron obtener las trazas: %s", exc)
        return _summary(
            ok=False,
            running=False,
            safe_mode=safe_mode,
            counts=counts,
            entries=entries,
            errors=[f"fallo al obtener las trazas: {type(exc).__name__}: {exc}"],
            detail="no se pudieron obtener las trazas",
            started_at=int(started),
        )

    counts["traces"] = len(traces)
    # An unavailable registry degrades to []: nothing is provably ours, so the
    # policy skips instead of copying on a guess.
    own_grabs = list_own_grabs(current - OWN_GRAB_LOOKBACK_SECONDS, limit=OWN_GRAB_LIMIT)

    for trace in traces:
        try:
            entry = await _handle_trace(
                session,
                trace,
                own_grabs=own_grabs,
                now=current,
                safe_mode=safe_mode,
                grace_seconds=grace,
            )
        except Exception as exc:  # noqa: BLE001 — one bad trace must not abort
            label = trace.get("title") or trace.get("download_id") or "?"
            log.exception("auto-copy sweep: la traza %s falló", label)
            errors.append(f"traza {label}: {type(exc).__name__}: {exc}")
            continue
        entries.append(entry)
        if entry["decision"] in counts:
            counts[entry["decision"]] += 1
        if entry["action"] == "copied":
            counts["copied"] += 1
        elif entry["action"] == "proposed":
            counts["proposed"] += 1
        elif entry["action"] == "failed":
            counts["failed"] += 1

    return _summary(
        ok=True,
        running=False,
        safe_mode=safe_mode,
        counts=counts,
        entries=entries,
        errors=errors,
        detail="",
        started_at=int(started),
    )


async def _handle_trace(
    session,
    trace: dict,
    *,
    own_grabs: list[dict],
    now: float,
    safe_mode: bool,
    grace_seconds: float,
) -> dict:
    source = trace.get("source") or ""
    title = trace.get("title") or ""
    key = auto_copy_key(trace)

    if key.endswith(_UNIDENTIFIED_SUFFIX):
        # Shared sentinel: never touch it. A marker here would suppress every
        # other unidentified download, and no decision about this trace is
        # trustworthy anyway.
        return _entry(
            key, source, title, SKIP, "sin identificador de descarga: no se actúa"
        )

    is_own = matches_own_grab(trace, own_grabs)
    already = is_auto_copy_handled(key)
    stage = trace.get("stage")

    # Ask the arr only when the answer can change the outcome. A probe per trace
    # per sweep would be one request per trace; asking only for a plausibly
    # actionable one (ours, not already handled, a stage that can lead to a
    # copy) keeps the sweep cheap. `None` means "unknown", and the policy treats
    # that as unknown, never as "no file", so gating this is safe by design.
    has_file = None
    if is_own and not already and stage in _ACTIONABLE_STAGES:
        has_file = await _arr_probe(session, trace)

    # The reference the grace window is measured from. The trace does not carry
    # the instant the current condition was first observed, and its only
    # timestamp — the grab `date` — predates the download, so deriving it from
    # the trace would start the clock before completion and race the arr (exactly
    # what T3 warned against). We persist our own first-sighting instead. Only
    # the grace-gated stages need it, and only when this trace is actually ours
    # and not yet handled: for anything else the policy resolves before the gate,
    # so a row would be pure noise. `note_auto_copy_seen` returns the STORED
    # instant when the key was already seen in the same stage, which is what lets
    # a later sweep observe the window elapse.
    since = None
    if is_own and not already and _grace_relevant(stage, trace):
        since = note_auto_copy_seen(key, stage)

    decision = decide_copy(
        trace,
        now=now,
        since=since,
        grace_seconds=grace_seconds,
        already_handled=already,
        is_own_grab=is_own,
        arr_has_file=has_file,
    )
    result = decision["decision"]
    reason = decision["reason"]

    if result in (WAIT, SKIP):
        # Nothing durable. WAIT is transient (the arr may resolve it on its own)
        # and SKIP would freeze a condition that may change (a warning that
        # clears, a marker another path adds). A row here would be noise.
        return _entry(key, source, title, result, reason)

    # result == COPY.
    if safe_mode:
        # Record the proposal and touch nothing: safe mode means "detect and
        # propose". The marker is written with the non-actioned label so it can
        # never block a later sweep that runs with safe mode off.
        mark_auto_copy(
            key, source=source, title=title, decision=PROPOSED_DECISION, reason=reason
        )
        return _entry(key, source, title, result, reason, action="proposed")

    return await _dispatch(session, trace, key, source, title, reason)


async def _arr_probe(session, trace: dict) -> bool | None:
    """Ask the arr whether it already has this item; `None` on any doubt.

    `arr_has_file` already degrades internally to `None`; the try/except here is
    a second belt so one malformed trace cannot abort the whole sweep.
    """
    service = find_service(trace.get("source") or "", "arr")
    if not service:
        return None
    ids = trace.get("ids") or {}
    try:
        return await arr_has_file(
            session,
            service,
            movie_id=ids.get("movie_id"),
            episode_id=ids.get("episode_id"),
        )
    except Exception as exc:  # noqa: BLE001 — unknown, never "no file"
        log.warning("auto-copy sweep: la sonda has_file falló: %s", exc)
        return None


async def _dispatch(
    session,
    trace: dict,
    key: str,
    source: str,
    title: str,
    reason: str,
) -> dict:
    torrent = trace.get("torrent") or {}
    output_path = torrent.get("content_path")
    if not output_path:
        detail = "la traza no trae la ruta del contenido"
        mark_auto_copy(
            key, source=source, title=title, decision=FAILED_DECISION, reason=detail
        )
        return _entry(key, source, title, COPY, reason, action="failed", detail=detail)

    payload = {
        "source": source,
        "ids": trace.get("ids") or {},
        "output_path": output_path,
    }

    # Claim before acting: persist the marker FIRST, then dispatch. If the
    # process dies mid-copy the marker already blocks a second sweep; the
    # claim's cost is that a crash before the copy completes is at-most-once,
    # never a duplicate into the library.
    mark_auto_copy(
        key, source=source, title=title, decision=DECISION_ACTIONED, reason=reason
    )

    try:
        result = await do_action(session, "copy_files", payload)
    except Exception as exc:  # noqa: BLE001 — a failure must stay retryable
        detail = f"{type(exc).__name__}: {exc}"
        mark_auto_copy(
            key, source=source, title=title, decision=FAILED_DECISION, reason=detail
        )
        return _entry(key, source, title, COPY, reason, action="failed", detail=detail)

    if not result.get("ok"):
        detail = _first_detail(result) or "el motor de copia devolvió un error"
        # Downgrade the claim so the next sweep may retry. `FAILED_DECISION` is
        # not counted as handled by `is_auto_copy_handled`.
        mark_auto_copy(
            key, source=source, title=title, decision=FAILED_DECISION, reason=detail
        )
        return _entry(key, source, title, COPY, reason, action="failed", detail=detail)

    return _entry(
        key,
        source,
        title,
        COPY,
        reason,
        action="copied",
        detail=result.get("dst_path") or result.get("task_id"),
    )


def _first_detail(result: dict) -> str:
    """Best available reason from a `do_action` failure shape."""
    detail = result.get("detail")
    if detail:
        return str(detail)
    for step in result.get("steps") or []:
        if step.get("detail"):
            return str(step["detail"])
    return ""
