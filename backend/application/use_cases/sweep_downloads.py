"""Decide what to do with every download the app grabbed, and do it.

One sweep over the live traces: for each, ask the pure policy in
`domain.policy` what should happen, then either leave it alone or put it where
it belongs. The sweep is the app's whole reason to exist as a daemon-shaped
thing, and it is written here as a use case so it can be asked that question
without an arr, a database or a filesystem in the room.

Everything it needs arrives as an argument — the traces, the record of its own
grabs, one question for the arr, the roots the arr manages, and the thing that
actually moves files. None of those are imports. That is not decoration: the
suite fakes all of them by name and this is what makes that mean something.

Two contracts worth stating because breaking either would be quiet and bad:

* **Never raises.** An unavailable database or a down arr degrades to empty
  inputs and unknown answers, which the policy turns into "do not act", and the
  summary says so. An endpoint that 500s because qBittorrent blinked is worse
  than one that reports it could not look.
* **One sweep at a time.** The marker protects against a later sweep, not
  against a second copy racing the first, so concurrency is refused honestly
  rather than queued.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Awaitable, Callable

from application.ports import ActionDispatcher, ArrProbe, ArrRoots, OwnGrabStore, TraceLoader

#: Judge one trace and return its summary line.
TraceHandler = Callable[..., Awaitable[dict]]
from domain.policy import (
    COPY,
    DEFAULT_GRACE_SECONDS,
    SKIP,
    UNIDENTIFIED,
    WAIT,
    auto_copy_key,
    decide_copy,
    find_own_grab,
    matches_own_grab,
)

log = logging.getLogger("flow-controller")

#: Stored decision labels for the outcomes that are NOT an action taken.
#: `history.DECISION_ACTIONED` is the only value its reader counts; these two
#: are here because they describe what the sweep did, and the composition root
#: injects the third so this module never learns that a table exists.
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
#: arr `has_file` probe is worth a request.
_ACTIONABLE_STAGES = frozenset({"import_blocked", "downloaded"})

#: The shared sentinel suffix `auto_copy_key` returns for a trace with no
#: identifier at all. Every such trace shares it, so a marker built from it
#: would block unrelated downloads; these traces are skipped without reading or
#: writing a marker.
_UNIDENTIFIED_SUFFIX = f":title:{UNIDENTIFIED}"

#: One sweep at a time. Two concurrent triggers must not both dispatch: the
#: marker protects against a later sweep, not against a second copy racing the
#: first. Module-level so every caller shares it; a second caller gets an
#: honest "already running" result instead of being queued behind the first.
_sweep_lock = asyncio.Lock()


def _grace_relevant(stage: str | None, trace: dict) -> bool:
    """Whether the grace window can decide this trace's outcome.

    Only two branches of the policy call the grace gate: `downloaded` and
    `import_blocked` WITHOUT an import warning. Every other stage resolves
    before it (a warning copies at once; an in-progress or failed download
    resolves earlier), so persisting a first-seen reference for them would only
    fill the table with rows nothing ever reads.
    """
    if stage == "downloaded":
        return True
    if stage == "import_blocked":
        queue = trace.get("queue") or {}
        return queue.get("status") != "warning"
    return False


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


def _inside(path: str, root: str) -> bool:
    """`path` is `root` itself or lies under it — compared by component.

    A bare ``startswith`` would file ``/movies-4k`` under ``/movies``, which is
    precisely the pair this feature tells apart.
    """
    candidate = os.path.normpath(path or "")
    base = os.path.normpath(root or "")
    if not base or base == os.curdir:
        return False
    return candidate == base or candidate.startswith(base + os.sep)


def _first_detail(result: dict) -> str:
    """Best available reason from a `do_action` failure shape."""
    detail = result.get("detail")
    if detail:
        return str(detail)
    for step in result.get("steps") or []:
        if step.get("detail"):
            return str(step["detail"])
    return ""


class SweepDownloads:
    """One auto-copy sweep, with everything it touches handed to it."""

    def __init__(
        self,
        *,
        traces: TraceLoader,
        own_grabs: OwnGrabStore,
        arr_probe: ArrProbe,
        arr_roots: ArrRoots,
        dispatch: ActionDispatcher,
        handle_trace: TraceHandler,
        actioned_decision: str,
    ) -> None:
        self._traces = traces
        self._grabs = own_grabs
        self._arr_probe = arr_probe
        self._arr_roots = arr_roots
        self._dispatch = dispatch
        self._handler = handle_trace
        self._actioned = actioned_decision

    async def run(
        self,
        session,
        *,
        now: float | None = None,
        safe_mode: bool,
        grace_seconds: float | None = None,
    ) -> dict:
        """Run ONE sweep over the current traces and return its summary.

        Single-flight: a second concurrent call returns immediately with
        ``running=True`` instead of queueing. Never raises.
        """
        if _sweep_lock.locked():
            return _already_running(safe_mode)
        # No await between the check and the acquire, and an uncontended
        # `Lock.acquire()` does not yield, so this pair is atomic in asyncio.
        await _sweep_lock.acquire()
        try:
            return await self._run(
                session, now=now, safe_mode=safe_mode, grace_seconds=grace_seconds
            )
        finally:
            _sweep_lock.release()

    async def _run(
        self,
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
            traces = await self._traces(session)
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
        # An unavailable registry degrades to []: nothing is provably ours, so
        # the policy skips instead of copying on a guess.
        own_grabs = self._grabs.list_own_grabs(
            current - OWN_GRAB_LOOKBACK_SECONDS, limit=OWN_GRAB_LIMIT
        )
        # The last logged outcome per key, read in ONE grouped query for the
        # whole sweep. The transition log below only appends when this differs.
        last_outcomes = self._grabs.latest_auto_copy_decisions()

        # ONE arr round trip for the whole sweep, and only if some grab actually
        # carries a destination. Resolved once because root folders do not move
        # between two traces of the same sweep, and because every trace has to
        # be judged against the same list — judging them against different
        # answers would make the gate's behaviour depend on loop order.
        foreign_destinations = await self._foreign_destinations(session, own_grabs)

        for trace in traces:
            try:
                entry = await self._handler(
                    session,
                    trace,
                    own_grabs=own_grabs,
                    foreign_destinations=foreign_destinations,
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
            self._log_outcome(entry, last_outcomes)

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

    def _log_outcome(self, entry: dict, last_outcomes: dict[str, str]) -> None:
        """Append one history row when this trace's outcome changed.

        Called from the ONE place the sweep computes every trace's outcome (the
        loop in ``_run``), so no policy branch can forget to record something.
        The log is history, not state: it claims nothing and blocks nothing, so
        unlike the marker it also records ``wait`` and ``skip`` — they are the
        "why not" answer this log exists to give.

        The shared sentinel key is never logged. Every unidentified trace
        shares it, so a row for it would describe no particular download.
        ``last_outcomes`` comes from one grouped read for the whole sweep, so
        the transition check is not one query per trace.
        """
        key = entry.get("key") or ""
        if not key or key.endswith(_UNIDENTIFIED_SUFFIX):
            return
        # The action when there is one, the policy's decision otherwise. One
        # value, so the UI needs no second lookup.
        outcome = entry.get("action") or entry.get("decision")
        if not outcome or last_outcomes.get(key) == outcome:
            return
        self._grabs.log_auto_copy_decision(
            key,
            source=entry.get("source") or "",
            title=entry.get("title"),
            decision=outcome,
            reason=entry.get("reason"),
        )

    async def _foreign_destinations(self, session, own_grabs: list[dict]) -> set[str]:
        """Chosen destinations that are provably outside every arr root.

        Asked for only when someone actually picked a destination: the sweep
        already probes the arr per actionable trace, and the overwhelmingly
        common grab has no destination at all.

        **Fails closed.** An unreadable root list contributes nothing here, so
        the gate stays exactly as shut as it is today — widening a safety policy
        because the arr happened to be down would be backwards. `GET
        /api/calendar/destinations` offers the arr's own roots first, so "has a
        destination" alone says nothing about whether the file is leaving the
        library.
        """
        wanted = {
            (g.get("source") or "", g.get("destination"))
            for g in own_grabs
            if g.get("destination")
        }
        if not wanted:
            return set()

        foreign: set[str] = set()
        resolved: dict[str, list[str]] = {}
        for source, destination in sorted(wanted):
            if source not in resolved:
                resolved[source] = await self._arr_roots(session, source)
            roots = resolved[source]
            if not roots:
                continue
            if not any(_inside(destination, root) for root in roots):
                foreign.add(destination)
        return foreign

    async def handle_trace(
        self,
        session,
        trace: dict,
        *,
        own_grabs: list[dict],
        foreign_destinations: set[str],
        now: float,
        safe_mode: bool,
        grace_seconds: float,
    ) -> dict:
        source = trace.get("source") or ""
        title = trace.get("title") or ""
        key = auto_copy_key(trace)

        if key.endswith(_UNIDENTIFIED_SUFFIX):
            # Shared sentinel: never touch it. A marker here would suppress
            # every other unidentified download, and no decision about this
            # trace is trustworthy anyway.
            return _entry(
                key, source, title, SKIP, "sin identificador de descarga: no se actúa"
            )

        is_own = matches_own_grab(trace, own_grabs)
        already = self._grabs.is_auto_copy_handled(key)
        stage = trace.get("stage")

        # Resolved here, not inside `_do_dispatch`, because the policy below
        # must know it: the probe exists solely to answer "would copying this
        # duplicate into the library", and a chosen destination puts the file
        # somewhere the library does not reach — so it does not even need
        # asking.
        own_grab = find_own_grab(trace, own_grabs)
        destination = own_grab.get("destination") if own_grab else None
        has_destination = bool(destination) and destination in foreign_destinations
        # Also carried here for the same reason: `_do_dispatch` needs it and is
        # called after the decision. `None` for a row that predates v8 stays
        # `None`.
        quality = own_grab.get("quality") if own_grab else None

        # Ask the arr only when the answer can change the outcome. A probe per
        # trace per sweep would be one request per trace; asking only for a
        # plausibly actionable one (ours, not already handled, a stage that can
        # lead to a copy) keeps the sweep cheap. `None` means "unknown", and the
        # policy treats that as unknown, never as "no file", so gating this is
        # safe by design.
        has_file = None
        if is_own and not already and stage in _ACTIONABLE_STAGES and not has_destination:
            has_file = await self._arr_probe(session, trace)

        # The reference the grace window is measured from. The trace does not
        # carry the instant the current condition was first observed, and its
        # only timestamp — the grab `date` — predates the download, so deriving
        # it from the trace would start the clock before completion and race the
        # arr (exactly what T3 warned against). We persist our own first-sighting
        # instead. Only the grace-gated stages need it, and only when this trace
        # is actually ours and not yet handled: for anything else the policy
        # resolves before the gate, so a row would be pure noise.
        # `note_auto_copy_seen` returns the STORED instant when the key was
        # already seen in the same stage, which is what lets a later sweep
        # observe the window elapse.
        since = None
        if is_own and not already and _grace_relevant(stage, trace):
            since = self._grabs.note_auto_copy_seen(key, stage)

        decision = decide_copy(
            trace,
            now=now,
            since=since,
            grace_seconds=grace_seconds,
            already_handled=already,
            is_own_grab=is_own,
            arr_has_file=has_file,
            has_destination=has_destination,
        )
        result = decision["decision"]
        reason = decision["reason"]

        if result in (WAIT, SKIP):
            # Nothing durable. WAIT is transient (the arr may resolve it on its
            # own) and SKIP would freeze a condition that may change (a warning
            # that clears, a marker another path adds). A row here would be
            # noise.
            return _entry(key, source, title, result, reason)

        # result == COPY.
        if safe_mode:
            # Record the proposal and touch nothing: safe mode means "detect and
            # propose". The marker is written with the non-actioned label so it
            # can never block a later sweep that runs with safe mode off.
            self._grabs.mark_auto_copy(
                key, source=source, title=title, decision=PROPOSED_DECISION, reason=reason
            )
            return _entry(key, source, title, result, reason, action="proposed")

        return await self._do_dispatch(
            session, trace, key, source, title, reason, destination=destination, quality=quality
        )

    async def _do_dispatch(
        self,
        session,
        trace: dict,
        key: str,
        source: str,
        title: str,
        reason: str,
        *,
        destination: str | None = None,
        quality: str | None = None,
    ) -> dict:
        torrent = trace.get("torrent") or {}
        output_path = torrent.get("content_path")
        if not output_path:
            detail = "la traza no trae la ruta del contenido"
            self._grabs.mark_auto_copy(
                key, source=source, title=title, decision=FAILED_DECISION, reason=detail
            )
            return _entry(key, source, title, COPY, reason, action="failed", detail=detail)

        payload = {
            "source": source,
            "ids": trace.get("ids") or {},
            "output_path": output_path,
        }

        # The destination the user picked, already resolved by the caller. When
        # it is NULL the payload stays exactly as before: the copy goes to the
        # arr's library, and the engine resolves that root itself.
        if destination:
            payload["dest_root"] = destination
        # The quality of what was actually grabbed. Present only when the
        # registry knows it: a copy dispatched without one must not invent a
        # value a filename will be built from.
        if quality:
            payload["quality"] = quality

        # Claim before acting: persist the marker FIRST, then dispatch. If the
        # process dies mid-copy the marker already blocks a second sweep; the
        # claim's cost is that a crash before the copy completes is at-most-once,
        # never a duplicate into the library.
        self._grabs.mark_auto_copy(
            key, source=source, title=title, decision=self._actioned, reason=reason
        )

        try:
            result = await self._dispatch(session, "copy_files", payload)
        except Exception as exc:  # noqa: BLE001 — a failure must stay retryable
            detail = f"{type(exc).__name__}: {exc}"
            self._grabs.mark_auto_copy(
                key, source=source, title=title, decision=FAILED_DECISION, reason=detail
            )
            return _entry(key, source, title, COPY, reason, action="failed", detail=detail)

        if not result.get("ok"):
            detail = _first_detail(result) or "el motor de copia devolvió un error"
            # Downgrade the claim so the next sweep may retry.
            # `FAILED_DECISION` is not counted as handled by
            # `is_auto_copy_handled`.
            self._grabs.mark_auto_copy(
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
