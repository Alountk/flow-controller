"""Pure decision: should the app copy a finished download into the library?

No I/O and no clock of its own: every fact arrives as an argument, so the policy
can be tested exhaustively and the driver keeps ownership of time and storage.
"""

from datetime import datetime, timezone

COPY = "copy"
WAIT = "wait"
SKIP = "skip"

#: How long the arr gets to import on its own before the app stops waiting.
DEFAULT_GRACE_SECONDS = 1800.0

#: How long after our grab a history trace is still attributed to us. The arr
#: writes its grab row within seconds of our request, so this is a tolerance,
#: not a search range. The trade-off is real: too narrow and a slow arr's grab
#: is missed (the app stays hands-off — the status quo), too wide and a LATER,
#: unrelated manual grab of the same title is attributed to us and copied. It
#: leans deliberately narrow, per D3 ("widen once this is boringly reliable;
#: shrinking after it has moved something wrong is not"). Two minutes absorbs a
#: slow arr without opening a realistic misattribution window.
DEFAULT_GRAB_WINDOW_SECONDS = 120.0

#: Tolerance for this host's clock running ahead of the arr's. The arr stamps
#: the grab AFTER our request, so its `date` normally lands just after
#: `grabbed_at`; this only covers the arr's clock being slightly behind ours, so
#: the lower bound is `grabbed_at - skew` rather than exact equality.
GRAB_CLOCK_SKEW_SECONDS = 30.0


def _grace_gate(
    now: float,
    since: float | None,
    grace_seconds: float,
    arr_has_file: bool | None,
) -> dict:
    """Decide inside the grace window.

    `since` is the caller's timestamp for when the currently observed condition
    started. The policy never invents it: without one it waits instead of
    guessing, and a `since` in the future (clock skew) also waits.

    The window expiring is NOT by itself permission to copy. `arr_has_file` is
    three-valued, and `None` means the arr could not be asked (no id, non-200,
    timeout, client error) — not "the arr has no file". Once the window can
    genuinely expire (T10 persists the reference), an unknown guard plus an
    expired window would copy a file the arr may already have imported: a
    duplicate in the library, exactly what D2 and the whole guard exist to
    prevent. So an unknown guard waits for a confident answer. Only `False` — the
    arr explicitly saying it has no file — copies. (`True` never reaches here:
    `decide_copy` skips on it before the stage switch.)
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
    if arr_has_file is None:
        return {
            "decision": WAIT,
            "reason": (
                f"la ventana de gracia de {window} venció, pero no se pudo "
                "comprobar si el arr ya tiene el fichero"
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
        return _grace_gate(now, since, grace_seconds, arr_has_file)
    if stage == "downloaded":
        return _grace_gate(now, since, grace_seconds, arr_has_file)
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


def _parse_trace_date(value) -> float | None:
    """Epoch seconds for the arr's ISO timestamp, or None when it cannot be read.

    Never guesses: an absent or malformed value returns None, and the matcher
    turns a None into a non-match. The arr sends UTC with a `Z` suffix; a naive
    value is treated as UTC rather than local time, because assuming a timezone
    is a smaller error than silently shifting the instant.
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def find_own_grab(
    trace: dict,
    own_grabs: list[dict],
    *,
    window_seconds: float = DEFAULT_GRAB_WINDOW_SECONDS,
) -> dict | None:
    """Return the first registry row this trace is provably one of our grabs.

    `list_own_grabs` returns rows newest-first, and the first match wins, so the
    returned row is the most recent matching grab. The row is needed when more
    than the yes/no answer matters: the driver reads its `destination` to send
    the copy to the folder the user picked.

    Matching rules (the boolean form delegates to this, so both agree):

    - same `source` as the registry row;
    - same title identity — movie ids when the trace carries
      `ids["movie_id"]`, episode ids when it carries `ids["episode_id"]`. A
      trace with neither does NOT match: it is not provably ours, and the
      policy already treats a non-match as "skip";
    - the trace's `date` inside `[grabbed_at - GRAB_CLOCK_SKEW_SECONDS,
      grabbed_at + window_seconds]`. The arr records the row moments AFTER our
      request, so it lands just past `grabbed_at`; requiring exact equality
      would match nothing;
    - an unparseable or absent `date` is a non-match, never a guess and never a
      raise.

    The release `guid` is deliberately NOT used here: in a grabbed history
    record `data.guid` is the download client's hash, not the indexer's release
    guid, so it cannot be matched against the arr's history (see history.py).
    """
    if not own_grabs:
        return None

    source = (trace.get("source") or "").strip()
    ids = trace.get("ids") or {}
    movie_id = ids.get("movie_id")
    episode_id = ids.get("episode_id")
    if movie_id is None and episode_id is None:
        return None

    when = _parse_trace_date(trace.get("date"))
    if when is None:
        return None

    for row in own_grabs:
        if (row.get("source") or "").strip() != source:
            continue
        if movie_id is not None:
            if row.get("movie_id") != movie_id:
                continue
        elif row.get("episode_id") != episode_id:
            continue

        grabbed_at = row.get("grabbed_at")
        if not isinstance(grabbed_at, (int, float)):
            continue
        if when < grabbed_at - GRAB_CLOCK_SKEW_SECONDS:
            continue
        if when > grabbed_at + window_seconds:
            continue
        return row
    return None


def matches_own_grab(
    trace: dict,
    own_grabs: list[dict],
    *,
    window_seconds: float = DEFAULT_GRAB_WINDOW_SECONDS,
) -> bool:
    """Whether an arr-history trace is one of the grabs this app launched.

    This is the yes/no form of `find_own_grab`, kept because most callers only
    need the answer. It delegates, so the two can never disagree.
    """
    return find_own_grab(trace, own_grabs, window_seconds=window_seconds) is not None
