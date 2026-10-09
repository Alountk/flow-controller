"""`application.use_cases.place_file` — the orchestration, no routes in the room.

Every test calls the use case directly on a `tmp_path` disk: the HTTP layer
parses and maps, and that is all. The contracts pinned here are the ones the
routes used to hide inside handlers — hardlink-first placement, the rename
first move with its copy fallback, the seed guard's resolved paths, and the
queue trim.
"""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from application.use_cases import place_file


def _queue_op(src: str, dst: str, *, op_type: str = "copy", **overrides) -> dict:
    op = {
        "id": "test-op",
        "type": op_type,
        "src": src,
        "dst": dst,
        "name": os.path.basename(src),
        "status": "pending",
        "cancelled": False,
    }
    op.update(overrides)
    return op


# ── rename ───────────────────────────────────────────────────────────────────


def test_rename_moves_the_file_and_names_both_ends(tmp_path):
    src = tmp_path / "a.mkv"
    src.write_bytes(b"x")
    dst = tmp_path / "b.mkv"

    result = place_file.rename_path(str(src), str(dst))

    assert result == {"ok": True, "detail": "Renombrado: a.mkv → b.mkv"}
    assert not src.exists()
    assert dst.read_bytes() == b"x"


def test_rename_failure_reports_the_exception_type(tmp_path):
    result = place_file.rename_path(str(tmp_path / "missing.mkv"), str(tmp_path / "b.mkv"))

    assert result["ok"] is False
    assert result["detail"].startswith("FileNotFoundError: ")


# ── delete ───────────────────────────────────────────────────────────────────


def test_delete_removes_a_file(tmp_path):
    victim = tmp_path / "victim.mkv"
    victim.write_bytes(b"x")

    result = place_file.delete_path(str(victim))

    assert result == {"ok": True, "detail": "Eliminado: victim.mkv"}
    assert not victim.exists()


def test_delete_removes_a_whole_tree(tmp_path):
    victim = tmp_path / "release"
    (victim / "Subs").mkdir(parents=True)
    (victim / "Subs" / "es.srt").write_bytes(b"sub")

    result = place_file.delete_path(str(victim))

    assert result == {"ok": True, "detail": "Eliminado: release"}
    assert not victim.exists()


def test_delete_failure_reports_the_exception_type(tmp_path):
    result = place_file.delete_path(str(tmp_path / "missing.mkv"))

    assert result["ok"] is False
    assert result["detail"].startswith("FileNotFoundError: ")


# ── copy (the route) ─────────────────────────────────────────────────────────


def test_copying_a_plain_file_duplicates_the_bytes(tmp_path):
    src = tmp_path / "a.mkv"
    src.write_bytes(b"payload")
    dst = tmp_path / "b.mkv"

    result = place_file.copy_path(str(src), str(dst))

    assert result == {"ok": True, "detail": f"Copiado: a.mkv → {dst}"}
    assert dst.read_bytes() == b"payload"
    assert os.stat(src).st_ino != os.stat(dst).st_ino, (
        "the route's single-file copy has always been a plain byte copy"
    )


def test_copying_a_directory_hardlinks_every_file(tmp_path):
    src = tmp_path / "release"
    (src / "Subs").mkdir(parents=True)
    (src / "release.mkv").write_bytes(b"video")
    (src / "Subs" / "es.srt").write_bytes(b"sub")
    dst = tmp_path / "library" / "release"

    result = place_file.copy_path(str(src), str(dst))

    assert result["ok"] is True, result
    for rel in ("release.mkv", "Subs/es.srt"):
        assert os.stat(src / rel).st_ino == os.stat(dst / rel).st_ino, f"{rel} was duplicated"
    assert src.exists()


def test_copying_onto_an_existing_directory_reports_the_error(tmp_path):
    src = tmp_path / "release"
    src.mkdir()
    (src / "release.mkv").write_bytes(b"video")
    dst = tmp_path / "library"
    dst.mkdir()

    result = place_file.copy_path(str(src), str(dst))

    assert result["ok"] is False
    assert result["detail"].startswith("FileExistsError: ")


# ── The seed guard resolves both ends before deciding ────────────────────────


def test_a_file_inside_the_resolved_torrent_root_is_refused(tmp_path):
    root = tmp_path / "torrents"
    root.mkdir()
    src = root / "release.mkv"
    src.write_bytes(b"x")

    blocked = place_file.seed_block_reason(str(src), str(root), "mover")

    assert blocked is not None
    assert "'release.mkv'" in blocked
    assert "no se puede mover" in blocked
    # The message shows the RESOLVED root, which on macOS may differ from
    # `tmp_path` itself (/var → /private/var).
    assert os.path.realpath(root) in blocked


def test_a_file_outside_the_torrent_root_is_allowed(tmp_path):
    root = tmp_path / "torrents"
    root.mkdir()
    library = tmp_path / "movies"
    library.mkdir()

    assert place_file.seed_block_reason(str(library / "a.mkv"), str(root), "mover") is None


# ── Queue placement (type "copy") ────────────────────────────────────────────


def test_placing_a_file_hardlinks_it_and_keeps_the_source(tmp_path):
    src = tmp_path / "seed" / "Movie (2016).mkv"
    src.parent.mkdir(parents=True)
    src.write_bytes(b"payload")
    # Nested destination whose parent does not exist yet: placement creates it.
    dst = tmp_path / "library" / "Movie (2016)" / "Movie (2016).mkv"
    op = _queue_op(str(src), str(dst))

    place_file.place_path(str(src), str(dst), op)

    assert src.exists(), "the download must survive or the seed is gone"
    assert dst.exists()
    assert os.stat(src).st_ino == os.stat(dst).st_ino, "same filesystem: no byte was forked"
    assert op["progress"] == 100
    assert op["copied_bytes"] == op["total_bytes"] == len(b"payload")
    assert op["files_done"] == op["files_total"] == 1


def test_placement_never_opens_an_existing_shared_inode_for_writing(tmp_path):
    """If both ends already name the same inode, writing would empty both."""
    src = tmp_path / "seed" / "Movie.mkv"
    src.parent.mkdir(parents=True)
    src.write_bytes(b"payload")
    dst = tmp_path / "library" / "Movie.mkv"
    dst.parent.mkdir(parents=True)
    os.link(src, dst)
    op = _queue_op(str(src), str(dst))

    place_file.place_path(str(src), str(dst), op)

    assert src.read_bytes() == b"payload", "the source was truncated to zero"
    assert os.stat(src).st_ino == os.stat(dst).st_ino
    assert op["progress"] == 100
    assert op["files_done"] == op["files_total"] == 1


def test_placement_pays_real_bytes_only_when_linking_is_impossible(tmp_path):
    src = tmp_path / "seed" / "Movie.mkv"
    src.parent.mkdir(parents=True)
    src.write_bytes(b"payload")
    dst = tmp_path / "other-device" / "Movie.mkv"
    op = _queue_op(str(src), str(dst))

    with patch(
        "application.use_cases.place_file.os.link",
        side_effect=OSError(18, "Invalid cross-device link"),
    ):
        place_file.place_path(str(src), str(dst), op)

    assert dst.read_bytes() == b"payload"
    assert os.stat(src).st_ino != os.stat(dst).st_ino
    assert src.exists(), "placing never moves the source"
    assert op["progress"] == 100


def test_placing_a_tree_counts_and_hardlinks_every_file(tmp_path):
    src = tmp_path / "seed" / "release"
    (src / "Subs").mkdir(parents=True)
    (src / "release.mkv").write_bytes(b"video")
    (src / "Subs" / "es.srt").write_bytes(b"sub")
    dst = tmp_path / "library" / "release"
    op = _queue_op(str(src), str(dst))

    place_file.place_path(str(src), str(dst), op)

    assert src.exists()
    for rel in ("release.mkv", "Subs/es.srt"):
        assert os.stat(src / rel).st_ino == os.stat(dst / rel).st_ino, f"{rel} was duplicated"
    assert op["files_total"] == op["files_done"] == 2
    assert op["total_bytes"] == len(b"video") + len(b"sub")
    assert op["progress"] == 100


# ── Queue moves (type "move"): rename first, copy + delete as fallback ───────


def test_a_move_renames_in_place_when_the_filesystem_allows(tmp_path):
    src = tmp_path / "seed" / "Movie.mkv"
    src.parent.mkdir(parents=True)
    src.write_bytes(b"payload")
    dst = tmp_path / "library" / "Movie.mkv"
    op = _queue_op(str(src), str(dst), op_type="move")

    place_file.move_path(str(src), str(dst), op)

    assert not src.exists(), "the rename already removed the source"
    assert dst.read_bytes() == b"payload"


def _rename_only_refuses_the_source(src):
    """Fail `src → anywhere` like an EXDEV cut; let everything else through.

    A blanket `os.rename` failure would also break the fallback copy's own
    temp rename — but that temp sits BESIDE the destination, so in reality it
    never crosses a device. Only the source's rename does.
    """
    real_rename = os.rename

    def rename(a, b):
        if a == str(src):
            raise OSError(18, "Invalid cross-device link")
        return real_rename(a, b)

    return rename


def test_a_cross_device_move_copies_then_deletes_the_source(tmp_path):
    src = tmp_path / "seed" / "Movie.mkv"
    src.parent.mkdir(parents=True)
    src.write_bytes(b"payload")
    dst = tmp_path / "library" / "Movie.mkv"
    op = _queue_op(str(src), str(dst), op_type="move")

    with patch(
        "application.use_cases.place_file.os.rename",
        side_effect=_rename_only_refuses_the_source(src),
    ):
        place_file.move_path(str(src), str(dst), op)

    assert dst.read_bytes() == b"payload"
    assert not src.exists(), "a completed fallback move must not leave a duplicate"
    assert op["progress"] == 100


def test_a_cross_device_move_of_a_tree_copies_then_deletes_the_source(tmp_path):
    src = tmp_path / "seed" / "release"
    (src / "Subs").mkdir(parents=True)
    (src / "release.mkv").write_bytes(b"video")
    (src / "Subs" / "es.srt").write_bytes(b"sub")
    dst = tmp_path / "library" / "release"
    op = _queue_op(str(src), str(dst), op_type="move")

    with patch(
        "application.use_cases.place_file.os.rename",
        side_effect=OSError(18, "Invalid cross-device link"),
    ):
        place_file.move_path(str(src), str(dst), op)

    assert (dst / "release.mkv").read_bytes() == b"video"
    assert (dst / "Subs" / "es.srt").read_bytes() == b"sub"
    assert not src.exists()


def test_a_cancelled_fallback_never_leaves_half_a_file_behind(tmp_path):
    src = tmp_path / "seed" / "Movie.mkv"
    src.parent.mkdir(parents=True)
    src.write_bytes(b"payload")
    dst = tmp_path / "library" / "Movie.mkv"
    op = _queue_op(str(src), str(dst), op_type="move", cancelled=True)

    with patch(
        "application.use_cases.place_file.os.rename",
        side_effect=OSError(18, "Invalid cross-device link"),
    ):
        with pytest.raises(InterruptedError):
            place_file.move_path(str(src), str(dst), op)

    assert src.exists(), "a cancelled move keeps the download"
    assert not dst.exists(), "a cancelled move must not publish its destination"
    assert list(tmp_path.rglob(".copy_*.part")) == [], "the temp file was left behind"


# ── The queue trim ───────────────────────────────────────────────────────────


def test_trim_leaves_a_queue_within_the_limit_alone():
    ops = [{"status": "done", "id": str(i)} for i in range(50)]

    place_file.trim_queue(ops)

    assert len(ops) == 50


def test_trim_drops_finished_work_once_the_limit_is_passed():
    ops = [{"status": "done", "id": str(i)} for i in range(49)]
    ops.append({"status": "pending", "id": "still-waiting"})
    ops.append({"status": "running", "id": "mid-flight"})

    place_file.trim_queue(ops)

    assert [o["id"] for o in ops] == ["still-waiting", "mid-flight"]
