import sqlite3

import pytest

from application.ports import SESSION_TTL_SECONDS
from infrastructure.auth_store import AuthStore


class Clock:
    def __init__(self):
        self.now = 1_000.0

    def __call__(self):
        return self.now


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def store(tmp_path, clock):
    return AuthStore(tmp_path / "auth.db", clock=clock)


class TestSingleUser:
    def test_a_fresh_store_has_no_user(self, store):
        assert store.has_user() is False

    def test_creating_the_user_works_once(self, store):
        assert store.create_user("raul", "correct horse") is True
        assert store.has_user() is True
        assert store.create_user("other", "another pass 1") is False

    def test_the_first_user_survives_a_second_attempt(self, store):
        store.create_user("raul", "correct horse")
        store.create_user("intruder", "intruder pass 1")

        assert store.verify_login("raul", "correct horse") is True
        assert store.verify_login("intruder", "intruder pass 1") is False

    @pytest.mark.parametrize("username,password", [("", "long enough pw"), ("   ", "long enough pw"), ("raul", "short")])
    def test_weak_or_empty_input_is_refused(self, store, username, password):
        with pytest.raises(ValueError):
            store.create_user(username, password)
        assert store.has_user() is False


class TestLogin:
    def test_the_right_pair_logs_in_and_every_other_pair_does_not(self, store):
        store.create_user("raul", "correct horse")

        assert store.verify_login("raul", "correct horse") is True
        assert store.verify_login("raul", "wrong horse!!") is False
        assert store.verify_login("RAUL", "correct horse") is False
        assert store.verify_login("", "correct horse") is False

    def test_nobody_logs_in_before_a_user_exists(self, store):
        assert store.verify_login("raul", "correct horse") is False
        assert store.verify_login("", "") is False

    def test_the_password_is_not_stored_in_clear(self, store, tmp_path):
        store.create_user("raul", "correct horse")

        with sqlite3.connect(tmp_path / "auth.db") as db:
            (stored,) = db.execute("SELECT pw_hash FROM users").fetchone()

        assert "correct horse" not in stored
        assert stored.startswith("scrypt$")

    def test_two_users_with_the_same_password_get_different_hashes(self, tmp_path):
        a, b = AuthStore(tmp_path / "a.db"), AuthStore(tmp_path / "b.db")
        a.create_user("raul", "correct horse")
        b.create_user("raul", "correct horse")

        with sqlite3.connect(tmp_path / "a.db") as da, sqlite3.connect(tmp_path / "b.db") as db:
            assert da.execute("SELECT pw_hash FROM users").fetchone() != db.execute("SELECT pw_hash FROM users").fetchone()


class TestSessions:
    def test_a_created_session_is_valid_and_a_made_up_one_is_not(self, store):
        token = store.create_session()

        assert store.session_valid(token) is True
        assert store.session_valid("not-a-token") is False
        assert store.session_valid("") is False

    def test_the_token_itself_is_never_stored(self, store, tmp_path):
        token = store.create_session()

        with sqlite3.connect(tmp_path / "auth.db") as db:
            rows = db.execute("SELECT token_hash FROM sessions").fetchall()

        assert rows and all(token not in row[0] for row in rows)

    def test_a_session_expires(self, store, clock):
        token = store.create_session()
        clock.now += SESSION_TTL_SECONDS + 1

        assert store.session_valid(token) is False

    def test_logout_kills_only_that_session(self, store):
        mine, other = store.create_session(), store.create_session()
        store.delete_session(mine)

        assert store.session_valid(mine) is False
        assert store.session_valid(other) is True

    def test_sessions_survive_a_restart(self, store, tmp_path, clock):
        token = store.create_session()

        assert AuthStore(tmp_path / "auth.db", clock=clock).session_valid(token) is True


class TestReadingNeverCreatesTheFile:
    def test_a_store_nobody_wrote_to_stays_absent_and_answers_no(self, tmp_path):
        path = tmp_path / "config" / "auth.db"
        store = AuthStore(path)

        assert store.has_user() is False
        assert store.verify_login("raul", "correct horse") is False
        assert store.session_valid("anything") is False
        assert not path.exists() and not path.parent.exists()

    def test_an_existing_but_corrupt_file_raises_instead_of_reading_as_empty(self, tmp_path):
        path = tmp_path / "auth.db"
        path.write_bytes(b"this is not a database")

        with pytest.raises(sqlite3.DatabaseError):
            AuthStore(path).has_user()
