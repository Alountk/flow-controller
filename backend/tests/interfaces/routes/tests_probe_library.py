"""Library-wide probe sweep («ffprobe-masivo» T3/S3).

The rules under test: the walk collects VIDEO files only from the movie and
routing folders; a run skips fresh persisted rows and probes the rest; a
failing file is counted, never fatal; and only one run exists at a time.
"""

import asyncio
import os

import pytest

from application.use_cases import probe_library


@pytest.fixture(autouse=True)
def _clean_job_state(monkeypatch):
    """Every test starts and ends with an idle job (module global state)."""
    monkeypatch.setattr(probe_library, "_active", False)
    monkeypatch.setattr(probe_library, "_task", None)
    monkeypatch.setattr(probe_library, "_status", dict(probe_library._EMPTY_STATUS))


def _probe(path):
    return {"filename": os.path.basename(path), "path": path, "video_tracks": []}


# ── The walk (S3: video files only, movie folders + routing folders) ─────────

def test_collect_files_keeps_video_files_only(tmp_path):
    movie = tmp_path / "ParaNorman"
    movie.mkdir()
    (movie / "ParaNorman.mkv").write_bytes(b"x")
    (movie / "ParaNorman.srt").write_bytes(b"x")
    (movie / "poster.jpg").write_bytes(b"x")
    subs = movie / "Subs"
    subs.mkdir()
    (subs / "spa.srt").write_bytes(b"x")
    routed = tmp_path / "4K"
    routed.mkdir()
    (routed / "ParaNorman.2160p.mp4").write_bytes(b"x")

    found = probe_library.collect_files([str(movie), str(routed)])

    names = sorted(os.path.basename(p) for p in found)
    assert names == ["ParaNorman.2160p.mp4", "ParaNorman.mkv"]


def test_collect_files_dedupes_overlapping_folders(tmp_path):
    movie = tmp_path / "ParaNorman"
    movie.mkdir()
    (movie / "ParaNorman.mkv").write_bytes(b"x")

    found = probe_library.collect_files([str(movie), str(movie), str(tmp_path)])

    assert found == [os.path.realpath(movie / "ParaNorman.mkv")]


def test_collect_files_ignores_missing_and_empty_folders(tmp_path):
    # Empty means "not configured" (the routing-folder rule): it never means
    # "everything", and a vanished folder must not abort the sweep.
    assert probe_library.collect_files(["", str(tmp_path / "ghost")]) == []


# ── The run (S3: skip fresh, probe cold, tolerate failures) ──────────────────

def test_run_skips_fresh_rows_and_probes_the_rest(tmp_path):
    fresh = tmp_path / "fresh.mkv"
    cold = tmp_path / "cold.mkv"
    for f in (fresh, cold):
        f.write_bytes(b"x")
    fresh, cold = os.path.realpath(fresh), os.path.realpath(cold)
    probed: list[str] = []
    saved: list[str] = []

    def probe(path):
        probed.append(path)
        return _probe(path)

    async def scenario():
        return await probe_library.run(
            [fresh, cold],
            probe=probe,
            cache_get=lambda p: _probe(p) if p == fresh else None,
            cache_save=lambda p, data: saved.append(p),
        )

    summary = asyncio.run(scenario())

    assert probed == [cold]
    assert saved == [cold]
    assert summary["total"] == 2
    assert summary["skipped"] == 1
    assert summary["analyzed"] == 1
    assert summary["failed"] == 0


def test_run_counts_failures_without_aborting(tmp_path):
    bad = tmp_path / "bad.mkv"
    good = tmp_path / "good.mkv"
    for f in (bad, good):
        f.write_bytes(b"x")
    bad, good = os.path.realpath(bad), os.path.realpath(good)

    def probe(path):
        if path == bad:
            raise RuntimeError("ffprobe exploded")
        return _probe(path)

    async def scenario():
        return await probe_library.run(
            [bad, good], probe=probe, cache_get=lambda p: None, cache_save=lambda p, d: None,
        )

    summary = asyncio.run(scenario())

    assert summary["failed"] == 1
    assert summary["analyzed"] == 1
    assert summary["running"] is False


def test_run_never_persists_a_failed_probe(tmp_path):
    bad = tmp_path / "bad.mkv"
    bad.write_bytes(b"x")
    bad = os.path.realpath(bad)
    saved: list[str] = []

    def probe(path):
        raise RuntimeError("ffprobe exploded")

    async def scenario():
        return await probe_library.run(
            [bad], probe=probe, cache_get=lambda p: None,
            cache_save=lambda p, d: saved.append(p),
        )

    asyncio.run(scenario())

    assert saved == []


# ── Single flight (S3: a second start while running is refused) ──────────────

def test_start_refuses_a_second_run_and_status_reports_running(monkeypatch):
    monkeypatch.setattr(probe_library, "_active", True)

    assert probe_library.start(["/mnt/a.mkv"]) is False
    assert probe_library.status()["running"] is True


def test_status_terminal_shape_is_pinned():
    assert probe_library.status() == {
        "running": False,
        "total": 0,
        "analyzed": 0,
        "skipped": 0,
        "failed": 0,
        "started_at": 0.0,
        "finished_at": 0.0,
    }


# ── Routes (S3/S4 surface) ──────────────────────────────────────────────────

def test_probe_library_route_answers_409_while_a_run_is_active(monkeypatch):
    from fastapi.testclient import TestClient
    from app import app

    client = TestClient(app, raise_server_exceptions=False)
    monkeypatch.setattr(probe_library, "start", lambda paths: False)

    resp = client.post("/api/mixer/probe-library")

    assert resp.status_code == 409


def test_probe_library_status_route_serves_the_job_state(monkeypatch):
    from fastapi.testclient import TestClient
    from app import app

    client = TestClient(app, raise_server_exceptions=False)
    monkeypatch.setattr(
        probe_library, "status",
        lambda: {"running": False, "total": 3, "analyzed": 2, "skipped": 1,
                 "failed": 0, "started_at": 1.0, "finished_at": 2.0},
    )

    resp = client.get("/api/mixer/probe-library/status")

    assert resp.status_code == 200
    assert resp.json()["analyzed"] == 2
