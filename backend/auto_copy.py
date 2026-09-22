"""Pure decision: should the app copy a finished download into the library?

No I/O and no clock of its own: every fact arrives as an argument, so the policy
can be tested exhaustively and the driver keeps ownership of time and storage.
"""

COPY = "copy"
WAIT = "wait"
SKIP = "skip"

#: How long the arr gets to import on its own before the app stops waiting.
DEFAULT_GRACE_SECONDS = 1800.0


def _grace_gate(now: float, since: float | None, grace_seconds: float) -> dict:
    """Decide inside the grace window.

    `since` is the caller's timestamp for when the currently observed condition
    started. The policy never invents it: without one it waits instead of
    guessing, and a `since` in the future (clock skew) also waits.
    """
    if since is None:
        return {
            "decision": WAIT,
            "reason": "sin referencia temporal para medir la ventana de gracia",
        }

    window = f"{grace_seconds / 60:g} min"
    if now - since < grace_seconds:
        return {
            "decision": WAIT,
            "reason": (
                f"dentro de la ventana de gracia de {window}: "
                "el arr puede importarlo solo"
            ),
        }
    return {"decision": COPY, "reason": f"el arr no lo importó en {window}"}


def decide_copy(
    trace: dict,
    *,
    now: float,
    since: float | None = None,
    grace_seconds: float = DEFAULT_GRACE_SECONDS,
    already_handled: bool = False,
    is_own_grab: bool = True,
    arr_has_file: bool | None = None,
) -> dict:
    """Return {"decision": COPY|WAIT|SKIP, "reason": str}.

    Rules are evaluated in order, first match wins. Reasons are user-facing:
    a later task writes them into the operation history.
    """
    if is_own_grab is False:
        return {"decision": SKIP, "reason": "no es un grab lanzado desde la app"}
    if already_handled:
        return {"decision": SKIP, "reason": "ya se copió antes"}
    if arr_has_file is True:
        return {"decision": SKIP, "reason": "el arr ya tiene el fichero"}

    stage = trace.get("stage")
    if stage == "failed":
        return {"decision": SKIP, "reason": "la descarga falló"}
    if stage in ("sent", "downloading"):
        return {"decision": WAIT, "reason": "la descarga sigue en curso"}
    if stage == "importing":
        return {"decision": WAIT, "reason": "el arr está importando: no se compite con él"}
    if stage == "import_blocked":
        queue = trace.get("queue") or {}
        if queue.get("status") == "warning":
            return {"decision": COPY, "reason": "el arr reporta un warning de import"}
        # No warning: `importPending` is ALSO the healthy transient state right
        # before the arr imports. It is not proof the arr is stuck, so wait the
        # window out rather than racing it (D2).
        return _grace_gate(now, since, grace_seconds)
    if stage == "downloaded":
        return _grace_gate(now, since, grace_seconds)
    return {"decision": SKIP, "reason": "estado desconocido: no se actúa"}
