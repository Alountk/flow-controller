"""T8: file events invalidate the movie-classes rows they can change.

The seams the backend already uses to touch disk must leave no stale chips row
behind (L7 «eventos + cálculo al vuelo»): the very next `/api/wanted/all` read
recomputes the affected movies from disk. The store is bound through
`application.gateways.history`, exactly as the composition root binds it.
"""

from __future__ import annotations

import pytest

import config
from application import gateways
from application.use_cases import place_file
from application.use_cases.copy_files import copy_files
from application.use_cases.duplicate_delete import delete_duplicate
from application.use_cases.library_rename import apply_rename
from infrastructure import sqlite_history as history


@pytest.fixture
def store(tmp_path, monkeypatch):
    """A tmp movie-classes store, bound like the app binds it at startup."""
    history.close()
    history.init_db(tmp_path / "history.db")
    monkeypatch.setattr(gateways, "history", history)
    yield
    history.close()


def test_rename_path_drops_the_rows_of_the_movie_folder_it_touches(store, tmp_path):
    folder = tmp_path / "A (2020)"
    folder.mkdir()
    old = folder / "a.mkv"
    old.write_bytes(b"x")
    new = folder / "b.mkv"
    history.save_movie_classes(str(folder), {"1080p": str(old)}, verified_at=1.0)

    result = place_file.rename_path(str(old), str(new))

    assert result["ok"]
    assert history.fetch_movie_classes([str(folder)]) == {}


def test_delete_path_drops_the_rows_of_the_movie_folder_it_touches(store, tmp_path):
    folder = tmp_path / "A (2020)"
    folder.mkdir()
    victim = folder / "a.mkv"
    victim.write_bytes(b"x")
    history.save_movie_classes(str(folder), {"1080p": str(victim)}, verified_at=1.0)

    result = place_file.delete_path(str(victim))

    assert result["ok"]
    assert history.fetch_movie_classes([str(folder)]) == {}


def test_move_path_drops_the_rows_of_both_ends(store, tmp_path):
    a = tmp_path / "A (2020)"
    b = tmp_path / "B (2021)"
    a.mkdir()
    b.mkdir()
    src = a / "a.mkv"
    src.write_bytes(b"x")
    dst = b / "b.mkv"
    history.save_movie_classes(str(a), {"1080p": str(src)}, verified_at=1.0)
    history.save_movie_classes(str(b), {"1080p": str(b / "old.mkv")}, verified_at=1.0)

    place_file.move_path(str(src), str(dst), {})

    assert history.fetch_movie_classes([str(a), str(b)]) == {}


class _TouchStorage:
    """A `FileStorage` that writes the destination and nothing else."""

    def copy_file(self, src, dst, *, is_cancelled=None, on_progress=None) -> int:
        data = src.read_bytes()
        dst.write_bytes(data)
        return len(data)


def test_copy_files_drops_the_movie_named_by_the_entry_it_writes(store, tmp_path):
    src = tmp_path / "descargas" / "A (2020).mkv"
    src.parent.mkdir()
    src.write_bytes(b"x")
    root = tmp_path / "4k"
    history.save_movie_classes("/lib/A (2020)", {"1080p": "/lib/A (2020)/a.mkv"}, verified_at=1.0)

    result = copy_files(src, root, storage=_TouchStorage())

    assert result["ok"]
    assert history.fetch_movie_classes(["/lib/A (2020)"]) == {}


def test_delete_duplicate_drops_the_rows_citing_the_deleted_file(store, tmp_path, monkeypatch):
    root = tmp_path / "media"
    folder = root / "A (2020)"
    folder.mkdir(parents=True)
    video = folder / "a.mkv"
    video.write_bytes(b"x")
    monkeypatch.setattr(config, "ALLOWED_ROOTS", [str(root)], raising=False)
    monkeypatch.setattr(config, "host_path", lambda p: p.replace("/data", str(root)), raising=False)
    history.save_movie_classes(str(folder), {"1080p": str(video)}, verified_at=1.0)

    delete_duplicate(str(video))

    assert history.fetch_movie_classes([str(folder)]) == {}


def test_apply_rename_drops_the_rows_citing_what_it_moved(store, tmp_path):
    root = tmp_path / "4k"
    root.mkdir()
    video = root / "A (2020).mkv"
    video.write_bytes(b"x")
    history.save_movie_classes("/lib/A (2020)", {"4K": str(video)}, verified_at=1.0)

    result = apply_rename(
        video_path=str(video),
        folder="",
        stem="A (2020) nuevo",
        siblings=[],
        roots=[str(root)],
        blocked=lambda path, verb: None,
    )

    assert result["ok"]
    assert history.fetch_movie_classes(["/lib/A (2020)"]) == {}
