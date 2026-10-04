"""Retention for downloaded files: age tracked in SQLite, deletion stays manual.

The maintainer's decision, on the record: **"la decisión de borrado tiene
que ser mía, con un aviso de que si borro no podré recuperar los datos."**

So this endpoint never deletes anything. It answers two questions for a
directory: *how long has each file been here*, and *is it past the
retention window*. Deciding what to do about that is the UI's job, and
the UI's job to warn about.

The clock has to be persisted the first time a file is observed — a file's
mtime is not evidence of when *we* first saw it, and recomputing the clock
on every sweep would mean nothing ever expires.
"""

import copy
from unittest.mock import patch

import pytest

import config
from infrastructure import sqlite_history as history
from infrastructure import settings_store as settings_mod
from app import app
from fastapi.testclient import TestClient

client = TestClient(app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    """A private database and restored settings/constants per test."""
    before = copy.deepcopy(settings_mod.get_settings())
    history.close()
    history.init_db(tmp_path / "infrastructure.sqlite_history.db")
    yield
    history.close()
    settings_mod._settings = before
    config.rebuild()


def _files(directory):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "Movie.2016.mkv").write_bytes(b"x")
    (directory / "notes.txt").write_text("not a movie")
    return directory


def _get(directory):
    """Call the endpoint with path validation bypassed.

    `_validate_path` only admits `ALLOWED_ROOTS` (`/mnt/storage*`), and the
    tests use `tmp_path` — the real guard is asserted separately, in the
    rejection test below.
    """
    with patch("interfaces.http.routes.files._validate_path", side_effect=lambda p: p):
        return client.get("/api/files/retention", params={"path": str(directory)})


class TestTheClockStartsOnce:
    def test_a_new_file_is_recorded_the_first_time_it_is_seen(self, tmp_path):
        d = _files(tmp_path / "downloads")

        body = _get(d).json()

        names = sorted(f["name"] for f in body["files"])
        assert names == ["Movie.2016.mkv", "notes.txt"], (
            "every regular file in the folder is tracked — the explorer lists them all, "
            "so the retention view must too"
        )
        assert body["files"][0]["first_seen_at"] > 0
        assert body["files"][0]["age_days"] < 1

    def test_first_seen_is_never_refreshed(self, tmp_path):
        """The trap: re-recording on every sweep would make nothing expire."""
        import time

        d = _files(tmp_path / "downloads")
        target = str(d / "Movie.2016.mkv")
        _get(d)  # first observation records "now"
        observed = _get(d).json()["files"][0]["first_seen_at"]

        # An insert that tried to age it backwards must be a no-op...
        history.remember_downloads([target], now=time.time() - 40 * 86400)

        got = _get(d).json()["files"][0]["first_seen_at"]
        assert got == observed, (
            "a later observation moved first_seen_at — with a sweep running every few "
            "minutes nothing would ever reach the retention window"
        )


class TestExpiry:
    def test_a_file_past_the_window_is_expired(self, tmp_path):
        import time

        d = _files(tmp_path / "downloads")
        # Recorded 40 days BEFORE anything observes it, so the clock starts
        # there and the later observation must not move it.
        history.remember_downloads([str(d / "Movie.2016.mkv")], now=time.time() - 40 * 86400)

        body = _get(d).json()
        entry = body["files"][0]

        assert entry["age_days"] >= 40
        assert entry["expired"] is True
        assert body["days"] == config.RETENTION_AMULE_DAYS

    def test_a_fresh_file_is_not_expired(self, tmp_path):
        d = _files(tmp_path / "downloads")

        entry = _get(d).json()["files"][0]

        assert entry["expired"] is False

    def test_the_window_is_configurable(self, tmp_path):
        d = _files(tmp_path / "downloads")
        _get(d)
        settings_mod._settings.setdefault("retention", {})["amule_days"] = 1
        config.rebuild()

        body = _get(d).json()

        assert body["days"] == 1, "a saved retention window must reach the endpoint"


class TestItNeverDeletesAndNeverLeavesTheAllowedRoots:
    def test_the_endpoint_has_no_delete_side_effect(self, tmp_path):
        d = _files(tmp_path / "downloads")
        _get(d)

        assert (d / "Movie.2016.mkv").exists(), "marking must not remove anything"
        assert (d / "notes.txt").exists()

    def test_a_path_outside_the_allowed_roots_is_rejected(self):
        # No patch here: this one is about the real _validate_path.
        resp = client.get("/api/files/retention", params={"path": "/etc"})

        assert resp.status_code == 403, resp.text
