"""Wiring for one auto-copy sweep.

The decisions live in ``application.use_cases.sweep_downloads``. This module is
the seam: it hands the sweep the things it needs and keeps the app's vocabulary
(``task_id``, a database, an arr) out of a use case that has no business
knowing any of it exists.

It also keeps the import path. Everything below looks its collaborators up
**on every call** — as module globals, through ``_OwnGrabStore`` and the two
probe helpers. That is deliberate and it is load-bearing: the suite
monkeypatches ``list_own_grabs``, ``arr_has_file``, ``do_action`` and friends on
THIS module, and a reference captured at import would hand the sweep the
unpatched originals while the tests went on passing against a copy.

The trigger is deliberate too: an explicit ``POST /api/auto-copy/sweep`` (see
``routes/auto_copy.py``), never a background loop and never a side effect of the
``GET /api/trace`` the UI polls every 15 s. Copying into the library is a
mutation, so it must be an explicit action: hooking the polled GET would turn a
read into a write and make two open tabs two sweeps. Unattended operation is the
user's external timer (cron/systemd) calling that endpoint.
"""

import logging

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
from application.use_cases.sweep_downloads import (
    FAILED_DECISION,
    OWN_GRAB_LIMIT,
    OWN_GRAB_LOOKBACK_SECONDS,
    PROPOSED_DECISION,
    SweepDownloads,
)
from infrastructure.arr_client import arr_has_file, arr_root_folders
from config import find_service
from copy_engine import do_action
from infrastructure.sqlite_history import (
    DECISION_ACTIONED,
    is_auto_copy_handled,
    latest_auto_copy_decisions,
    list_own_grabs,
    log_auto_copy_decision,
    mark_auto_copy,
    note_auto_copy_seen,
)
from traces import build_traces

__all__ = [
    "COPY",
    "DEFAULT_GRACE_SECONDS",
    "FAILED_DECISION",
    "OWN_GRAB_LIMIT",
    "OWN_GRAB_LOOKBACK_SECONDS",
    "PROPOSED_DECISION",
    "SKIP",
    "UNIDENTIFIED",
    "WAIT",
    "auto_copy_key",
    "decide_copy",
    "find_own_grab",
    "matches_own_grab",
    "sweep",
]

log = logging.getLogger("flow-controller")


class _OwnGrabStore:
    """`OwnGrabStore` over THIS module's bindings.

    Every method calls the bare NAME below rather than a stored reference, so
    `monkeypatch.setattr(driver, "mark_auto_copy", fake)` lands on the code the
    sweep actually runs. A method name is not in scope inside its own body, so
    these resolve to the module globals — and to whatever a test has just put
    there. A reference captured at class definition would patch a copy and leave
    the real one calling the database.
    """

    def list_own_grabs(self, since: float, *, limit: int = OWN_GRAB_LIMIT) -> list[dict]:
        return list_own_grabs(since, limit=limit)

    def is_auto_copy_handled(self, key: str) -> bool:
        return is_auto_copy_handled(key)

    def mark_auto_copy(self, key: str, *, source: str, title, decision: str, reason=None) -> None:
        mark_auto_copy(key, source=source, title=title, decision=decision, reason=reason)

    def note_auto_copy_seen(self, key: str, stage: str, *, seen_at=None):
        return note_auto_copy_seen(key, stage, seen_at=seen_at)

    def latest_auto_copy_decisions(self) -> dict[str, str]:
        return latest_auto_copy_decisions()

    def log_auto_copy_decision(self, key: str, *, source: str, title, decision: str, reason=None) -> None:
        log_auto_copy_decision(key, source=source, title=title, decision=decision, reason=reason)


async def _arr_roots(session, source: str) -> list[str]:
    """Root folders the arr manages for `source`; [] whenever unknown.

    Unknown is the point: the caller cannot then prove a destination is
    foreign, and the policy keeps the gate it already has.
    """
    service = find_service(source, "arr")
    if not service:
        return []
    try:
        return await arr_root_folders(session, service)
    except Exception as exc:  # noqa: BLE001 — unknown, never "not a root"
        log.warning("auto-copy sweep: sin raíces de %s: %s", source, exc)
        return []


async def _handle_trace(session, trace: dict, **kwargs) -> dict:
    """Judge one trace. Kept at this path because the suite patches it.

    `test_one_failing_trace_does_not_abort_the_sweep` swaps this out to make one
    trace blow up and asserts the other survives — which only means anything if
    the replacement reaches the loop. It does, because `_build` reads the name
    at call time like every other collaborator here.

    Stateless per trace: `own_grabs` and `foreign_destinations` travel as
    arguments, so a fresh sweep object per call is free.
    """
    return await _build().handle_trace(session, trace, **kwargs)


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


def _build() -> SweepDownloads:
    """Assemble the sweep from this module's current bindings.

    Built on every call for the reason spelled out on `_OwnGrabStore`: the
    suite replaces these names here, and a sweep assembled once at import would
    keep using the originals.
    """
    return SweepDownloads(
        traces=build_traces,
        own_grabs=_OwnGrabStore(),
        arr_probe=_arr_probe,
        arr_roots=_arr_roots,
        dispatch=do_action,
        handle_trace=_handle_trace,
        actioned_decision=DECISION_ACTIONED,
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
    return await _build().run(
        session, now=now, safe_mode=safe_mode, grace_seconds=grace_seconds
    )
