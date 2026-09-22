"""Tests for the pure copy decision (T3) and its identity (T4).

No network and no fixtures: these are plain functions over a trace dict, so
every rule and every key shape is pinned by constructing the exact trace that
reaches it.
"""

from pathlib import Path

from auto_copy import (
    COPY,
    DEFAULT_GRAB_WINDOW_SECONDS,
    DEFAULT_GRACE_SECONDS,
    GRAB_CLOCK_SKEW_SECONDS,
    SKIP,
    UNIDENTIFIED,
    WAIT,
    auto_copy_key,
    decide_copy,
    matches_own_grab,
)

MODULE_PATH = Path(__file__).resolve().parent / "auto_copy.py"


def _trace(stage=None, queue=None):
    trace = {}
    if stage is not None:
        trace["stage"] = stage
    if queue is not None:
        trace["queue"] = queue
    return trace


def test_skips_a_grab_the_app_did_not_launch():
    result = decide_copy(_trace("downloaded"), now=10_000, since=0, is_own_grab=False)
    assert result["decision"] == SKIP
    assert "grab lanzado desde la app" in result["reason"]


def test_skips_when_already_copied():
    result = decide_copy(_trace("downloaded"), now=10_000, since=0, already_handled=True)
    assert result["decision"] == SKIP
    assert result["reason"] == "ya se copió antes"


def test_skips_when_the_arr_already_has_the_file():
    result = decide_copy(_trace("downloaded"), now=10_000, since=0, arr_has_file=True)
    assert result["decision"] == SKIP
    assert result["reason"] == "el arr ya tiene el fichero"


def test_skips_a_failed_download():
    result = decide_copy(_trace("failed"), now=10_000, since=0)
    assert result["decision"] == SKIP
    assert result["reason"] == "la descarga falló"


def test_waits_while_the_download_is_still_running():
    for stage in ("sent", "downloading"):
        result = decide_copy(_trace(stage), now=10_000, since=0)
        assert result["decision"] == WAIT, stage
        assert "sigue en curso" in result["reason"]


def test_waits_while_the_arr_is_importing():
    result = decide_copy(_trace("importing"), now=10_000, since=0)
    assert result["decision"] == WAIT
    assert "no se compite con él" in result["reason"]


def test_waits_on_a_healthy_import_pending_because_the_arr_is_not_stuck():
    # derive_stage maps importPending to import_blocked, but importPending is
    # ALSO the normal transient state right before a healthy import. The tie
    # breaker is queue["status"]: without a warning there is no proof the arr
    # is stuck, so copying here is exactly the race D2 forbids.
    queue = {"state": "importPending", "status": "ok"}
    result = decide_copy(_trace("import_blocked", queue), now=10_000, since=9_999)
    assert result["decision"] == WAIT
    assert "gracia" in result["reason"]


def test_copies_immediately_on_an_import_warning_without_a_time_reference():
    queue = {"state": "importPending", "status": "warning"}
    result = decide_copy(_trace("import_blocked", queue), now=10_000, since=None)
    assert result["decision"] == COPY
    assert "warning" in result["reason"]


def test_an_import_warning_still_copies_when_the_probe_could_not_answer():
    # The arr has already told us it is stuck, so this path must not depend on
    # a probe. A transient probe failure here must never disable the one path
    # that works today.
    queue = {"state": "importPending", "status": "warning"}
    result = decide_copy(
        _trace("import_blocked", queue),
        now=DEFAULT_GRACE_SECONDS + 1,
        since=0,
        arr_has_file=None,
    )
    assert result["decision"] == COPY
    assert "warning" in result["reason"]


def test_waits_just_inside_the_grace_window():
    result = decide_copy(_trace("downloaded"), now=DEFAULT_GRACE_SECONDS - 1, since=0)
    assert result["decision"] == WAIT
    assert "ventana de gracia" in result["reason"]


def test_copies_just_after_the_grace_window_when_the_arr_has_no_file():
    result = decide_copy(
        _trace("downloaded"),
        now=DEFAULT_GRACE_SECONDS + 1,
        since=0,
        arr_has_file=False,
    )
    assert result["decision"] == COPY
    assert "no lo importó" in result["reason"]


def test_a_future_since_waits_like_within_the_grace():
    result = decide_copy(_trace("downloaded"), now=1_000, since=2_000)
    assert result["decision"] == WAIT


def test_arr_has_file_false_does_not_skip():
    result = decide_copy(
        _trace("downloaded"),
        now=DEFAULT_GRACE_SECONDS + 1,
        since=0,
        arr_has_file=False,
    )
    assert result["decision"] == COPY


def test_arr_has_file_unknown_waits_after_the_window():
    # `None` is "the arr could not be asked", NOT "the arr has no file". With a
    # reference from T10 the window can genuinely expire, so an unknown guard at
    # that point must wait rather than copy a file the arr may already have
    # imported (a duplicate in the library). Only a confident `False` copies.
    result = decide_copy(
        _trace("downloaded"),
        now=DEFAULT_GRACE_SECONDS + 1,
        since=0,
        arr_has_file=None,
    )
    assert result["decision"] == WAIT
    assert "no se pudo comprobar" in result["reason"]


def test_waits_without_a_time_reference():
    result = decide_copy(_trace("downloaded"), now=10_000, since=None)
    assert result["decision"] == WAIT
    assert "sin referencia temporal" in result["reason"]


def test_skips_an_unknown_stage():
    result = decide_copy(_trace("teleporting"), now=10_000, since=0)
    assert result["decision"] == SKIP
    assert "desconocido" in result["reason"]


def test_a_trace_missing_the_stage_fails_closed():
    result = decide_copy({}, now=10_000, since=0)
    assert result["decision"] == SKIP
    assert "desconocido" in result["reason"]


def test_a_trace_missing_the_queue_still_decides():
    result = decide_copy(_trace("import_blocked"), now=10_000, since=None)
    assert result["decision"] == WAIT
    assert "sin referencia temporal" in result["reason"]


def test_does_not_mutate_the_trace():
    trace = _trace("import_blocked", {"state": "importPending", "status": "warning"})
    before = dict(trace)
    decide_copy(trace, now=10_000, since=0)
    assert trace == before


# ── Identity: auto_copy_key (T4) ─────────────────────────────────────────────
#
# The key is the idempotency marker's identity. These tests pin the three
# shapes and, above all, that the padded and unpadded forms of one download are
# the same key: getting that wrong repeats a copy or skips one that is due.

# A real client hash: 40 characters, the arr pads it with eight zeros.
PLAIN_ID = "467250d5" + "b" * 28 + "414a"
PADDED_ID = PLAIN_ID.upper() + "00000000"


def _id_trace(download_id=None, movie_id=None, episode_id=None, source="radarr"):
    ids = {}
    if movie_id is not None:
        ids["movie_id"] = movie_id
    if episode_id is not None:
        ids["episode_id"] = episode_id
    return {"source": source, "download_id": download_id, "ids": ids}


def test_the_padded_and_unpadded_download_id_produce_the_same_key():
    padded = auto_copy_key(_id_trace(download_id=PADDED_ID))
    plain = auto_copy_key(_id_trace(download_id=PLAIN_ID))

    assert padded == plain == f"radarr:{PLAIN_ID}"


def test_two_different_downloads_get_different_keys():
    first = auto_copy_key(_id_trace(download_id=PLAIN_ID))
    second = auto_copy_key(_id_trace(download_id="c" * 40))

    assert first != second


def test_a_genuine_40_character_id_ending_in_zeros_is_not_truncated():
    # No tail past 40 characters: these zeros are part of the id, not padding.
    download_id = "a" * 36 + "0000"

    assert auto_copy_key(_id_trace(download_id=download_id)) == f"radarr:{download_id}"


def test_the_download_id_wins_over_the_title_id():
    key = auto_copy_key(_id_trace(download_id=PLAIN_ID, movie_id=855))

    assert key == f"radarr:{PLAIN_ID}"


def test_falls_back_to_the_movie_title_id():
    assert auto_copy_key(_id_trace(movie_id=855)) == "radarr:title:movie:855"


def test_falls_back_to_the_episode_title_id():
    trace = {"source": "sonarr", "download_id": "", "ids": {"episode_id": 2286}}

    assert auto_copy_key(trace) == "sonarr:title:episode:2286"


def test_a_trace_with_no_id_returns_a_stable_documented_sentinel():
    """No identity can be derived, so the key must never be persisted: every
    unidentified trace shares this value and a marker on it would block
    unrelated downloads."""
    key = auto_copy_key(_id_trace())

    assert key == f"radarr:title:{UNIDENTIFIED}"
    assert auto_copy_key(_id_trace()) == key


def test_the_source_separates_otherwise_identical_downloads():
    radarr = auto_copy_key(_id_trace(download_id=PLAIN_ID, source="radarr"))
    sonarr = auto_copy_key(_id_trace(download_id=PLAIN_ID, source="sonarr"))

    assert radarr != sonarr


def test_the_policy_module_has_no_side_effect_imports():
    source = MODULE_PATH.read_text()
    forbidden = (
        "aiohttp",
        "from state",
        "from history",
        "from config",
        "import os",
        "import time",
    )
    found = [token for token in forbidden if token in source]
    assert not found, (
        "the pure policy must not grow a session, a clock or configuration; "
        f"found: {found}"
    )


# ── Matching a trace against our own grabs (T5) ──────────────────────────────
#
# The arr's history is the input; this answers one yes/no question: did THIS app
# ask for that grab? The release guid cannot be used (in a grabbed record it is
# the client hash, not the indexer's guid), so the match is by title id + time.
# A false negative just leaves the status quo; a false positive makes the app
# act on a grab nobody asked it to touch (D3), so honest non-matches matter.

GRAB_AT = 10_000.0


def _iso(epoch: float) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _own_grab(
    *,
    source="radarr",
    movie_id=None,
    episode_id=None,
    series_id=None,
    guid="release-guid",
    indexer_id=1,
    grabbed_at=GRAB_AT,
):
    row = {"source": source, "guid": guid, "indexer_id": indexer_id, "grabbed_at": grabbed_at}
    if movie_id is not None:
        row["movie_id"] = movie_id
    if episode_id is not None:
        row["episode_id"] = episode_id
    if series_id is not None:
        row["series_id"] = series_id
    return row


def _trace_for(*, source="radarr", movie_id=None, episode_id=None, date=None):
    ids = {}
    if movie_id is not None:
        ids["movie_id"] = movie_id
    if episode_id is not None:
        ids["episode_id"] = episode_id
    trace = {"source": source, "ids": ids}
    if date is not None:
        trace["date"] = date
    return trace


def test_matches_a_trace_for_the_same_movie():
    assert matches_own_grab(
        _trace_for(movie_id=855, date=_iso(GRAB_AT + 3)),
        [_own_grab(movie_id=855)],
    )


def test_matches_a_trace_for_the_same_episode():
    assert matches_own_grab(
        _trace_for(source="sonarr", episode_id=2286, date=_iso(GRAB_AT + 3)),
        [_own_grab(source="sonarr", episode_id=2286, series_id=28)],
    )


def test_a_different_source_does_not_match():
    assert not matches_own_grab(
        _trace_for(source="sonarr", movie_id=855, date=_iso(GRAB_AT + 3)),
        [_own_grab(source="radarr", movie_id=855)],
    )


def test_a_different_title_id_does_not_match():
    assert not matches_own_grab(
        _trace_for(movie_id=856, date=_iso(GRAB_AT + 3)),
        [_own_grab(movie_id=855)],
    )


def test_a_trace_just_inside_the_window_matches():
    # The arr stamps the row AFTER our request, so the upper bound is inclusive.
    assert matches_own_grab(
        _trace_for(movie_id=855, date=_iso(GRAB_AT + DEFAULT_GRAB_WINDOW_SECONDS)),
        [_own_grab(movie_id=855)],
    )


def test_a_trace_just_outside_the_window_does_not_match():
    # A later, unrelated grab of the same title must not be attributed to us.
    assert not matches_own_grab(
        _trace_for(movie_id=855, date=_iso(GRAB_AT + DEFAULT_GRAB_WINDOW_SECONDS + 1)),
        [_own_grab(movie_id=855)],
    )


def test_a_trace_just_inside_the_clock_skew_matches():
    assert matches_own_grab(
        _trace_for(movie_id=855, date=_iso(GRAB_AT - GRAB_CLOCK_SKEW_SECONDS)),
        [_own_grab(movie_id=855)],
    )


def test_a_trace_older_than_the_clock_skew_does_not_match():
    assert not matches_own_grab(
        _trace_for(movie_id=855, date=_iso(GRAB_AT - GRAB_CLOCK_SKEW_SECONDS - 1)),
        [_own_grab(movie_id=855)],
    )


def test_a_trace_with_no_date_does_not_match():
    assert not matches_own_grab(_trace_for(movie_id=855), [_own_grab(movie_id=855)])


def test_a_trace_with_an_unparseable_date_does_not_match():
    assert not matches_own_grab(
        _trace_for(movie_id=855, date="no-es-una-fecha"),
        [_own_grab(movie_id=855)],
    )


def test_a_trace_with_no_title_identity_does_not_match():
    # Not provably ours is answered honestly: no match, never a guess.
    trace = _trace_for(date=_iso(GRAB_AT + 3))

    assert not matches_own_grab(trace, [_own_grab(movie_id=855)])


def test_an_empty_registry_does_not_match():
    assert not matches_own_grab(
        _trace_for(movie_id=855, date=_iso(GRAB_AT + 3)), []
    )


def test_a_row_without_a_grabbed_at_does_not_match():
    assert not matches_own_grab(
        _trace_for(movie_id=855, date=_iso(GRAB_AT + 3)),
        [_own_grab(movie_id=855, grabbed_at=None)],
    )
