"""The memory of what was already announced (S6), which must outlive the process.

The interesting claim is not "a row was written" but "the row survives a
restart". So the test closes the database and opens it again — that is the
restart, without needing a second interpreter.
"""

import pytest

from infrastructure import sqlite_history as history


@pytest.fixture
def db(tmp_path):
    history.close()
    history.init_db(tmp_path / "history.db")
    yield

    history.close()


def test_nothing_is_known_before_anything_is_sent(db):
    assert history.notice_states([("radarr:1", "a")]) == {}


def test_a_sent_notice_is_remembered_as_sent(db):
    history.record_notice_attempt("radarr:1", "a", ok=True)

    assert history.notice_states([("radarr:1", "a")]) == {("radarr:1", "a"): (1, 1)}


def test_a_failed_send_keeps_the_counter_for_the_next_retry(db):
    history.record_notice_attempt("radarr:1", "a", ok=False)

    assert history.notice_states([("radarr:1", "a")]) == {("radarr:1", "a"): (0, 1)}


def test_attempts_accumulate_across_failures(db):
    for _ in range(3):
        history.record_notice_attempt("radarr:1", "a", ok=False)

    assert history.notice_states([("radarr:1", "a")]) == {("radarr:1", "a"): (0, 3)}


def test_a_late_success_marks_it_sent(db):
    history.record_notice_attempt("radarr:1", "a", ok=False)
    history.record_notice_attempt("radarr:1", "a", ok=True)

    assert history.notice_states([("radarr:1", "a")]) == {("radarr:1", "a"): (1, 2)}


def test_the_two_notices_of_one_download_are_separate_rows(db):
    history.record_notice_attempt("radarr:1", "a", ok=True)

    assert history.notice_states([("radarr:1", "a"), ("radarr:1", "b")]) == {
        ("radarr:1", "a"): (1, 1)
    }


def test_it_survives_a_restart(tmp_path):
    """The whole point: close the database, open it again, still know."""
    path = tmp_path / "history.db"
    history.close()
    history.init_db(path)
    history.record_notice_attempt("radarr:1", "a", ok=True)
    history.close()

    history.init_db(path)

    assert history.notice_states([("radarr:1", "a")]) == {("radarr:1", "a"): (1, 1)}
    history.close()


def test_the_migration_runs_twice_without_complaint(tmp_path):
    """`CREATE TABLE IF NOT EXISTS` discipline: a second startup is not a crash."""
    path = tmp_path / "history.db"
    history.close()
    history.init_db(path)
    history.record_notice_attempt("sonarr:9", "b", ok=True)
    history.close()

    history.init_db(path)
    history.init_db(path)

    assert history.notice_states([("sonarr:9", "b")]) == {("sonarr:9", "b"): (1, 1)}
    history.close()


def test_an_unavailable_store_says_nothing_rather_than_lying(db):
    """No database means "I don't know", and an unknown notice is not a sent one."""
    history.close()

    assert history.notice_states([("radarr:1", "a")]) == {}
    history.record_notice_attempt("radarr:1", "a", ok=True)  # must not raise
