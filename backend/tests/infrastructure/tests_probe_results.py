"""Persisted ffprobe results (ffprobe-masivo T1/S1).

The rule under test: a successful probe is stored against the file's
identity (path + mtime + size) and is served only while that identity
still holds — an analyzed file answers from the database, a changed or
missing one never does.
"""

import os

import pytest

from infrastructure import sqlite_history as history


@pytest.fixture
def db(tmp_path):
    """A fresh database per test, isolated from the real config volume."""
    history.close()
    history.init_db(tmp_path / "history.db")
    yield
    history.close()


def _probe(path, height=1080):
    return {
        "filename": os.path.basename(path),
        "path": path,
        "format": "matroska,webm",
        "duration": 7200.0,
        "size_bytes": 1_000_000,
        "video_tracks": [{
            "index": 0, "track_index": 0, "codec": "hevc", "width": 1920,
            "height": height, "fps": 23.976, "selected": True,
        }],
        "audio_tracks": [],
        "subtitle_tracks": [],
    }


def _file(tmp_path, name="ParaNorman.mkv", size=64):
    target = tmp_path / name
    target.write_bytes(b"\x00" * size)
    return str(target)


def test_saved_probe_roundtrips_while_the_file_is_untouched(db, tmp_path):
    path = _file(tmp_path)
    probe = _probe(path)

    history.save_probe_result(path, probe)

    assert history.get_probe_result(path) == probe


def test_probe_of_a_changed_file_is_stale(db, tmp_path):
    path = _file(tmp_path)
    history.save_probe_result(path, _probe(path))

    # Bigger content AND an explicit new mtime: either identity half alone
    # must be enough to distrust the stored probe.
    with open(path, "ab") as fh:
        fh.write(b"\x01" * 32)
    stat = os.stat(path)
    os.utime(path, (stat.st_atime + 10, stat.st_mtime + 10))

    assert history.get_probe_result(path) is None


def test_probe_of_a_deleted_file_is_none(db, tmp_path):
    path = _file(tmp_path)
    history.save_probe_result(path, _probe(path))

    os.unlink(path)

    assert history.get_probe_result(path) is None


def test_helpers_degrade_when_the_database_is_unavailable(db, tmp_path):
    # The history database is a record, never a requirement: a closed or
    # failed connection must not break the probe flow (module discipline).
    path = _file(tmp_path)
    history.save_probe_result(path, _probe(path))
    history.close()

    assert history.get_probe_result(path) is None
    history.save_probe_result(path, _probe(path))  # must not raise
