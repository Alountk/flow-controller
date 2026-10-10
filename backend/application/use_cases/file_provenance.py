"""Why a file is where it is — the File Manager's *procedencia* (F-07).

F-05 retention answers *how long* each file has been sitting there; this
answers *why*, by crossing the three sources that can claim a file:

======================= =============================================
Source                  Says
======================= =============================================
arr queue               `cola · importando` — the arr is importing it
arr history             `histórico` — it arrived before
`own_grabs` (local)     `lo pedimos nosotros` — our own grab
======================= =============================================

**Precedence: own > queue > history.** A file we requested that is also
mid-import reads "lo pedimos nosotros": the origin answers WHY the file
exists, only the local registry knows we asked for it, and the queue's
importing state is transient — the same file reads `histórico` tomorrow.
A file in both arr sources (grab recorded, import still running) reads
`cola · importando`: the live state is the more specific answer.

**Matching is exact after cleaning, never substring.** Keys are the
`domain.naming.clean_title` form (accents, punctuation, case stripped) of
the name AND of its media-extension-stripped stem, so `Movie.2016.mkv` on
disk meets the arr's `Movie.2016` release title. A substring match would
label `notes.txt` from some unrelated title: an absent chip is honest, a
wrong chip is a claim.

**Display-only by decision (BACKLOG F-07):** this never blocks anything,
so it degrades the way an annotation should — a dead arr, an unreadable
registry or a loader that raises yields "no source claims this file", never
an exception and never a 500. Names no source claims are ABSENT from the
answer; the route renders the absence as no chip, never as a label.

Two caches, two lifetimes. The arr snapshot (queue + history indexes) is
TTL-cached because every directory listing would otherwise re-fan-out
against the LAN services — stale-by-seconds is fine for a chip (same
10 s budget the trace cache uses). The own-grab registry is read FRESH per
call: one local SQLite read, and a grab the user made a second ago has to
show at once.

The syscalls sit behind injected loaders (`queue_loader`, `history_loader`,
`own_loader`) — the route hands them the `application.gateways` delegates,
tests hand them fakes, and this module never imports an adapter.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import PurePosixPath
from typing import Any, Awaitable, Callable, Iterable

from domain.naming import MEDIA_EXTENSIONS, clean_title
from domain.policy import matches_own_grab

#: Staleness budget for the arr snapshot — the value `_TRACE_TTL` carried
#: while it lived in `routes/status.py`. Display-only: a chip a few seconds
#: old is invisible; a fresh fan-out per listing is not.
_PROVENANCE_TTL = 10.0

#: How many history grabs to read per arr. Newest first: 250 spans well past
#: the retention window (7 days by default) so old files still find their
#: record, without turning every snapshot into a megabyte scan.
HISTORY_LIMIT = 250

#: Upper bound on own-grab rows per call. The registry only ever holds OUR
#: requests (one row per grab the app made), so `since=0` reads it whole —
#: a grab older than any window is still the reason a file is here.
OWN_LIMIT = 500

#: The chip text, exactly as BACKLOG F-07 states it. Backend-owned copy:
#: the frontend renders what this says rather than re-deriving it.
_LABELS = {
    "own": "lo pedimos nosotros",
    "queue": "cola · importando",
    "history": "histórico",
}

#: `(services_key, built_at, queue_index, history_index)`. The services key
#: is part of the identity: a configuration change must not wait out the TTL
#: to be believed. No lock, like the trace cache it sits beside — a lost race
#: builds the same snapshot twice, it never builds it wrong.
_snapshot: tuple[tuple[str, ...], float, dict, dict] | None = None

QueueLoader = Callable[..., Awaitable[list[dict]]]
HistoryLoader = Callable[..., Awaitable[list[dict]]]
OwnLoader = Callable[..., list[dict]]


def _keys(value: Any) -> set[str]:
    """Matching keys for one name: cleaned full form + cleaned stem.

    The stem is only stripped when the suffix is a known media extension —
    `naming.MEDIA_EXTENSIONS`, the repo's single definition of "this is a
    video" — so `notes.txt` keeps its `.txt` in the key instead of being
    reduced to a word that half the directory would also match.
    """
    if not isinstance(value, str) or not value:
        return set()
    keys = {clean_title(value)}
    candidate = PurePosixPath(value.replace("\\", "/"))
    if candidate.suffix.lower() in MEDIA_EXTENSIONS:
        keys.add(clean_title(candidate.stem))
    keys.discard("")
    return keys


def _path_basename(value: Any) -> Any:
    """A path field contributes its BASENAME only.

    The arr speaks container paths (`/downloads/incoming/...`); the host
    mapping lives in legacy `traces.resolve_current_path`, which this module
    deliberately does not import. The basename crosses that namespace for
    the one file the row is about, and the title fields carry the rest.
    """
    if isinstance(value, str) and value:
        return PurePosixPath(value.replace("\\", "/")).name
    return value


def _record_keys(record: dict, kind: str) -> set[str]:
    """Every name a queue/history record can identify a file by."""
    if kind == "queue":
        pairs = [
            (record.get("title"), False),
            (record.get("outputPath"), True),
        ]
    else:
        data = record.get("data") if isinstance(record.get("data"), dict) else {}
        pairs = [
            (record.get("sourceTitle"), False),
            (record.get("title"), False),
            (data.get("droppedPath"), True),
            (data.get("importedPath"), True),
        ]
    keys: set[str] = set()
    for value, is_path in pairs:
        keys |= _keys(_path_basename(value) if is_path else value)
    return keys


def _index(per_service: Iterable[tuple[str, list[dict]]], kind: str) -> dict[str, list]:
    """`cleaned key -> [(source, record), ...]` for one arr source kind.

    A key may collect several records (two services, two releases): the
    classifier inspects them all rather than betting on the first.
    """
    index: dict[str, list] = {}
    for source, records in per_service:
        for record in records:
            if not isinstance(record, dict):
                continue
            for key in _record_keys(record, kind):
                index.setdefault(key, []).append((source, record))
    return index


def _lookup(index: dict[str, list], keys: set[str]) -> list:
    hits: list = []
    for key in keys:
        hits.extend(index.get(key, ()))
    return hits


def _is_ours(source: str, record: dict, own_rows: list[dict]) -> bool:
    """Whether this arr record is one of the grabs THIS app launched.

    The ids (movie/episode, by service) prove the TITLE is one we requested;
    when the record carries a grab `date` — history records always do — the
    instant is proved too, by the sweep's own `matches_own_grab` window. A
    queue record has no date field at all (`"date" not in record`), so its
    ids are all the evidence there is; a history record whose date exists but
    does not line up is NOT ours — the domain already taught that an absent
    instant is a non-match, never a guess.
    """
    if not own_rows:
        return False
    movie_id = record.get("movieId")
    episode_id = record.get("episodeId")
    if movie_id is None and episode_id is None:
        return False
    ids = {"movie_id": movie_id, "episode_id": episode_id}
    if "date" in record:
        return matches_own_grab(
            {"source": source, "date": record.get("date"), "ids": ids}, own_rows
        )
    for row in own_rows:
        if (row.get("source") or "").strip() != source:
            continue
        if movie_id is not None and row.get("movie_id") == movie_id:
            return True
        if episode_id is not None and row.get("episode_id") == episode_id:
            return True
    return False


def _classify(
    keys: set[str],
    queue_index: dict,
    history_index: dict,
    own_rows: list[dict],
    direct_keys: set[str],
) -> str | None:
    """own > queue > history — the precedence pinned by the F-07 tests."""
    if keys & direct_keys:
        # Direct adds (B-10): the arr never saw them, the registry's exact
        # `client_name` is the only identity that can claim them.
        return "own"
    queue_hits = _lookup(queue_index, keys)
    history_hits = _lookup(history_index, keys)
    for source, record in queue_hits + history_hits:
        if _is_ours(source, record, own_rows):
            return "own"
    if queue_hits:
        return "queue"
    if history_hits:
        return "history"
    return None


def _rows(result) -> list[dict]:
    """One loader's answer, with the failure modes named.

    A raised exception becomes "this source claims nothing" (display-only —
    see the module docstring); a `CancelledError` is re-raised, because
    swallowing a cancellation would leave the request running after its
    caller gave up.
    """
    if isinstance(result, asyncio.CancelledError):
        raise result
    if isinstance(result, Exception):
        return []
    return result if isinstance(result, list) else []


async def _arr_indexes(
    session: Any,
    services: list[dict],
    queue_loader: QueueLoader,
    history_loader: HistoryLoader,
    stamp: float,
) -> tuple[dict, dict]:
    """Queue + history indexes, rebuilt at most once per TTL window.

    One `gather` for the whole fan-out: the per-arr queue and history calls
    overlap, so N configured arrs cost one round trip in wall-clock terms,
    not 2N. A service that cannot be reached degrades its half to [] — the
    same honesty `fetch_arr_queue`/`fetch_arr_grabbed` already give.
    """
    global _snapshot
    key = tuple(sorted(str(s.get("key") or "") for s in services))
    cached = _snapshot
    if (
        cached is not None
        and cached[0] == key
        and stamp - cached[1] < _PROVENANCE_TTL
    ):
        return cached[2], cached[3]

    n = len(services)
    tasks: list[Awaitable] = [queue_loader(session, s) for s in services]
    tasks += [history_loader(session, s, HISTORY_LIMIT) for s in services]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    queue_by_service = [
        (service["key"], _rows(result))
        for service, result in zip(services, results[:n])
    ]
    history_by_service = [
        (service["key"], _rows(result))
        for service, result in zip(services, results[n:])
    ]
    queue_index = _index(queue_by_service, "queue")
    history_index = _index(history_by_service, "history")
    _snapshot = (key, stamp, queue_index, history_index)
    return queue_index, history_index


async def _load_own(own_loader: OwnLoader) -> list[dict]:
    try:
        rows = await asyncio.to_thread(own_loader, 0.0, limit=OWN_LIMIT)
    except Exception:  # noqa: BLE001 — an unreadable registry claims nothing
        return []
    return rows if isinstance(rows, list) else []


async def file_provenance(
    names: Iterable[str],
    *,
    session: Any,
    services: list[dict],
    queue_loader: QueueLoader,
    history_loader: HistoryLoader,
    own_loader: OwnLoader,
    now: float | None = None,
) -> dict[str, dict]:
    """`{name: {"provenance": kind, "provenance_label": text}}` for claimed names.

    The one seam: a listing hands over the names it wants classified and the
    three loaders; everything else — fan-out, TTL, crossing, precedence —
    lives behind this call. Names no source claims are ABSENT from the result
    (the route turns that into explicit nulls), and the call NEVER raises:
    display-only means the listing renders with no chips, not with a 500.
    """
    wanted = list(names)
    if not wanted:
        # An empty directory must not pay for a single outbound call.
        return {}

    stamp = time.time() if now is None else now
    own_rows = await _load_own(own_loader)
    queue_index, history_index = await _arr_indexes(
        session, services, queue_loader, history_loader, stamp
    )
    direct_keys: set[str] = set()
    for row in own_rows:
        direct_keys |= _keys(row.get("client_name"))

    result: dict[str, dict] = {}
    for name in wanted:
        keys = _keys(name)
        if not keys:
            continue
        kind = _classify(keys, queue_index, history_index, own_rows, direct_keys)
        if kind is not None:
            result[name] = {"provenance": kind, "provenance_label": _LABELS[kind]}
    return result
