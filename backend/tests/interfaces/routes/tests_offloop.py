"""Nothing blocking may run on the event loop.

Every test here answers one question — *did this operation run inside the loop,
or in a worker thread?* — and answers it structurally instead of by stopwatch.

`asyncio.get_running_loop()` is thread-local. Work executed inline from an
`async def` finds the loop; work handed to `asyncio.to_thread` lands in a pool
thread where the call raises `RuntimeError`. So a spy that records the result
tells us exactly which side of the boundary the real code is on, deterministically
and without timing flakiness.

The cost of getting this wrong is not a slow endpoint: while one handler blocks,
**every other request waits**, because there is only one loop.
"""

import asyncio
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app import app

client = TestClient(app, raise_server_exceptions=False)


def _ran_on_the_event_loop() -> bool:
    try:
        asyncio.get_running_loop()
        return True
    except RuntimeError:
        return False


def _spy(seen: dict, key: str, real):
    """Record where we ran, then behave exactly like the original."""

    def wrapper(*args, **kwargs):
        seen[key] = _ran_on_the_event_loop()
        return real(*args, **kwargs)

    return wrapper


class TestMixerProbeIsOffTheEventLoop:
    """Two `subprocess.run(ffprobe, timeout=30)` per request: up to 60 s."""

    def test_probe_does_not_run_on_the_event_loop(self):
        seen: dict = {}
        probe = {
            "filename": "video.mkv",
            "path": "/mnt/storage/video.mkv",
            "format": "matroska",
            "duration": 7200.0,
            "size_bytes": 1000000,
            "video_tracks": [{"index": 0, "codec": "h264", "width": 1920, "height": 1080,
                              "fps": 23.976, "bitrate": 3000000, "selected": False}],
            "audio_tracks": [{"index": 1, "codec": "aac", "language": "eng", "channels": 6,
                              "bitrate": 128000, "default": True}],
        }
        with patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True), \
             patch("interfaces.http.routes_mixer.check_compatibility", return_value={"ok": True, "warnings": []}), \
             patch("interfaces.http.routes_mixer.probe_file",
                   side_effect=lambda p: (seen.__setitem__("probe", _ran_on_the_event_loop()), probe)[1]):
            resp = client.post(
                "/api/mixer/probe",
                json={"path_a": "/mnt/storage/video.mkv", "path_b": "/mnt/storage/audio.mkv"},
            )

        assert resp.status_code == 200, resp.text
        assert "probe" in seen, "probe_file was never called"
        assert seen["probe"] is False, (
            "ffprobe ran on the event loop: one 30 s probe stalls every other request"
        )


class TestFileEndpointsAreOffTheEventLoop:
    """These run over /mnt/storage, which can be a stalled network mount.

    `_validate_path` is bypassed so the tests can use tmp_path; the endpoints
    themselves are the real ones.
    """

    def _post(self, url: str, body: dict):
        with patch("interfaces.http.routes.files._validate_path", side_effect=lambda p: p):
            return client.post(url, json=body)

    def test_rename_does_not_run_on_the_event_loop(self, tmp_path):
        import os

        src = tmp_path / "a.mkv"
        src.write_bytes(b"x")
        seen: dict = {}
        with patch("interfaces.http.routes.files.os.rename",
                   side_effect=_spy(seen, "rename", os.rename)):
            resp = self._post("/api/files/rename",
                              {"remote_path": str(src), "local_path": str(tmp_path / "b.mkv")})

        assert resp.status_code == 200, resp.text
        assert resp.json()["ok"] is True, resp.text
        assert seen["rename"] is False, "a rename ran inline on the event loop"

    def test_delete_does_not_run_on_the_event_loop(self, tmp_path):
        import shutil

        victim = tmp_path / "victim"
        victim.mkdir()
        (victim / "inner.mkv").write_bytes(b"x")
        seen: dict = {}
        with patch("application.use_cases.place_file.shutil.rmtree",
                   side_effect=_spy(seen, "rmtree", shutil.rmtree)):
            resp = self._post("/api/files/delete", {"remote_path": str(victim)})

        assert resp.status_code == 200, resp.text
        assert resp.json()["ok"] is True, resp.text
        assert seen["rmtree"] is False, "an unbounded recursive delete ran inline"
        assert not victim.exists()

    def test_copy_does_not_run_on_the_event_loop(self, tmp_path):
        import shutil

        src = tmp_path / "a.mkv"
        src.write_bytes(b"x")
        dst = tmp_path / "b.mkv"
        seen: dict = {}
        with patch("application.use_cases.place_file.shutil.copy2",
                   side_effect=_spy(seen, "copy2", shutil.copy2)):
            resp = self._post("/api/files/copy",
                              {"remote_path": str(src), "local_path": str(dst)})

        assert resp.status_code == 200, resp.text
        assert resp.json()["ok"] is True, resp.text
        assert seen["copy2"] is False, "a copy ran inline on the event loop"
        assert dst.exists()


class TestScanScoringIsOffTheEventLoop:
    """`os.walk` x every video x every title, each with SequenceMatcher.

    That is millions of ratio() calls against a real folder, and it used to run
    inside the same `async def` that answers the request.
    """

    def test_scoring_does_not_run_on_the_event_loop(self, tmp_path):
        (tmp_path / "Whatever.2016.1080p.mkv").write_bytes(b"x")
        seen: dict = {}

        def score(filename, title):
            seen["scoring"] = _ran_on_the_event_loop()
            return 0.0

        meta = {"title": "Whatever", "year": 2016,
                "path": "/data/movies/Whatever", "altTitles": []}
        with patch("interfaces.http.routes.wanted._validate_path", side_effect=lambda p: p), \
             patch("interfaces.http.routes.wanted.arr_movie_metadata",
                   new_callable=AsyncMock, return_value=meta), \
             patch("application.use_cases.scan_wanted._match_score", side_effect=score):
            resp = client.post(
                "/api/wanted/scan",
                json={"source": "radarr", "remote_path": str(tmp_path),
                      "ids": {"movie_id": 11}},
            )

        assert resp.status_code == 200, resp.text
        assert resp.json().get("ok") is not False, resp.text
        assert "scoring" in seen, "the scoring never ran — the test did not reach phase 3"
        assert seen["scoring"] is False, "folder scoring ran on the event loop"
