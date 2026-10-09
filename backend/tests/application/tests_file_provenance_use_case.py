"""F-07 — la procedencia de cada fichero, cruzando tres fuentes.

The File Manager already says how long a file has been here (F-05 retention).
This says **why** it is here: `cola · importando` (the arr is importing it),
`histórico` (it arrived before) or `lo pedimos nosotros` (our own grab).
Display-only by decision — the chip never blocks anything (BACKLOG F-07).

The seam is ONE call with three injected sources — no HTTP client, no SQLite
and no `traces` import in the module under test:

    file_provenance(names, *, session, services, queue_loader,
                    history_loader, own_loader) -> {name: {provenance, label}}

Precedence, pinned here: **own > queue > history**. A file we requested that
is also mid-import reads "lo pedimos nosotros": the origin answers WHY the
file exists, only the local registry knows we asked for it, and the queue's
importing state is transient — it would read `histórico` tomorrow anyway.

Matching is exact AFTER cleaning (accents, punctuation, case, media extension
via `domain.naming.clean_title`), never substring: a chip that guesses is
worse than no chip. Names no source claims are ABSENT from the answer; the
route turns that absence into no chip, never into a label.

The arr snapshot (queue + history indexes) is TTL-cached so every listing
does not hammer the arrs; display-only means stale-by-seconds is fine. The
own-grab registry is read FRESH per call: one local SQLite read, and a grab
the user made a second ago has to show at once.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import pytest

from application.use_cases import file_provenance as provenance_module
from application.use_cases.file_provenance import file_provenance

RADARR = {"key": "radarr", "kind": "arr", "url": "http://radarr.test:7878", "api_key": "k"}

#: The grab instant this fixture set uses: `1_700_000_000` epoch is exactly
#: "2023-11-14T22:13:20Z" — the same pair `tests_direct_traces` pins, so a
#: history record and its own-grab row always describe the SAME grab.
GRAB_AT = 1_700_000_000.0
GRAB_DATE = "2023-11-14T22:13:20Z"


@asynccontextmanager
async def _session():
    yield object()


def _queue(title: str, **over) -> dict:
    row = {"title": title, "status": "downloading", "trackedDownloadState": "importing"}
    row.update(over)
    return row


def _history(title: str, **over) -> dict:
    row = {"sourceTitle": title, "date": GRAB_DATE, "downloadId": "d1"}
    row.update(over)
    return row


def _own(**over) -> dict:
    row = {
        "source": "radarr",
        "movie_id": 855,
        "episode_id": None,
        "series_id": None,
        "grabbed_at": GRAB_AT,
        "direct": 0,
        "client_name": "",
    }
    row.update(over)
    return row


class _Sources:
    """The three injected loaders, with call counters on the side."""

    def __init__(self, *, queue=(), history=(), own=(), fail=()):
        self.queue = list(queue)
        self.history = list(history)
        self.own = list(own)
        self.fail = set(fail)
        self.calls = {"queue": 0, "history": 0, "own": 0}

    async def queue_loader(self, session, service):
        self.calls["queue"] += 1
        if "queue" in self.fail:
            raise RuntimeError("radarr caído")
        return list(self.queue)

    async def history_loader(self, session, service, limit):
        self.calls["history"] += 1
        if "history" in self.fail:
            raise RuntimeError("sonarr caído")
        return list(self.history)

    def own_loader(self, since, *, limit=500):
        self.calls["own"] += 1
        if "own" in self.fail:
            raise RuntimeError("sqlite caído")
        return list(self.own)


@pytest.fixture(autouse=True)
def _cold_snapshot():
    """Each test starts without a cached arr snapshot — same lesson as
    `tests_trace_cache._cold()`: module state outlives a single call."""
    provenance_module._snapshot = None
    yield
    provenance_module._snapshot = None


def _classify(
    names, *, queue=(), history=(), own=(), fail=(), sources=None, services=None, now=None
):
    if sources is None:
        src = _Sources(queue=queue, history=history, own=own, fail=fail)
    else:
        src = sources
    services = [RADARR] if services is None else list(services)
    result = asyncio.run(
        file_provenance(
            names,
            # A stand-in session: the loaders only receive it, never touch it.
            session=object(),
            services=services,
            queue_loader=src.queue_loader,
            history_loader=src.history_loader,
            own_loader=src.own_loader,
            now=now,
        )
    )
    return result, src


# ── The three answers ─────────────────────────────────────────────────────────


def test_a_queue_item_we_requested_reads_as_lo_pedimos_nosotros():
    """The headline case: in the arr queue AND one of our grabs.

    The queue alone would say `cola · importando` and lose the WHY; the local
    registry is what makes the origin knowable at all.
    """
    result, _ = _classify(
        ["Movie.2016.mkv"],
        queue=[_queue("Movie.2016.mkv", movieId=855)],
        own=[_own()],
    )

    assert result == {
        "Movie.2016.mkv": {
            "provenance": "own",
            "provenance_label": "lo pedimos nosotros",
        }
    }


def test_a_history_grab_inside_the_grab_window_is_also_ours():
    """The same crossing through the history record: ids + the arr's date.

    `domain.policy.matches_own_grab` proves the record and our registry row
    describe the SAME grab (within the grab window), not merely the same
    title — reuse the sweep's rule rather than inventing a second one.
    """
    result, _ = _classify(
        ["Movie.2016.mkv"],
        history=[_history("Movie.2016.mkv", movieId=855)],
        own=[_own()],
    )

    assert result["Movie.2016.mkv"]["provenance"] == "own"
    assert result["Movie.2016.mkv"]["provenance_label"] == "lo pedimos nosotros"


def test_a_plain_queue_item_reads_as_cola_importando():
    result, _ = _classify(["Movie.2016.mkv"], queue=[_queue("Movie.2016.mkv")])

    assert result == {
        "Movie.2016.mkv": {
            "provenance": "queue",
            "provenance_label": "cola · importando",
        }
    }


def test_history_only_reads_as_historico():
    result, _ = _classify(["Movie.2016.mkv"], history=[_history("Movie.2016.mkv")])

    assert result == {
        "Movie.2016.mkv": {
            "provenance": "history",
            "provenance_label": "histórico",
        }
    }


# ── Precedence ────────────────────────────────────────────────────────────────


def test_queue_beats_history_when_the_file_is_not_ours():
    """Both arr sources claim it: the live state (`importando`) is the more
    specific answer; `histórico` is what it becomes once the import lands."""
    result, _ = _classify(
        ["Movie.2016.mkv"],
        queue=[_queue("Movie.2016.mkv")],
        history=[_history("Movie.2016.mkv")],
    )

    assert result["Movie.2016.mkv"]["provenance"] == "queue"


def test_our_grab_beats_the_queue_state():
    """own > queue, even when the queue also claims the file (see the headline
    case above with history present; this one proves it WITHOUT history, so
    the queue-id crossing path is exercised on its own)."""
    result, _ = _classify(
        ["Movie.2016.mkv"],
        queue=[_queue("Movie.2016.mkv", movieId=855)],
        own=[_own()],
    )

    assert result["Movie.2016.mkv"]["provenance"] == "own"


# ── The honest absences ───────────────────────────────────────────────────────


def test_a_file_no_source_claims_is_absent_from_the_answer():
    """Not a null row, not a guess: absent, and the route renders no chip."""
    result, _ = _classify(
        ["Nadie.mkv"],
        queue=[_queue("Otro.mkv")],
        history=[_history("Otro.mkv")],
        own=[_own()],
    )

    assert result == {}


def test_a_history_grab_outside_the_grab_window_is_not_ours():
    """Same title ids, different instant: NOT provably our grab, so the chip
    must fall back to `histórico` instead of claiming the origin."""
    result, _ = _classify(
        ["Movie.2016.mkv"],
        history=[_history("Movie.2016.mkv", movieId=855, date="2023-11-14T01:00:00Z")],
        own=[_own()],
    )

    assert result["Movie.2016.mkv"]["provenance"] == "history"


def test_a_direct_grab_is_ours_by_exact_client_name_without_any_arr_record():
    """B-10 direct adds never reach an arr: the registry's `client_name` (the
    file's own name) is the only identity that can claim them."""
    result, _ = _classify(
        ["Directo.mkv"],
        own=[_own(direct=1, client_name="Directo.mkv", movie_id=None)],
    )

    assert result["Directo.mkv"]["provenance"] == "own"
    assert result["Directo.mkv"]["provenance_label"] == "lo pedimos nosotros"


def test_without_any_arr_the_local_registry_still_answers():
    """A deployment with no arr configured still gets the own-grab chips from
    the local registry — direct grabs never needed an arr in the first place."""
    result, _ = _classify(
        ["Directo.mkv"],
        services=[],
        sources=_Sources(own=[_own(direct=1, client_name="Directo.mkv", movie_id=None)]),
    )

    assert result["Directo.mkv"]["provenance"] == "own"


def test_the_arr_loaders_are_not_called_when_no_arr_is_configured():
    _, src = _classify(
        ["Cualquiera.mkv"],
        services=[],
        sources=_Sources(own=[_own(direct=1, client_name="Cualquiera.mkv", movie_id=None)]),
    )

    assert src.calls["queue"] == 0
    assert src.calls["history"] == 0


def test_matching_cleans_accents_punctuation_case_and_the_media_extension():
    """`Película (2016).1080p.mkv` on disk vs the arr's release title without
    the container: the same cleaned key, one match."""
    result, _ = _classify(
        ["Película (2016).1080p.mkv"],
        history=[_history("Película (2016).1080p")],
    )

    assert result["Película (2016).1080p.mkv"]["provenance"] == "history"


# ── Degradation: display-only never blocks ────────────────────────────────────


def test_dead_sources_degrade_to_no_chips_instead_of_raising():
    """An arr down or the registry unreadable yields an empty answer — the
    listing must still render, with no chips and no 500."""
    result, _ = _classify(
        ["Movie.2016.mkv"],
        sources=_Sources(fail={"queue", "history", "own"}),
    )

    assert result == {}


def test_an_empty_listing_asks_for_nothing():
    """A browsed empty directory must not pay for a single outbound call."""
    _, src = _classify([], queue=[_queue("Movie.2016.mkv")])

    assert src.calls == {"queue": 0, "history": 0, "own": 0}


# ── The TTL ───────────────────────────────────────────────────────────────────


def test_a_repeated_listing_inside_the_ttl_fetches_the_arrs_once():
    """The whole point of the cache: browsing must not multiply into a fan-out
    per directory view. The own registry is read again on purpose — it is the
    local, cheap source and must reflect a grab made between two listings."""
    _, src = _classify(["Movie.2016.mkv"], queue=[_queue("Movie.2016.mkv")], now=1_000.0)
    _, src = _classify(["Otra.mkv"], queue=[_queue("Otra.mkv")], sources=src, now=1_000.0)

    assert src.calls["queue"] == 1, "the second listing paid for the arr again"
    assert src.calls["history"] == 1
    assert src.calls["own"] == 2, "the local registry is deliberately fresh per call"


def test_the_snapshot_expires_and_the_arrs_are_asked_again():
    _, src = _classify(["Movie.2016.mkv"], now=1_000.0)
    stale = 1_000.0 + provenance_module._PROVENANCE_TTL + 1
    _classify(["Movie.2016.mkv"], sources=src, now=stale)

    assert src.calls["queue"] == 2, "an expired snapshot must be rebuilt"
