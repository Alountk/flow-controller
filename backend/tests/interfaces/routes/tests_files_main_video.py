"""`GET /api/files/main-video` — the video a copied file or folder is about.

The rename dialog works on one video; after copying a folder the explorer only
knows the folder, so it asks which file inside is the movie.
"""

import pytest
from fastapi.testclient import TestClient

import config
from app import app

client = TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def root(tmp_path, monkeypatch):
    base = (tmp_path / "media").resolve()
    base.mkdir()
    monkeypatch.setattr(config, "ALLOWED_ROOTS", [str(base)])
    return base


def _get(path):
    return client.get("/api/files/main-video", params={"path": str(path)}).json()


def test_a_file_is_its_own_video(root):
    movie = root / "A.mkv"
    movie.write_bytes(b"x")

    assert _get(movie) == {"ok": True, "path": str(movie)}


def test_a_folder_answers_its_biggest_video(root):
    folder = root / "Release"
    folder.mkdir()
    (folder / "sample.mkv").write_bytes(b"x")
    (folder / "movie.mkv").write_bytes(b"x" * 100)
    (folder / "readme.txt").write_bytes(b"x" * 500)

    assert _get(folder) == {"ok": True, "path": str(folder / "movie.mkv")}


def test_a_folder_without_video_says_so(root):
    folder = root / "Empty"
    folder.mkdir()

    body = _get(folder)

    assert body["ok"] is False


def test_a_path_outside_the_roots_is_refused(root, tmp_path):
    outside = tmp_path / "other.mkv"
    outside.write_bytes(b"x")

    resp = client.get("/api/files/main-video", params={"path": str(outside)})

    assert resp.status_code == 403
