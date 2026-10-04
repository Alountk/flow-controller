"""`application.use_cases.copy_files` on a fake disk.

The point of the port: this file never touches a filesystem and never hears
about `copy_tasks`. If a change here needs either, the use case has grown an
import it should not have, and `tests_architecture.py` will have opinions.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from application.ports import CopyCancelled
from application.use_cases.copy_files import copy_files


class FakeStorage:
    """A `FileStorage` that records instead of moving bytes."""

    def __init__(self, *, size: int = 4, raise_after: int | None = None):
        self.written: list[tuple[str, str]] = []
        self.size = size
        self.raise_after = raise_after

    def copy_file(self, src, dst, *, is_cancelled=None, on_progress=None) -> int:
        if self.raise_after is not None and len(self.written) >= self.raise_after:
            # What the real one does when the operator stops it mid-file.
            raise CopyCancelled(f"cancelado durante copia de {src.name}")
        self.written.append((str(src), str(dst)))
        if on_progress:
            on_progress(self.size)
        return self.size


def test_a_single_file_keeps_its_name_unless_told_otherwise(tmp_path):
    src = tmp_path / "release.mkv"
    src.write_bytes(b"x")
    out = tmp_path / "library"

    storage = FakeStorage()
    copy_files(src, out, storage=storage)
    assert storage.written == [(str(src), str(out / "release.mkv"))]

    storage = FakeStorage()
    copy_files(src, out, storage=storage, target_name="Renamed (2020).mkv")
    assert storage.written == [(str(src), str(out / "Renamed (2020).mkv"))]


def test_a_tree_keeps_its_shape_and_ignores_target_name(tmp_path):
    """A folder rename cannot be done by renaming one file.

    Silently applying `target_name` to the first file would be worse than not
    honouring it: the payload would land under a name nobody chose for it.
    """
    src = tmp_path / "release"
    (src / "Subs").mkdir(parents=True)
    (src / "film.mkv").write_bytes(b"a")
    (src / "Subs" / "en.srt").write_bytes(b"b")
    out = tmp_path / "library"
    storage = FakeStorage()

    result = copy_files(src, out, storage=storage, target_name="Ignored.mkv")

    assert result["ok"] is True
    assert result["files_copied"] == 2
    destinations = {Path(d).relative_to(out).as_posix() for _, d in storage.written}
    assert destinations == {"film.mkv", "Subs/en.srt"}


def test_files_already_there_are_not_copied_again(tmp_path):
    """Counted before any total is reported, so the progress bar can finish.

    A bar that includes bytes it will never write is a bar that sits at 90%.
    """
    src = tmp_path / "release"
    src.mkdir()
    (src / "a.mkv").write_bytes(b"a")
    (src / "b.mkv").write_bytes(b"bbbb")  # four, so the totals below are legible
    out = tmp_path / "library"
    out.mkdir()
    (out / "a.mkv").write_bytes(b"already here")
    storage = FakeStorage()
    totals = []

    result = copy_files(src, out, storage=storage, on_progress=lambda *a: totals.append(a))

    assert result["files_copied"] == 1
    assert [Path(d).name for _, d in storage.written] == ["b.mkv"]
    assert totals[0][1] == 4  # b's real size only, not a's
    assert totals[0][3] == 1  # one file to do, not two


def test_cancellation_between_files_reports_where_it_stopped(tmp_path):
    src = tmp_path / "release"
    src.mkdir()
    for name in ("a.mkv", "b.mkv", "c.mkv"):
        (src / name).write_bytes(b"x")
    storage = FakeStorage()
    checks = {"n": 0}

    def is_cancelled() -> bool:
        checks["n"] += 1
        return checks["n"] > 1  # one file goes through, then stop

    result = copy_files(src, tmp_path / "library", storage=storage, is_cancelled=is_cancelled)

    assert result["ok"] is False
    assert "cancelado" in result["detail"]
    assert result["files_copied"] == 1


def test_a_cancelled_transfer_propagates_rather_than_being_swallowed(tmp_path):
    """Mid-file is never our stop to make: a half-copied file is a corrupt one.

    `run_copy_background` is what turns this into `status="cancelled"`. The use
    case must not quietly convert it into a plain failure, or the task would
    read as an error for something a person asked for.
    """
    src = tmp_path / "release"
    src.mkdir()
    for name in ("a.mkv", "b.mkv"):
        (src / name).write_bytes(b"x")

    with pytest.raises(CopyCancelled):
        copy_files(src, tmp_path / "library", storage=FakeStorage(raise_after=1))


def test_a_missing_source_says_so_in_a_code_and_not_only_in_words(tmp_path):
    """`detail` is Spanish prose for a person. `code` is for the caller."""
    result = copy_files(tmp_path / "nope", tmp_path / "library", storage=FakeStorage())

    assert result["ok"] is False
    assert result["code"] == "not_found"
    assert "fuente no encontrada" in result["detail"]


def test_neither_file_nor_directory_is_reported_as_such(tmp_path):
    """A FIFO exists and is neither. It must not be copied as one file."""
    import os

    src = tmp_path / "pipe"
    os.mkfifo(src)
    result = copy_files(src, tmp_path / "library", storage=FakeStorage())
    assert result["ok"] is False
    assert result["code"] == "not_a_file_or_dir"


def test_no_progress_callback_is_not_an_error(tmp_path):
    src = tmp_path / "one.mkv"
    src.write_bytes(b"x")
    result = copy_files(src, tmp_path / "library", storage=FakeStorage())
    assert result["ok"] is True
