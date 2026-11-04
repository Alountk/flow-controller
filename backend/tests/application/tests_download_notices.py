"""What gets shouted about, decided without a single byte of I/O.

`plan_for_downloads` and `plan_for_folder` are pure on purpose: the interesting
half of C-01 is the rule ("this one finished", "this one landed"), and a rule
that can only be observed through a socket cannot be pinned down. The emitting
half — store, channel, retries — is `tests_notices_store.py`.
"""

from application.use_cases.download_notices import (
    NOTICE_A,
    NOTICE_B,
    plan_for_downloads,
    plan_for_folder,
)


def _finished(source="radarr", ident="1", title="Una película", **overrides):
    download = {
        "id": ident,
        "source": source,
        "title": title,
        "tracked_state": "importPending",
        "progress": 100.0,
        "size": 1000,
        "sizeleft": 0,
    }
    download.update(overrides)
    return download


def _moving(source="radarr", ident="2", **overrides):
    download = _finished(source=source, ident=ident, progress=41.0, sizeleft=590)
    download.update(overrides)
    return download


# --- S3, torrent: the client finished --------------------------------------


def test_a_finished_download_is_notice_a():
    planned = plan_for_downloads([_finished()], state={})

    assert [(p["notice"], p["key"]) for p in planned] == [(NOTICE_A, "radarr:1")]
    assert "Una película" in planned[0]["message"]


def test_a_download_still_running_is_silence():
    assert plan_for_downloads([_moving()], state={}) == []


def test_sizeleft_zero_finishes_it_too():
    """The arr reports bytes left even when `progress` rounds below 100."""
    download = _moving(progress=99.4, sizeleft=0)

    assert [p["notice"] for p in plan_for_downloads([download], state={})] == [NOTICE_A]


def test_the_key_is_source_and_id_so_two_services_never_collide():
    planned = plan_for_downloads(
        [_finished(source="radarr", ident="7"), _finished(source="sonarr", ident="7")],
        state={},
    )

    assert sorted(p["key"] for p in planned) == ["radarr:7", "sonarr:7"]


# --- S5: two different notices, not one twice ------------------------------


def test_lands_as_notice_b_when_the_arr_says_imported():
    download = _finished(tracked_state="imported")

    planned = plan_for_downloads([download], state={})

    assert [(p["notice"], p["key"]) for p in planned] == [(NOTICE_B, "radarr:1")]
    assert planned[0]["title"] != ""


def test_pending_and_importing_are_not_b():
    """Son «el cliente terminó», no «quedó importado»: A, nunca B."""
    for state in ("importPending", "importing"):
        planned = plan_for_downloads([_finished(tracked_state=state)], state={})
        assert [p["notice"] for p in planned] == [NOTICE_A], state


def test_a_and_b_are_two_notices_of_the_same_thing():
    """S5: A already sent, B lands — the second one is not suppressed by the first."""
    planned = plan_for_downloads(
        [_finished(tracked_state="imported")],
        state={("radarr:1", NOTICE_A): (1, 1)},
    )

    assert [(p["notice"], p["key"]) for p in planned] == [(NOTICE_B, "radarr:1")]


# --- S6: neither twice, nor on a loop --------------------------------------


def test_an_already_sent_notice_is_not_planned_again():
    download = _finished()

    assert plan_for_downloads([download], state={("radarr:1", NOTICE_A): (1, 1)}) == []


def test_a_failed_send_is_retried_until_the_third_attempt():
    key = ("radarr:1", NOTICE_A)

    assert plan_for_downloads([_finished()], state={key: (0, 1)}) != []
    assert plan_for_downloads([_finished()], state={key: (0, 2)}) != []


def test_after_three_failed_attempts_it_is_given_up_on():
    """A broken channel cannot be hammered every three seconds, forever."""
    assert plan_for_downloads([_finished()], state={("radarr:1", NOTICE_A): (0, 3)}) == []


def test_the_same_snapshot_twice_plans_the_same_single_notice():
    download = _finished()

    first = plan_for_downloads([download], state={})
    second = plan_for_downloads([download], state={("radarr:1", NOTICE_A): (1, 1)})

    assert len(first) == 1 and second == []


# --- S3, aMule: the folder is the only progress there is -------------------


def test_a_stable_size_in_the_folder_is_notice_a():
    planned = plan_for_folder({"/incoming/a.mkv": 900}, {"/incoming/a.mkv": 900}, state={})

    assert [(p["notice"], p["key"]) for p in planned] == [(NOTICE_A, "amule:/incoming/a.mkv:900")]
    assert "a.mkv" in planned[0]["message"]


def test_a_growing_file_is_not_finished_yet():
    assert plan_for_folder({"/incoming/a.mkv": 400}, {"/incoming/a.mkv": 900}, state={}) == []


def test_a_file_seen_for_the_first_time_is_only_registered():
    """After a restart there is nothing to compare against: silence, not a lie."""
    assert plan_for_folder({}, {"/incoming/a.mkv": 900}, state={}) == []
    assert plan_for_folder(None, {"/incoming/a.mkv": 900}, state={}) == []


def test_a_vanished_file_plans_nothing():
    assert plan_for_folder({"/incoming/a.mkv": 900}, {}, state={}) == []


def test_the_amule_notice_is_not_sent_twice():
    key = ("amule:/incoming/a.mkv:900", NOTICE_A)

    assert plan_for_folder({"/incoming/a.mkv": 900}, {"/incoming/a.mkv": 900}, state={key: (1, 1)}) == []


def test_a_file_that_grew_to_a_new_stable_size_is_a_new_key():
    """Its own download: the smaller size stopped growing, then it grew again."""
    planned = plan_for_folder(
        {"/incoming/a.mkv": 900},
        {"/incoming/a.mkv": 1800},
        state={("amule:/incoming/a.mkv:900", NOTICE_A): (1, 1)},
    )

    assert planned == []  # still growing, nothing to say yet
    again = plan_for_folder(
        {"/incoming/a.mkv": 1800}, {"/incoming/a.mkv": 1800},
        state={("amule:/incoming/a.mkv:900", NOTICE_A): (1, 1)},
    )
    assert [p["key"] for p in again] == ["amule:/incoming/a.mkv:1800"]
