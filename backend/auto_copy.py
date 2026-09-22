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


#: Last-resort key suffix for a trace that carries no identifier at all. It is a
#: deliberate sentinel: the other two key shapes always end in a value, so this
#: token is only ever produced by the branch below and cannot be mistaken for a
#: real download id. Every unidentified trace shares it, though, so a persisted
#: marker built from it would block unrelated downloads.
UNIDENTIFIED = "unidentified"


def _normalize_download_id(value: str) -> str:
    """Lowercase, then drop the arr's zero padding deterministically.

    The arr reports one client hash in two shapes: padded with exactly eight
    zeros (`467250D5…414A00000000`) and plain (`467250d5…414a`). Both are the
    same download, so both must normalize to the plain 40-character form.

    The rule is exact, never fuzzy: after stripping and lowercasing, drop
    everything past the first 40 characters only when that tail is all zeros.
    A genuine 40-character id ending in zeros has no tail, so its zeros are
    kept — they are part of the id, not padding.
    """
    normalized = (value or "").strip().lower()
    tail = normalized[40:]
    if tail and not tail.strip("0"):
        return normalized[:40]
    return normalized


def auto_copy_key(trace: dict) -> str:
    """Stable identity for one candidate download, across restarts and refreshes.

    This key is the idempotency marker's identity, so determinism matters more
    than a plausible match: a wrong identity either skips a copy that should
    happen or repeats one that must not. The fuzzy matcher is therefore banned
    here. `traces.hash_matches` is fine for a human looking at a screen, but its
    last resort is prefix matching, and identity is not a place for a guess.

    Preference order:
      1. the download's own id, normalized (`<source>:<id>`);
      2. the title id the arr attached to the grab:
         `<source>:title:movie:<id>` or `<source>:title:episode:<id>`;
      3. `<source>:title:<UNIDENTIFIED>` when the trace carries no id at all.

    Shape 3 is a sentinel, not an identity: it can never equal shapes 1 or 2
    (both always end in a value), but every unidentified trace shares it. A
    driver must not persist a marker built from it, or it would suppress
    unrelated downloads.
    """
    source = (trace.get("source") or "").strip()
    download_id = _normalize_download_id(trace.get("download_id"))
    if download_id:
        return f"{source}:{download_id}"

    ids = trace.get("ids") or {}
    movie_id = ids.get("movie_id")
    if movie_id is not None:
        return f"{source}:title:movie:{movie_id}"
    episode_id = ids.get("episode_id")
    if episode_id is not None:
        return f"{source}:title:episode:{episode_id}"
    return f"{source}:title:{UNIDENTIFIED}"
