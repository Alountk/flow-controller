"""Acknowledging a blocked import — C-02's "limpiar" (one click).

The blocked stage is not local state: ``traces.derive_stage`` recomputes it
from the arr's queue warning on every poll, so there is nothing local to
"clear" — the arr keeps reporting the block however the operator feels about
it. What can be durable is the operator's ACKNOWLEDGEMENT of one incident:

    key = auto_copy_key(trace) + the arr queue entry the warning sits on

so "Descartar bloqueo" hides THIS blockage of THIS download. A re-block under
a new queue entry is a new incident and shows again; a trace the arr has moved
on from (any other stage) is never touched, because the filter only reads
``import_blocked`` rows. Identity reuses ``domain.policy.auto_copy_key`` — the
same function the sweep trusts for markers — instead of inventing a second
notion of "which download is this".

Both functions are pure and take the ack set as an argument: the interesting
decisions (what is an incident, what may be hidden) are testable without
sqlite, and the store degrades to ``set()`` on its own — which means "show
everything", the safe direction when the acknowledgement store is unreadable.
"""

from __future__ import annotations

from domain.policy import UNIDENTIFIED, auto_copy_key

#: The sentinel suffix `auto_copy_key` returns for a trace with no identifier.
#: Derived here rather than imported from `sweep_downloads` — that is a private
#: constant of another use case, and this rule must hold for acks too: a key
#: ending in it is shared by every unidentified trace, so acknowledging it
#: would hide unrelated downloads at once.
_SENTINEL_SUFFIX = f":title:{UNIDENTIFIED}"


def incident_key(payload: dict) -> str | None:
    """The one incident this payload names, or ``None`` if it names none.

    Accepts either a full trace (the filter side) or the identity fields the
    ack endpoint receives (``source``/``download_id``/``ids``) — both are read
    by ``auto_copy_key`` the same way, which is what keeps the key written on
    ack and the key computed on read from ever drifting apart.

    ``None`` means "this payload cannot name an incident": its identity is the
    shared ``unidentified`` sentinel, and persisting an ack under it would hide
    every unidentified blocked trace at once.
    """
    identity = auto_copy_key(payload)
    if identity.endswith(_SENTINEL_SUFFIX):
        return None
    ids = payload.get("ids") or {}
    return f"{identity}|q:{ids.get('queue_id')}"


def visible_traces(traces: list[dict], acked: set[str]) -> list[dict]:
    """The traces the blocked column and the summary must draw from.

    Only ``import_blocked`` rows are ever filtered, and only when their
    incident key was acknowledged — so an ack cannot hide the same download in
    another stage, and it expires the moment the arr reports a different queue
    entry (a new incident). With no acks this is the identity function: the
    common poll pays one ``set`` emptiness check.
    """
    if not acked:
        return traces
    return [
        t
        for t in traces
        if not (t.get("stage") == "import_blocked" and incident_key(t) in acked)
    ]
