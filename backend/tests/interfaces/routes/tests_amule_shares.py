"""Shared folders of aMule: read from aMule, written back, then reloaded.

The feature exists because the alternative — configuring aMule by hand — is
the thing the maintainer asked to stop doing. What these tests pin down:

* the files aMule already owns stay the source of truth (we read and
  rewrite them, never a second copy in our own settings);
* a rejected path leaves **nothing** half-written;
* a path outside `allowed_roots` is refused, because publishing a folder to
  the ED2K network cannot be undone from here;
* a reload that fails is reported as *pending*, not as success — the files
  are written, but aMule has not seen them yet.
"""

import copy
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

import config
from app import app
from infrastructure import settings_store as settings_mod

client = TestClient(app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def _amule_config(tmp_path):
    """A private aMule config directory, restored after each test."""
    before = copy.deepcopy(settings_mod.get_settings())
    paths = settings_mod._settings.setdefault("paths", {})
    paths["amule_config"] = str(tmp_path)
    paths["allowed_roots"] = [str(tmp_path), "/mnt/storage", "/mnt/storage-6tb"]
    config.rebuild()
    yield tmp_path
    settings_mod._settings = before
    config.rebuild()


def _put(payload: dict, reload_ok: bool = True):
    with patch(
        "interfaces.http.routes.amule_shares.amutorrent_reload_shared_dirs",
        new=AsyncMock(return_value={"ok": reload_ok, "detail": "recarga pedida a aMule"}),
    ) as reload:
        return client.put("/api/amule/shared-dirs", json=payload), reload


class TestItReadsWhatAMuleHas:
    def test_both_lists_come_from_aMule_own_files(self, _amule_config):
        (_amule_config / "shareddir-recursive.dat").write_text(
            "/mnt/storage/movies\n\n/mnt/storage-6tb/shared-media\n"
        )
        (_amule_config / "shareddir-explicit.dat").write_text("/mnt/storage/music\n")

        body = client.get("/api/amule/shared-dirs").json()

        assert body["recursive"] == ["/mnt/storage/movies", "/mnt/storage-6tb/shared-media"]
        assert body["explicit"] == ["/mnt/storage/music"], "blank lines are not paths"
        assert body["config_dir"] == str(_amule_config)

    def test_a_fresh_aMule_with_no_files_reads_as_empty(self, _amule_config):
        """a fresh install has all three at 0 bytes — that is "nothing shared"."""
        body = client.get("/api/amule/shared-dirs").json()

        assert body["recursive"] == []
        assert body["explicit"] == []

    def test_it_advertises_the_roots_sharing_is_allowed_to_use(self, _amule_config):
        body = client.get("/api/amule/shared-dirs").json()

        assert "/mnt/storage-6tb" in body["allowed_roots"], (
            "the UI has to know what it may offer — otherwise every attempt is "
            "a 403 the user cannot have seen coming"
        )


class TestItWritesAndAsksAMuleToReload:
    def test_both_files_are_written_and_a_reload_is_requested(self, _amule_config):
        resp, reload = _put({
            "recursive": ["/mnt/storage/movies", "/mnt/storage-6tb/shared-media"],
            "explicit": [],
        })

        assert resp.status_code == 200
        assert reload.await_count == 1, "writing without reloading leaves aMule unaware"
        recursive = (_amule_config / "shareddir-recursive.dat").read_text()
        explicit = (_amule_config / "shareddir-explicit.dat").read_text()
        assert recursive == "/mnt/storage/movies\n/mnt/storage-6tb/shared-media\n"
        assert explicit == ""

    def test_the_response_carries_what_is_now_configured(self, _amule_config):
        resp, _ = _put({"recursive": ["/mnt/storage/movies"], "explicit": []})

        body = resp.json()
        assert body["recursive"] == ["/mnt/storage/movies"]
        assert body["ok"] is True

    def test_a_path_is_kept_once_even_if_sent_twice(self, _amule_config):
        resp, _ = _put({"recursive": ["/mnt/storage/movies", "/mnt/storage/movies/"], "explicit": []})

        assert resp.json()["recursive"] == ["/mnt/storage/movies"], (
            "aMule regenerates its union from these — duplicates would survive it"
        )


class TestItRefusesBeforeItWrites:
    def test_a_relative_path_is_rejected(self, _amule_config):
        resp, reload = _put({"recursive": ["etc/passwd"], "explicit": []})

        assert resp.status_code == 422
        assert reload.await_count == 0, "nothing may be written once a path is refused"

    def test_a_path_outside_allowed_roots_is_rejected(self, _amule_config):
        resp, _ = _put({"recursive": ["/etc"], "explicit": []})

        assert resp.status_code == 403, resp.text
        assert not (_amule_config / "shareddir-recursive.dat").exists(), (
            "refusal must leave aMule's configuration untouched"
        )

    def test_the_config_directory_that_does_not_exist_is_reported_not_guessed(self):
        settings_mod._settings.setdefault("paths", {})["amule_config"] = "/definitely/not/here"

        resp, reload = _put({"recursive": ["/mnt/storage/movies"], "explicit": []})

        assert resp.status_code == 503
        assert reload.await_count == 0


class TestReloadFailureIsNotSilent:
    def test_written_but_not_reloaded_reads_as_pending(self, _amule_config):
        resp, _ = _put({"recursive": ["/mnt/storage/movies"], "explicit": []}, reload_ok=False)

        body = resp.json()
        assert body["ok"] is False, "the files are written but aMule has not seen them"
        assert body["reload"]["ok"] is False
        assert (_amule_config / "shareddir-recursive.dat").read_text() == "/mnt/storage/movies\n", (
            "the change is kept, not rolled back — it only needs a reload"
        )
