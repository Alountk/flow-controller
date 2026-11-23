"""The explorer's copy/move queue refuses a file that does not fit its folder.

A 2160p file going into a non-4K folder (or the reverse) is answered with
`needs_confirmation` and nothing is queued; the explorer then offers the
folder that does fit. Rows queued by an arr flow (`host`) are not judged here:
that UI has no confirmation step.
"""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import config
from app import app
from state import file_queue

client = TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def folders(tmp_path, monkeypatch):
    root = tmp_path / "media"
    (root / "4k").mkdir(parents=True)
    (root / "movies").mkdir()
    (root / "movies" / "a.mkv").write_bytes(b"x")
    monkeypatch.setattr(config, "ALLOWED_ROOTS", [str(root.resolve())])
    monkeypatch.setattr(config, "PATH_4K", str((root / "4k").resolve()))
    file_queue.clear()
    yield root.resolve()
    file_queue.clear()


def _add(root, dst_dir, **extra):
    body = {"source": "copy", "remote_path": str(root / "movies" / "a.mkv"),
            "local_path": f"{dst_dir}/a.mkv", **extra}
    with patch("interfaces.http.routes.files._ensure_consumer"):
        return client.post("/api/files/queue/add", json=body).json()


def _probe(resolution):
    return patch("interfaces.http.routes.files.probe_file", lambda path: {"resolution": resolution})


def test_a_4k_file_going_to_a_library_folder_asks_and_queues_nothing(folders):
    with _probe("2160"):
        body = _add(folders, folders / "movies")

    assert body["ok"] is False and body["needs_confirmation"] is True
    assert body["mismatch"]["suggested"] == str(folders / "4k")
    assert file_queue == []


def test_a_1080_file_going_to_the_4k_folder_asks_without_a_suggestion(folders):
    with _probe("1080"):
        body = _add(folders, folders / "4k")

    assert body["needs_confirmation"] is True
    assert body["mismatch"]["suggested"] == ""
    assert file_queue == []


def test_a_file_that_fits_is_queued_as_before(folders):
    with _probe("2160"):
        body = _add(folders, folders / "4k")

    assert body["ok"] is True
    assert len(file_queue) == 1


def test_an_unmeasurable_file_is_queued_as_before(folders):
    def boom(path):
        raise RuntimeError("no ffprobe")

    with patch("interfaces.http.routes.files.probe_file", boom):
        body = _add(folders, folders / "movies")

    assert body["ok"] is True


def test_a_row_queued_by_an_arr_flow_is_not_judged(folders):
    with _probe("2160"):
        body = _add(folders, folders / "movies", host="radarr")

    assert body["ok"] is True
