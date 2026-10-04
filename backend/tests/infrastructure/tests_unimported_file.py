"""``has_unimported_file`` — the disk truth Radarr's ``hasFile`` does not carry.

``hasFile: false`` means *Radarr has not imported a file*, not *the bytes are
not on disk*: the real library held titles whose folder plainly contained a
video (Luca) while the UI claimed "✗ Sin archivo" over it. Radarr's data was
right; our copy of the truth was not. This field answers the question neither
side asks: does the folder hold a video Radarr never imported?

The check is bounded on purpose. It runs ONLY for titles with
``hasFile: false`` — 65 of 913 on the real library — because running it for
the imported 848 would turn one Biblioteca request into a full directory walk
of an NFS mount per page. ``test_an_imported_movie_never_reads_its_folder``
pins that boundary.
"""

import asyncio
from unittest.mock import patch

from infrastructure import arr_client as clients
from infrastructure.arr_client import fetch_all_movies_detailed
from tests._stubs import CONFIGURED_RADARR_URL, _StubSession, client

RADARR_URL = CONFIGURED_RADARR_URL


def _movie(has_file: bool, path: str, movie_id: int = 1, title: str = "Película") -> dict:
    return {
        "id": movie_id,
        "title": title,
        "year": 2021,
        "hasFile": has_file,
        "path": path,
        "monitored": True,
    }


def _service() -> dict:
    return {"key": "radarr", "kind": "arr", "url": RADARR_URL, "api_key": "test-key"}


def _item(payload) -> dict:
    routes = {f"{RADARR_URL}/api/v3/movie": (200, payload)}
    session = _StubSession(routes)
    result = asyncio.run(fetch_all_movies_detailed(session, _service()))
    return result["items"][0]


# ── the folder's contents decide, nothing else ───────────────────────────────


def test_a_folder_with_a_video_reads_as_has_unimported_file(tmp_path):
    """The Luca case: Radarr never imported it, the .mkv is right there."""
    (tmp_path / "Película (2021) Bluray-1080p.mkv").write_bytes(b"x")
    (tmp_path / "Película (2021).srt").write_text("")
    (tmp_path / "movie.nfo").write_text("")

    item = _item([_movie(False, str(tmp_path))])

    assert item["has_unimported_file"] is True


def test_a_folder_with_only_sidecar_files_reads_as_not_imported(tmp_path):
    """The Enola Holmes 3 case: .nfo/.srt next to no video — Radarr is right."""
    (tmp_path / "movie.nfo").write_text("")
    (tmp_path / "Película (2021).srt").write_text("")

    item = _item([_movie(False, str(tmp_path))])

    assert item["has_unimported_file"] is False


def test_a_non_video_file_only_reads_as_false(tmp_path):
    """`MEDIA_EXTENSIONS` decides what counts as video; a stray .txt does not."""
    (tmp_path / "leeme.txt").write_text("")
    (tmp_path / "cover.jpg").write_bytes(b"")

    item = _item([_movie(False, str(tmp_path))])

    assert item["has_unimported_file"] is False


def test_a_missing_folder_reads_as_false(tmp_path):
    """No folder → nothing to have imported: False, and no exception."""
    item = _item([_movie(False, str(tmp_path / "no-existe"))])

    assert item["has_unimported_file"] is False


def test_an_unreadable_folder_reads_as_false_never_raises(monkeypatch, tmp_path):
    """A store of any kind must not fail the whole listing: an OSError deep in
    one NFS folder has to read as "no video found", not as a 500."""
    (tmp_path / "Película (2021).mkv").write_bytes(b"x")

    def locked(*_args, **_kwargs):
        raise PermissionError("NFS said no")

    monkeypatch.setattr(clients.os, "scandir", locked)

    item = _item([_movie(False, str(tmp_path))])

    assert item["has_unimported_file"] is False


# ── the cost boundary: only the unimported 65 pay for the check ──────────────


def test_an_imported_movie_never_reads_its_folder(monkeypatch, tmp_path):
    """848 of 913 titles have ``hasFile: true``. One Biblioteca request must
    not become hundreds of directory reads on an NFS mount, so for those the
    folder is never listed — this scandir patch turns any listing into a
    failure the fetch cannot swallow."""
    (tmp_path / "Película (2021).mkv").write_bytes(b"x")

    def forbidden(*_args, **_kwargs):
        raise AssertionError("a directory was listed for an imported movie")

    monkeypatch.setattr(clients.os, "scandir", forbidden)

    item = _item([_movie(True, str(tmp_path))])

    assert item["has_file"] is True
    assert item["has_unimported_file"] is False


# ── the whole thing, through the route the frontend actually calls ────────────


def test_the_wanted_route_carries_the_field_to_the_client(tmp_path):
    """`_filter_all_endpoint`/`_attach_grabbed_at` reshape the page — the new
    field must survive both, or the fix never reaches the screen."""
    (tmp_path / "Película (2021).mkv").write_bytes(b"x")
    payload = [
        _movie(False, str(tmp_path)),
        _movie(True, "/radarr/library/Película Importada (2020)", movie_id=2, title="Importada"),
    ]
    routes = {f"{CONFIGURED_RADARR_URL}/api/v3/movie": (200, payload)}

    with patch("aiohttp.ClientSession", lambda *a, **k: _StubSession(routes)):
        body = client.get("/api/wanted/all").json()

    by_id = {item["id"]: item for item in body["items"]}
    assert by_id[1]["has_unimported_file"] is True
    assert by_id[2]["has_unimported_file"] is False
