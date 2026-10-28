"""Tests para las rutas API de media_mixer."""
import os
import subprocess
import time
from unittest.mock import ANY, AsyncMock, MagicMock, patch

import aiohttp
import pytest

# Configurar env vars antes de importar
os.environ.setdefault("FOLDER_OUTPUT_MIXED", "/tmp/mixed-test")

from fastapi.testclient import TestClient
from app import app
import media_mixer
from interfaces.http import routes_mixer
from task_manager import mux_tasks

client = TestClient(app, raise_server_exceptions=False)


def _probe_fixture(path, fps=23.976, duration=7200.0, width=1920, height=1080, languages=("spa",), subtitle_tracks=()):
    """Minimal probe_file() result as parse_probe_data would produce it.

    One audio track per entry of `languages` (tag as the file reports it).
    `languages=()` builds a video-only probe — a file with no audio tracks
    contributes an empty language set to the A+B union. `subtitle_tracks`
    entries are already in the parsed S6 shape.
    """
    return {
        "filename": os.path.basename(path),
        "path": path,
        "format": "matroska,webm",
        "duration": duration,
        "size_bytes": 1_000_000,
        "video_tracks": [{
            "index": 0, "track_index": 0, "codec": "hevc", "width": width, "height": height,
            "fps": fps, "bitrate": 5_000_000, "selected": False,
        }],
        "audio_tracks": [
            {
                "index": i + 1, "track_index": i, "codec": "aac", "language": lang,
                "channels": 6, "bitrate": 128_000, "default": i == 0,
            }
            for i, lang in enumerate(languages)
        ],
        "subtitle_tracks": [dict(t) for t in subtitle_tracks],
    }


def _sub_track(language, codec="subrip", index=5, track_index=0, extractable=True,
               title="", forced=False, default=False):
    """subtitle_tracks entry as parse_probe_data produces it (S6)."""
    return {
        "index": index, "track_index": track_index, "codec": codec,
        "language": language, "language_code": media_mixer.normalize_language(language),
        "title": title, "forced": forced, "default": default,
        "kind": "text" if extractable else "bitmap", "extractable": extractable,
    }


#: Real ffprobe JSON (subtitle stream included) for the parser-boundary test.
_FFPROBE_MKV_WITH_SUBS = {
    "format": {"format_name": "matroska,webm", "duration": "7200.0", "size": "1000000"},
    "streams": [
        {"index": 0, "codec_type": "video", "codec_name": "hevc", "width": 1920,
         "height": 1080, "r_frame_rate": "24000/1001", "bit_rate": "5000000"},
        {"index": 1, "codec_type": "audio", "codec_name": "aac", "channels": 6,
         "bit_rate": "192000", "tags": {"language": "spa"}, "disposition": {"default": 1}},
        {"index": 2, "codec_type": "subtitle", "codec_name": "subrip",
         "tags": {"language": "spa", "title": "Forzados"},
         "disposition": {"forced": 1, "default": 0}},
    ],
}


# ── Probe Endpoint ──────────────────────────────────────────────────────────

class TestProbeEndpoint:
    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.check_compatibility")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_probe_valid_files(self, mock_probe, mock_compat, mock_isfile):
        mock_probe.return_value = {
            "filename": "video.mkv",
            "path": "/mnt/storage/video.mkv",
            "format": "matroska",
            "duration": 7200.0,
            "size_bytes": 1000000,
            "video_tracks": [{"index": 0, "codec": "h264", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 3000000, "selected": False}],
            "audio_tracks": [{"index": 1, "codec": "aac", "language": "eng", "channels": 6, "bitrate": 128000, "default": True}],
        }
        mock_compat.return_value = {"ok": True, "warnings": []}

        resp = client.post(
            "/api/mixer/probe",
            json={"path_a": "/mnt/storage/video.mkv", "path_b": "/mnt/storage/audio.mkv"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "file_a" in data
        assert "file_b" in data
        assert "compatibility" in data
        assert data["compatibility"]["ok"] is True
        assert mock_probe.call_count == 2

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.check_compatibility")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_probe_with_warnings(self, mock_probe, mock_compat, mock_isfile):
        mock_probe.return_value = {
            "filename": "video.mkv",
            "path": "/mnt/storage/video.mkv",
            "format": "matroska",
            "duration": 7200.0,
            "size_bytes": 1000000,
            "video_tracks": [{"index": 0, "codec": "h264", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 3000000, "selected": False}],
            "audio_tracks": [],
        }
        mock_compat.return_value = {
            "ok": True,
            "warnings": [{"type": "fps_mismatch", "message": "FPS differs: 23.976 vs 29.970"}],
        }

        resp = client.post(
            "/api/mixer/probe",
            json={"path_a": "/mnt/storage/video.mkv", "path_b": "/mnt/storage/video2.mkv"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["compatibility"]["warnings"]) == 1

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_unprobeable_file_is_400(self, mock_probe, _isfile):
        # An ffprobe-unreadable file (0-byte .part, .met, no-media) is bad
        # INPUT — the same 400 alternatives/lookup answers, never a 500.
        mock_probe.side_effect = media_mixer.ProbeInputError("ffprobe failed: boom")
        resp = client.post(
            "/api/mixer/probe",
            json={"path_a": "/mnt/storage/temp/001.part", "path_b": "/mnt/storage/temp/002.part"},
        )
        assert resp.status_code == 400
        assert resp.json() == {"detail": "ffprobe failed: boom"}

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_missing_ffprobe_is_500(self, mock_probe, _isfile):
        # A missing binary IS a server fault: the only probe failure at 500.
        mock_probe.side_effect = RuntimeError("ffprobe not found")
        resp = client.post(
            "/api/mixer/probe",
            json={"path_a": "/mnt/storage/video.mkv", "path_b": "/mnt/storage/video2.mkv"},
        )
        assert resp.status_code == 500
        assert resp.json() == {"detail": "ffprobe not found"}

    def test_probe_missing_file(self):
        resp = client.post(
            "/api/mixer/probe",
            json={"path_a": "/mnt/storage/nonexistent.mkv", "path_b": "/mnt/storage/audio.mkv"},
        )
        assert resp.status_code == 400
        assert "not found" in resp.json()["detail"].lower()

    def test_probe_invalid_path(self):
        resp = client.post(
            "/api/mixer/probe",
            json={"path_a": "/etc/passwd", "path_b": "/mnt/storage/audio.mkv"},
        )
        assert resp.status_code == 403
        assert "not allowed" in resp.json()["detail"].lower()

    def test_probe_empty_path(self):
        resp = client.post(
            "/api/mixer/probe",
            json={"path_a": "", "path_b": "/mnt/storage/audio.mkv"},
        )
        assert resp.status_code == 400


# ── Mux Endpoint ────────────────────────────────────────────────────────────

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.check_compatibility")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_probe_returns_best_video_across_files(self, mock_probe, mock_compat, mock_isfile):
        mock_probe.side_effect = [
            {
                "filename": "a.mkv", "path": "/mnt/storage/a.mkv", "format": "matroska",
                "duration": 7200.0, "size_bytes": 1000000,
                "video_tracks": [{"index": 0, "codec": "h264", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 12400000, "selected": False}],
                "audio_tracks": [],
            },
            {
                "filename": "b.mkv", "path": "/mnt/storage/b.mkv", "format": "matroska",
                "duration": 7200.0, "size_bytes": 1000000,
                "video_tracks": [{"index": 0, "codec": "hevc", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 5800000, "selected": False}],
                "audio_tracks": [],
            },
        ]
        mock_compat.return_value = {"ok": True, "reasons": [], "warnings": []}

        resp = client.post(
            "/api/mixer/probe",
            json={"path_a": "/mnt/storage/a.mkv", "path_b": "/mnt/storage/b.mkv"},
        )
        assert resp.status_code == 200
        best = resp.json()["best_video"]
        # Mockup 10: 1080p HEVC (B) beats 1080p H.264 (A) — «Auto · mejor compresión».
        assert best["file"] == "b"
        assert best["path"] == "/mnt/storage/b.mkv"
        assert best["track_index"] == 0

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.check_compatibility")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_probe_exposes_language_check_and_audio_ordered(self, mock_probe, mock_compat, mock_isfile):
        # S2: additive contract — the response gains the required-language
        # check and the ca→en→ru→cat ordered audio list, old keys unchanged.
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/a.mkv", languages=("spa", "fra")),
            _probe_fixture("/mnt/storage/b.mkv", languages=("rus", "eng")),
        ]
        mock_compat.return_value = {"ok": True, "reasons": [], "warnings": []}

        resp = client.post(
            "/api/mixer/probe",
            json={"path_a": "/mnt/storage/a.mkv", "path_b": "/mnt/storage/b.mkv"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert {"file_a", "file_b", "compatibility", "best_video",
                "language_check", "audio_ordered"} <= set(data)
        assert data["language_check"] == {"ok": True, "missing": [], "required": ["spa"]}
        ordered = data["audio_ordered"]
        assert [t["language_code"] for t in ordered] == ["spa", "eng", "rus", "fra"]
        assert [t["file"] for t in ordered] == ["a", "b", "b", "a"]
        assert [t["track_index"] for t in ordered] == [0, 1, 0, 1]
        assert [t["selected"] for t in ordered] == [True, True, True, False]

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.check_compatibility")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_probe_flags_missing_required_language(self, mock_probe, mock_compat, mock_isfile):
        # No spa in either file: the badge must know before anyone hits /mux.
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/a.mkv", languages=("eng",)),
            _probe_fixture("/mnt/storage/b.mkv", languages=("rus",)),
        ]
        mock_compat.return_value = {"ok": True, "reasons": [], "warnings": []}

        resp = client.post(
            "/api/mixer/probe",
            json={"path_a": "/mnt/storage/a.mkv", "path_b": "/mnt/storage/b.mkv"},
        )
        assert resp.status_code == 200
        check = resp.json()["language_check"]
        assert check["ok"] is False
        assert check["missing"] == ["spa"]

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_probe_exposes_parsed_subtitle_tracks(self, mock_probe, mock_isfile):
        # S6: the probe response carries subtitle streams in the parsed shape.
        # Only the probe_file boundary is mocked — the real parser runs.
        mock_probe.side_effect = lambda path: media_mixer.parse_probe_data(_FFPROBE_MKV_WITH_SUBS, path)

        resp = client.post(
            "/api/mixer/probe",
            json={"path_a": "/mnt/storage/a.mkv", "path_b": "/mnt/storage/b.mkv"},
        )
        assert resp.status_code == 200
        subs = resp.json()["file_a"]["subtitle_tracks"]
        assert len(subs) == 1
        s0 = subs[0]
        assert s0["track_index"] == 0
        assert s0["codec"] == "subrip"
        assert s0["language"] == "spa"
        assert s0["language_code"] == "spa"
        assert s0["kind"] == "text"
        assert s0["extractable"] is True
        assert s0["forced"] is True


class TestProbeFileErrors:
    """probe_file's failure taxonomy: input problems vs a broken server."""

    @patch("media_mixer.subprocess.run")
    def test_ffprobe_nonzero_exit_raises_probe_input_error(self, mock_run, tmp_path):
        target = tmp_path / "x.mkv"
        target.write_bytes(b"x")
        mock_run.return_value = MagicMock(
            returncode=1, stdout="",
            stderr="x.mkv: Invalid data found when processing input",
        )
        with pytest.raises(media_mixer.ProbeInputError, match="ffprobe failed"):
            media_mixer.probe_file(str(target))

    @patch("media_mixer.subprocess.run")
    def test_ffprobe_timeout_raises_probe_input_error(self, mock_run, tmp_path):
        target = tmp_path / "x.mkv"
        target.write_bytes(b"x")
        mock_run.side_effect = subprocess.TimeoutExpired(cmd="ffprobe", timeout=30)
        with pytest.raises(media_mixer.ProbeInputError, match="timed out"):
            media_mixer.probe_file(str(target))

    def test_non_utf8_ffprobe_output_raises_probe_input_error(self, tmp_path, monkeypatch):
        """Legacy cp1251/latin1 junk in ffprobe output is input error, not a crash."""
        target = tmp_path / "x.mkv"
        target.write_bytes(b"x")
        real_run = subprocess.run

        # sh stands in for ffprobe: the bug lives in run()'s text-mode decode, so
        # the stand-in must really emit invalid UTF-8 instead of being mocked away.
        def run_with_junk_bytes(cmd, **kwargs):
            return real_run(["sh", "-c", "printf 'bad \\377\\376 bytes' >&2; exit 1"], **kwargs)

        monkeypatch.setattr(media_mixer.subprocess, "run", run_with_junk_bytes)
        with pytest.raises(media_mixer.ProbeInputError, match="ffprobe failed"):
            media_mixer.probe_file(str(target))


class TestMuxEndpoint:
    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_starts_task(self, mock_probe, mock_start, mock_isfile):
        mock_start.return_value = "test-task-id-123"
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/video.mkv"),
            _probe_fixture("/mnt/storage/audio.mkv"),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/video.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/audio.mkv", "track_index": 1}],
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["task_id"] == "test-task-id-123"
        mock_start.assert_called_once()

    @patch("media_mixer._launch")
    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_submitted_task_appears_in_list(self, mock_probe, mock_isfile, mock_launch, tmp_path):
        """The chain the post-«Mezclar» jump relies on: the task_id POST /mux
        returns IS in GET /tasks right away, so Seguimiento can show the row
        on landing. `start_mux` runs for real — only the ffmpeg thread is
        suppressed — so the registration under test is the production one.
        """
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/video.mkv"),
            _probe_fixture("/mnt/storage/audio.mkv"),
        ]
        task_id = ""
        try:
            resp = client.post(
                "/api/mixer/mux",
                json={
                    "video_source": {"path": "/mnt/storage/video.mkv", "track_index": 0},
                    "audio_sources": [{"path": "/mnt/storage/audio.mkv", "track_index": 1}],
                    # Explicit output dir: order-independent (module-level env
                    # seeding loses against earlier imports in a full run).
                    "output_path": str(tmp_path),
                },
            )
            assert resp.status_code == 200
            task_id = resp.json()["task_id"]
            assert task_id

            listing = client.get("/api/mixer/tasks")
            assert listing.status_code == 200
            entries = listing.json()["tasks"]
            match = next((t for t in entries if t["task_id"] == task_id), None)
            assert match is not None, f"task {task_id} missing from GET /api/mixer/tasks"
            assert match["status"] in ("running", "queued")
        finally:
            # Hygiene: this real registration must not leak into later tests
            # (e.g. the empty-registry list assertions).
            mux_tasks._tasks.pop(task_id, None)
            media_mixer._pending_jobs.pop(task_id, None)
            if task_id in media_mixer._mux_queue:
                media_mixer._mux_queue.remove(task_id)
            media_mixer._mux_active = None

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_rejects_incompatible_pair_409(self, mock_probe, mock_start, mock_isfile):
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/video.mkv", fps=23.976),
            _probe_fixture("/mnt/storage/audio.mkv", fps=25.0),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/video.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/audio.mkv", "track_index": 1}],
            },
        )
        assert resp.status_code == 409
        detail = resp.json()["detail"]
        assert detail["error"] == "incompatible"
        assert "fps_mismatch" in detail["reasons"]
        # The mux must never spawn ffmpeg for an incompatible pair (S3).
        mock_start.assert_not_called()

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_single_file_skips_compatibility_probe(self, mock_probe, mock_start, mock_isfile):
        # Video + audio from one single file: nothing to compare, no ffprobe call.
        mock_start.return_value = "test-task-id-single"

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/movie.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/movie.mkv", "track_index": 1}],
            },
        )
        assert resp.status_code == 200
        mock_probe.assert_not_called()
        mock_start.assert_called_once()

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_video_from_file_b_starts(self, mock_probe, mock_start, mock_isfile):
        # S4: the mux accepts the video stream from either file (B here).
        mock_start.return_value = "test-task-from-b"
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/fileB.mkv"),
            _probe_fixture("/mnt/storage/fileA.mkv"),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/fileB.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/fileA.mkv", "track_index": 1}],
            },
        )
        assert resp.status_code == 200
        mock_start.assert_called_once()
        started_video = mock_start.call_args[0][0]
        assert started_video["path"] == "/mnt/storage/fileB.mkv"

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_rejects_missing_required_language_409(self, mock_probe, mock_start, mock_isfile):
        # S2/L14: no spa in the A+B union ⇒ 409 BEFORE ffmpeg is spawned.
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/video.mkv", languages=("eng",)),
            _probe_fixture("/mnt/storage/audio.mkv", languages=("rus",)),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/video.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/audio.mkv", "track_index": 1}],
            },
        )
        assert resp.status_code == 409
        detail = resp.json()["detail"]
        assert detail["error"] == "missing_required_language"
        assert "spa" in detail["missing"]
        assert detail == {
            "error": "missing_required_language",
            "missing": ["spa"],
            "required": ["spa"],
        }
        mock_start.assert_not_called()

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_union_allows_language_present_in_only_one_file(self, mock_probe, mock_start, mock_isfile):
        # L3: «solo hace falta que uno de los dos archivos lo tenga» — spa as
        # a short code in A alone satisfies the requirement.
        mock_start.return_value = "test-task-union"
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/video.mkv", languages=("es",)),
            _probe_fixture("/mnt/storage/audio.mkv", languages=()),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/video.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/audio.mkv", "track_index": 1}],
            },
        )
        assert resp.status_code == 200
        mock_start.assert_called_once()

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_language_override_marks_und_track_as_spa(self, mock_probe, mock_start, mock_isfile):
        # L24: a pista `und` marcada por el usuario como castellano satisface
        # el gate de exigidos vía `language_overrides`, y alimenta el plan de
        # subtítulos (spa cuenta en la unión; `und` no aparece como código).
        mock_start.return_value = "test-task-und-mark"
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/video.mkv", languages=("eng", "und")),
            _probe_fixture("/mnt/storage/audio.mkv", languages=("rus",)),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/video.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/audio.mkv", "track_index": 1}],
                "language_overrides": [
                    {"path": "/mnt/storage/video.mkv", "track_index": 1, "language": "spa"}
                ],
            },
        )
        assert resp.status_code == 200
        mock_start.assert_called_once()
        plan = mock_start.call_args.kwargs["subtitle_plan"]
        assert [e["language_code"] for e in plan] == ["spa", "eng", "rus"]

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_language_override_retags_any_track(self, mock_probe, mock_start, mock_isfile):
        # S2 (relaja L24): cualquier pista admite reetiquetado — un eng ya
        # etiquetado puede pasar a spa y cuenta en el gate y en el plan.
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/video.mkv", languages=("eng",)),
            _probe_fixture("/mnt/storage/audio.mkv", languages=("rus",)),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/video.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/audio.mkv", "track_index": 0}],
                "language_overrides": [
                    {"path": "/mnt/storage/video.mkv", "track_index": 0, "language": "spa"}
                ],
            },
        )
        assert resp.status_code == 200
        mock_start.assert_called_once()
        plan = mock_start.call_args.kwargs["subtitle_plan"]
        assert [e["language_code"] for e in plan] == ["spa", "rus"]

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_language_override_accepts_full_label_codes(self, mock_probe, mock_start, mock_isfile):
        # S2: los 12 códigos de LANGUAGE_LABELS son válidos (hoy sólo spa/eng/rus/cat).
        # The extra spa track only satisfies the pinned 409 gate; fra is the subject.
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/video.mkv", languages=("und", "spa")),
            _probe_fixture("/mnt/storage/audio.mkv", languages=("rus",)),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/video.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/audio.mkv", "track_index": 0}],
                "language_overrides": [
                    {"path": "/mnt/storage/video.mkv", "track_index": 0, "language": "fra"}
                ],
            },
        )
        assert resp.status_code == 200
        mock_start.assert_called_once()

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_audio_languages_flow_to_start_mux(self, mock_probe, mock_start, mock_isfile):
        # S4: start_mux recibe el idioma efectivo por pista de audio (sondeo,
        # con el override aplicado) en el MISMO orden que audio_sources.
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/video.mkv", languages=("eng",)),
            _probe_fixture("/mnt/storage/audio.mkv", languages=("rus", "und")),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/video.mkv", "track_index": 0},
                "audio_sources": [
                    {"path": "/mnt/storage/audio.mkv", "track_index": 0},
                    {"path": "/mnt/storage/audio.mkv", "track_index": 1},
                ],
                "language_overrides": [
                    {"path": "/mnt/storage/audio.mkv", "track_index": 1, "language": "spa"}
                ],
            },
        )
        assert resp.status_code == 200
        assert mock_start.call_args.kwargs.get("audio_languages") == ["rus", "spa"]

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_language_override_rejects_unknown_language(self, mock_probe, mock_start, mock_isfile):
        # L24: el idioma destino debe normalizarse a uno de los ordenados.
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/video.mkv", languages=("und",)),
            _probe_fixture("/mnt/storage/audio.mkv", languages=("rus",)),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/video.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/audio.mkv", "track_index": 1}],
                "language_overrides": [
                    {"path": "/mnt/storage/video.mkv", "track_index": 0, "language": "zzz"}
                ],
            },
        )
        assert resp.status_code == 400
        assert "invalid_language_override" in resp.json()["detail"]
        mock_start.assert_not_called()

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_language_override_rejects_unknown_path(self, mock_probe, mock_start, mock_isfile):
        # L24: la marca solo apunta a ficheros cotejados en este mux.
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/video.mkv", languages=("und",)),
            _probe_fixture("/mnt/storage/audio.mkv", languages=("rus",)),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/video.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/audio.mkv", "track_index": 1}],
                "language_overrides": [
                    {"path": "/mnt/storage/other.mkv", "track_index": 0, "language": "spa"}
                ],
            },
        )
        assert resp.status_code == 400
        assert "invalid_language_override" in resp.json()["detail"]
        mock_start.assert_not_called()

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_language_override_rejects_out_of_range_track(self, mock_probe, mock_start, mock_isfile):
        # L24: ordinal inexistente dentro del fichero → 400, nunca un mapa
        # que apunte a una pista que ffprobe no reportó.
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/video.mkv", languages=("und",)),
            _probe_fixture("/mnt/storage/audio.mkv", languages=("rus",)),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/video.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/audio.mkv", "track_index": 1}],
                "language_overrides": [
                    {"path": "/mnt/storage/video.mkv", "track_index": 9, "language": "spa"}
                ],
            },
        )
        assert resp.status_code == 400
        assert "invalid_language_override" in resp.json()["detail"]
        mock_start.assert_not_called()

    def test_mux_missing_video_path(self):
        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/audio.mkv", "track_index": 1}],
            },
        )
        assert resp.status_code == 400
        assert "video_source.path is required" in resp.json()["detail"]

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    def test_mux_missing_audio_path(self, mock_isfile):
        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/video.mkv", "track_index": 0},
                "audio_sources": [{"track_index": 1}],
            },
        )
        assert resp.status_code == 400
        assert "audio_sources[0].path is required" in resp.json()["detail"]

    def test_mux_invalid_video_path(self):
        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/etc/passwd", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/audio.mkv", "track_index": 1}],
            },
        )
        assert resp.status_code == 403
        assert "not allowed" in resp.json()["detail"].lower()

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    def test_mux_empty_audio_sources(self, mock_start, mock_isfile):
        mock_start.return_value = "test-task-id-456"

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/video.mkv", "track_index": 0},
                "audio_sources": [],
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True


# ── Subtitle sidecar plan (S6/S8) ─────────────────────────────────────────

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_builds_subtitle_plan_from_audio_languages(self, mock_probe, mock_start, mock_isfile):
        # S6 «los mismos idiomas de audio»: one entry per AUDIO language of
        # the A+B union (rus subs without rus audio stay out), extractable
        # preferred, bitmap-only languages still get their entry.
        mock_start.return_value = "test-task-plan"
        mock_probe.side_effect = [
            _probe_fixture(
                "/mnt/storage/a.mkv", languages=("spa", "eng"),
                subtitle_tracks=(_sub_track("spa", "subrip", index=3, track_index=0, title="Forzados", forced=True),),
            ),
            _probe_fixture(
                "/mnt/storage/b.mkv", languages=("spa",),
                subtitle_tracks=(
                    _sub_track("rus", "subrip", index=3, track_index=0),
                    _sub_track("eng", "hdmv_pgs_subtitle", index=4, track_index=1, extractable=False),
                ),
            ),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/a.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/b.mkv", "track_index": 1}],
            },
        )
        assert resp.status_code == 200
        plan = mock_start.call_args.kwargs["subtitle_plan"]
        assert [e["language_code"] for e in plan] == ["spa", "eng"]

        for entry in plan:
            # sidecar-oriented fields on every entry, statuses start pending.
            assert {"language_code", "language", "path", "track_index", "codec", "status"} <= set(entry)
            assert entry["status"] == "pending"

        spa, eng = plan
        assert spa["language"] == "es"
        assert spa["path"] == "/mnt/storage/a.mkv"
        assert spa["track_index"] == 0
        assert spa["codec"] == "subrip"
        assert spa["extractable"] is True

        # eng: only a PGS bitmap in B — «no extraíble» (L12), T6 fills it.
        assert eng["language"] == "en"
        assert eng["path"] == "/mnt/storage/b.mkv"
        assert eng["track_index"] == 1
        assert eng["codec"] == "hdmv_pgs_subtitle"
        assert eng["extractable"] is False

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_plan_prefers_extractable_track_across_files(self, mock_probe, mock_start, mock_isfile):
        # A only has a PGS eng track, B has subrip eng: extraction wins (S6).
        mock_start.return_value = "test-task-prefer"
        mock_probe.side_effect = [
            _probe_fixture(
                "/mnt/storage/a.mkv", languages=("spa", "eng"),
                subtitle_tracks=(_sub_track("eng", "hdmv_pgs_subtitle", index=2, track_index=0, extractable=False),),
            ),
            _probe_fixture(
                "/mnt/storage/b.mkv", languages=(),
                subtitle_tracks=(_sub_track("eng", "subrip", index=2, track_index=0),),
            ),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/a.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/b.mkv", "track_index": 0}],
            },
        )
        assert resp.status_code == 200
        plan = mock_start.call_args.kwargs["subtitle_plan"]
        eng = next(e for e in plan if e["language_code"] == "eng")
        assert eng["extractable"] is True
        assert eng["codec"] == "subrip"
        assert eng["path"] == "/mnt/storage/b.mkv"

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_plan_keeps_pending_entries_when_no_subtitles_at_all(self, mock_probe, mock_start, mock_isfile):
        # No embedded subs anywhere: one pending entry per audio language so
        # the T6 OpenSubtitles search has something to fill.
        mock_start.return_value = "test-task-nosubs"
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/a.mkv", languages=("spa",)),
            _probe_fixture("/mnt/storage/b.mkv", languages=("eng",)),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/a.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/b.mkv", "track_index": 0}],
            },
        )
        assert resp.status_code == 200
        plan = mock_start.call_args.kwargs["subtitle_plan"]
        assert [e["language_code"] for e in plan] == ["spa", "eng"]
        for entry in plan:
            assert entry["status"] == "pending"
            assert entry["path"] is None
            assert entry["track_index"] is None
            assert entry["codec"] is None

# ── Subtitle languages (S3): user-chosen codes ──────────────────────────────

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_subtitle_languages_rank_order_and_track_selection(self, mock_probe, mock_start, mock_isfile):
        # S3(c): requested codes replace the audio-union derivation — one
        # entry per code, rank-ordered, best track across files.
        mock_start.return_value = "test-task-chosen"
        mock_probe.side_effect = [
            _probe_fixture(
                "/mnt/storage/a.mkv", languages=("spa",),
                subtitle_tracks=(_sub_track("eng", "hdmv_pgs_subtitle", index=2, track_index=0, extractable=False),),
            ),
            _probe_fixture(
                "/mnt/storage/b.mkv", languages=("spa",),
                subtitle_tracks=(
                    _sub_track("eng", "subrip", index=2, track_index=0),
                    _sub_track("spa", "subrip", index=3, track_index=1),
                ),
            ),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/a.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/b.mkv", "track_index": 0}],
                "subtitle_languages": ["eng", "spa"],
            },
        )
        assert resp.status_code == 200
        plan = mock_start.call_args.kwargs["subtitle_plan"]
        assert [e["language_code"] for e in plan] == ["spa", "eng"]
        eng = plan[1]
        # extractable beats bitmap across files, as in the derived plan.
        assert eng["path"] == "/mnt/storage/b.mkv"
        assert eng["track_index"] == 0
        assert eng["extractable"] is True

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_subtitle_languages_pending_entry_for_untracked_code(self, mock_probe, mock_start, mock_isfile):
        # S3(c): a chosen code with no track anywhere still gets its entry
        # (pending → the T6 search fills it), not silence.
        mock_start.return_value = "test-task-fra"
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/a.mkv", languages=("spa",)),
            _probe_fixture("/mnt/storage/b.mkv", languages=("spa",)),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/a.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/b.mkv", "track_index": 0}],
                "subtitle_languages": ["fra"],
            },
        )
        assert resp.status_code == 200
        plan = mock_start.call_args.kwargs["subtitle_plan"]
        assert [e["language_code"] for e in plan] == ["fra"]
        entry = plan[0]
        assert entry["status"] == "pending"
        assert entry["path"] is None
        assert entry["track_index"] is None

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_subtitle_languages_drive_the_sidecar_suffix(self, mock_probe, mock_start, mock_isfile):
        # S3(a): the chosen code names the sidecar — `fra` falls back to its
        # full code (`<stem>.fra.srt`) in subtitle_sidecar_path.
        mock_start.return_value = "test-task-suffix"
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/a.mkv", languages=("spa",)),
            _probe_fixture(
                "/mnt/storage/b.mkv", languages=("spa",),
                subtitle_tracks=(_sub_track("fra", "subrip", index=2, track_index=0),),
            ),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/a.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/b.mkv", "track_index": 0}],
                "subtitle_languages": ["fra"],
            },
        )
        assert resp.status_code == 200
        plan = mock_start.call_args.kwargs["subtitle_plan"]
        entry = plan[0]
        assert entry["language_code"] == "fra"
        assert entry["path"] == "/mnt/storage/b.mkv"
        sidecar = media_mixer.subtitle_sidecar_path(
            "/mnt/storage/Mixer_20261018T120000_mixed.mkv", entry["language_code"],
        )
        assert sidecar == "/mnt/storage/Mixer_20261018T120000_mixed.fra.srt"

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_subtitle_languages_reject_unknown_code(self, mock_probe, mock_start, mock_isfile):
        # S3: codes outside LANGUAGE_LABELS ⇒ 400, no task starts.
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/a.mkv", languages=("spa",)),
            _probe_fixture("/mnt/storage/b.mkv", languages=("spa",)),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/a.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/b.mkv", "track_index": 0}],
                "subtitle_languages": ["zzz"],
            },
        )
        assert resp.status_code == 400
        assert "invalid_subtitle_languages" in resp.json()["detail"]
        mock_start.assert_not_called()

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_subtitle_languages_reject_duplicates(self, mock_probe, mock_start, mock_isfile):
        # S3: one row per code — a repeated code would twin a sidecar.
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/a.mkv", languages=("spa",)),
            _probe_fixture("/mnt/storage/b.mkv", languages=("spa",)),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/a.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/b.mkv", "track_index": 0}],
                "subtitle_languages": ["spa", "spa"],
            },
        )
        assert resp.status_code == 400
        assert "invalid_subtitle_languages" in resp.json()["detail"]
        mock_start.assert_not_called()

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_without_subtitle_languages_keeps_the_derived_plan(self, mock_probe, mock_start, mock_isfile):
        # S3 compatibility pin: absent field ⇒ derive from the audio union,
        # rank-ordered exactly as before T2.
        mock_start.return_value = "test-task-absent"
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/a.mkv", languages=("eng", "rus")),
            _probe_fixture("/mnt/storage/b.mkv", languages=("spa",)),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/a.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/b.mkv", "track_index": 0}],
            },
        )
        assert resp.status_code == 200
        plan = mock_start.call_args.kwargs["subtitle_plan"]
        assert [e["language_code"] for e in plan] == ["spa", "eng", "rus"]

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_mux_empty_subtitle_languages_keeps_the_derived_plan(self, mock_probe, mock_start, mock_isfile):
        # S3 compatibility pin: an empty list is the same contract as an
        # absent field — derive from the audio union.
        mock_start.return_value = "test-task-empty"
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/a.mkv", languages=("spa", "eng")),
            _probe_fixture("/mnt/storage/b.mkv", languages=("spa",)),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/a.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/b.mkv", "track_index": 0}],
                "subtitle_languages": [],
            },
        )
        assert resp.status_code == 200
        plan = mock_start.call_args.kwargs["subtitle_plan"]
        assert [e["language_code"] for e in plan] == ["spa", "eng"]

    def test_search_uses_the_user_chosen_subtitle_codes(self, tmp_path):
        # S3(b): «Buscar subtítulos» queries OpenSubtitles with the codes the
        # user chose — the plan's language_code is the search code end to end.
        with patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True), \
                patch("interfaces.http.routes_mixer.start_mux") as mock_start, \
                patch("interfaces.http.routes_mixer.probe_file") as mock_probe:
            mock_start.return_value = "test-task-chosen"
            mock_probe.side_effect = [
                _probe_fixture("/mnt/storage/a.mkv", languages=("spa",)),
                _probe_fixture("/mnt/storage/b.mkv", languages=("spa",)),
            ]
            resp = client.post(
                "/api/mixer/mux",
                json={
                    "video_source": {"path": "/mnt/storage/a.mkv", "track_index": 0},
                    "audio_sources": [{"path": "/mnt/storage/b.mkv", "track_index": 0}],
                    "subtitle_languages": ["fra"],
                },
            )
        assert resp.status_code == 200
        plan = mock_start.call_args.kwargs["subtitle_plan"]
        for entry in plan:
            # the background run flips trackless pending → missing (searchable)
            entry["status"] = "missing"
        _search_task("t-chosen", tmp_path, plan)
        with patch("infrastructure.settings_store.get_setting", return_value="test-os-key"), \
                patch("infrastructure.opensubtitles_client.search_subtitles", return_value=[]) as mock_search, \
                patch("infrastructure.opensubtitles_client.download_subtitle"):
            resp = client.post("/api/mixer/tasks/t-chosen/subtitles/search", json={})
        try:
            assert resp.status_code == 200
            mock_search.assert_called_once_with("test-os-key", "Mixer", languages="fra")
        finally:
            mux_tasks._tasks.clear()


# ── Tasks List Endpoint ─────────────────────────────────────────────────────

class TestTasksListEndpoint:
    def test_list_tasks_empty(self):
        mux_tasks._tasks.clear()
        resp = client.get("/api/mixer/tasks")
        assert resp.status_code == 200
        data = resp.json()
        assert "tasks" in data
        assert isinstance(data["tasks"], list)

    def test_list_tasks_with_entries(self):
        mux_tasks._tasks.clear()
        mux_tasks._tasks["test-id"] = {
            "status": "running",
            "progress": 0.5,
            "detail": "Muxing...",
            "output_path": "/tmp/output.mkv",
            "created_at": time.time(),
            "cancelled": False,
            "paused": False,
        }
        resp = client.get("/api/mixer/tasks")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["tasks"]) == 1
        assert data["tasks"][0]["task_id"] == "test-id"
        assert data["tasks"][0]["status"] == "running"
        mux_tasks._tasks.clear()


# ── Single Task Endpoint ────────────────────────────────────────────────────

class TestSingleTaskEndpoint:
    def test_get_task_not_found(self):
        resp = client.get("/api/mixer/tasks/nonexistent-id")
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is False
        assert "not found" in data["detail"].lower()

    def test_get_task_found(self):
        mux_tasks._tasks.clear()
        mux_tasks._tasks["test-task-abc"] = {
            "status": "running",
            "progress": 0.75,
            "detail": "Muxing...",
            "output_path": "/tmp/output.mkv",
            "created_at": time.time(),
            "cancelled": False,
            "paused": False,
        }
        resp = client.get("/api/mixer/tasks/test-task-abc")
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["task_id"] == "test-task-abc"
        assert data["status"] == "running"
        assert data["progress"] == 0.75
        mux_tasks._tasks.clear()

    def test_get_task_exposes_subtitles(self):
        # S6: GET /api/mixer/tasks/:id surfaces the sidecar plan from creation.
        mux_tasks._tasks.clear()
        mux_tasks._tasks["test-task-subs"] = {
            "status": "running",
            "progress": 0.5,
            "detail": "Muxing...",
            "output_path": None,
            "created_at": time.time(),
            "cancelled": False,
            "paused": False,
            "subtitles": [{
                "language_code": "spa", "language": "es",
                "path": "/mnt/storage/a.mkv", "track_index": 0, "codec": "subrip",
                "extractable": True, "status": "pending", "detail": "", "sidecar": None,
            }],
        }
        resp = client.get("/api/mixer/tasks/test-task-subs")
        assert resp.status_code == 200
        data = resp.json()
        subs = data["subtitles"]
        assert len(subs) == 1
        assert subs[0]["language_code"] == "spa"
        assert subs[0]["language"] == "es"
        assert subs[0]["status"] == "pending"
        mux_tasks._tasks.clear()


# ── Cancel Task Endpoint ────────────────────────────────────────────────────

class TestCancelTaskEndpoint:
    def test_cancel_task_not_found(self):
        resp = client.post("/api/mixer/tasks/nonexistent-id/cancel")
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is False

    def test_cancel_task_running(self):
        mux_tasks._tasks.clear()
        pause_event = MagicMock()
        pause_event.is_set.return_value = True
        mux_tasks._tasks["test-cancel"] = {
            "status": "running",
            "progress": 0.5,
            "detail": "Muxing...",
            "output_path": None,
            "created_at": time.time(),
            "cancelled": False,
            "paused": False,
            "pause_event": pause_event,
            "process": None,
        }
        resp = client.post("/api/mixer/tasks/test-cancel/cancel")
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        mux_tasks._tasks.clear()


# ── Pause Task Endpoint ─────────────────────────────────────────────────────

class TestPauseTaskEndpoint:
    def test_pause_task_not_found(self):
        resp = client.post("/api/mixer/tasks/nonexistent-id/pause")
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is False

    def test_pause_task_running(self):
        mux_tasks._tasks.clear()
        pause_event = MagicMock()
        pause_event.is_set.return_value = True
        mux_tasks._tasks["test-pause"] = {
            "status": "running",
            "progress": 0.5,
            "detail": "Muxing...",
            "output_path": None,
            "created_at": time.time(),
            "cancelled": False,
            "paused": False,
            "pause_event": pause_event,
            "process": None,
        }
        resp = client.post("/api/mixer/tasks/test-pause/pause")
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        mux_tasks._tasks.clear()


# ── Resume Task Endpoint ────────────────────────────────────────────────────

class TestResumeTaskEndpoint:
    def test_resume_task_not_found(self):
        resp = client.post("/api/mixer/tasks/nonexistent-id/resume")
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is False

    def test_resume_task_paused(self):
        mux_tasks._tasks.clear()
        pause_event = MagicMock()
        pause_event.is_set.return_value = False
        mux_tasks._tasks["test-resume"] = {
            "status": "paused",
            "progress": 0.5,
            "detail": "Task paused",
            "output_path": None,
            "created_at": time.time(),
            "cancelled": False,
            "paused": True,
            "pause_event": pause_event,
            "process": None,
        }
        resp = client.post("/api/mixer/tasks/test-resume/resume")
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        mux_tasks._tasks.clear()


# ── Task Lifecycle ──────────────────────────────────────────────────────────

class TestTaskLifecycle:
    def test_start_poll_cancel(self):
        """Test full task lifecycle: start → poll → cancel."""
        mux_tasks._tasks.clear()

        # Add a running task
        pause_event = MagicMock()
        pause_event.is_set.return_value = True
        mux_tasks._tasks["lifecycle-test"] = {
            "status": "running",
            "progress": 0.25,
            "detail": "Muxing...",
            "output_path": None,
            "created_at": time.time(),
            "cancelled": False,
            "paused": False,
            "pause_event": pause_event,
            "process": None,
        }

        # Poll task
        resp = client.get("/api/mixer/tasks/lifecycle-test")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "running"
        assert data["progress"] == 0.25

        # Cancel task
        resp = client.post("/api/mixer/tasks/lifecycle-test/cancel")
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True

        mux_tasks._tasks.clear()


# ── Subtitle search (OpenSubtitles, S6/T6) ───────────────────────────────────

_SRT = "1\n00:00:01,000 --> 00:00:02,000\nHola\n"


def _sub_entry(code, status, **over):
    """`task["subtitles"]` entry as the S6 plan/T6 search leave it."""
    entry = {
        "language_code": code,
        "language": media_mixer.SHORT_LANGUAGE_SUFFIXES.get(code, code),
        "path": None,
        "track_index": None,
        "codec": None,
        "extractable": False,
        "status": status,
        "detail": "",
        "sidecar": None,
    }
    entry.update(over)
    return entry


def _search_task(task_id, tmp_path, entries, output_name="Mixer_20261018T120000_mixed.mkv"):
    """A finished mux task whose sidecar plan sits in the requested state."""
    mux_tasks._tasks[task_id] = {
        "status": "done",
        "progress": 1.0,
        "detail": "Mux complete",
        "output_path": str(tmp_path / output_name),
        "created_at": time.time(),
        "cancelled": False,
        "paused": False,
        "subtitles": entries,
    }


class TestSubtitleSearchEndpoint:
    def test_search_without_api_key_is_400_before_any_search(self, tmp_path):
        _search_task("t-nokey", tmp_path, [_sub_entry("spa", "missing")])
        with patch("infrastructure.settings_store.get_setting", return_value=""), \
                patch("infrastructure.opensubtitles_client.search_subtitles") as mock_search:
            resp = client.post("/api/mixer/tasks/t-nokey/subtitles/search", json={})
        try:
            assert resp.status_code == 400
            assert resp.json() == {"detail": {"error": "opensubtitles_not_configured"}}
            mock_search.assert_not_called()
        finally:
            mux_tasks._tasks.clear()

    def test_search_unknown_task_is_404(self):
        with patch("infrastructure.settings_store.get_setting", return_value="test-os-key"):
            resp = client.post("/api/mixer/tasks/nonexistent-id/subtitles/search", json={})
        assert resp.status_code == 404
        assert resp.json() == {"detail": "Task not found"}

    @patch("infrastructure.opensubtitles_client.download_subtitle", return_value=_SRT)
    @patch("infrastructure.opensubtitles_client.search_subtitles")
    @patch("infrastructure.settings_store.get_setting", return_value="test-os-key")
    def test_search_downloads_the_first_candidate_to_the_sidecar(self, _get, mock_search, mock_download, tmp_path):
        # «Extraer + OpenSubtitles»: los idiomas que la extracción no pudo dar
        # se buscan y bajan al MISMO sidecar junto a la salida.
        mock_search.return_value = [
            {"file_id": 42, "language": "es", "release": "r1", "title": "Mixer", "file_name": "Mixer.es.srt"},
            {"file_id": 43, "language": "es", "release": "r2", "title": "Mixer", "file_name": "Mixer.es2.srt"},
        ]
        _search_task("t-happy", tmp_path, [_sub_entry("spa", "missing")])

        resp = client.post("/api/mixer/tasks/t-happy/subtitles/search", json={})
        try:
            assert resp.status_code == 200
            sidecar = str(tmp_path / "Mixer_20261018T120000_mixed.es.srt")
            assert resp.json() == {
                "ok": True,
                "results": [{
                    "language": "es",
                    "language_code": "spa",
                    "status": "downloaded",
                    "sidecar": sidecar,
                }],
            }
            with open(sidecar, encoding="utf-8") as fh:
                assert fh.read() == _SRT
            # First candidate wins; the query is the title parsed from the
            # output filename (stem minus the `_mixed` suffix and timestamp).
            mock_search.assert_called_once_with("test-os-key", "Mixer", languages="spa")
            mock_download.assert_called_once_with("test-os-key", 42)
            # In place on the live task: GET /tasks/:id shows the new state.
            data = client.get("/api/mixer/tasks/t-happy").json()
            assert data["subtitles"][0]["status"] == "downloaded"
            assert data["subtitles"][0]["sidecar"] == sidecar
        finally:
            mux_tasks._tasks.clear()

    @patch("infrastructure.opensubtitles_client.download_subtitle", return_value=_SRT)
    @patch("infrastructure.opensubtitles_client.search_subtitles")
    @patch("infrastructure.settings_store.get_setting", return_value="test-os-key")
    def test_search_failure_keeps_the_status_and_continues(self, _get, mock_search, mock_download, tmp_path):
        # Un fallo a mitad de camino anota el error en ESA entrada y sigue con
        # el resto de idiomas.
        from infrastructure.opensubtitles_client import OpenSubtitlesError
        mock_search.side_effect = [
            OpenSubtitlesError("HTTP 503"),
            [{"file_id": 7, "language": "en", "release": "r", "title": "Mixer", "file_name": "Mixer.en.srt"}],
        ]
        _search_task("t-error", tmp_path, [_sub_entry("spa", "missing"), _sub_entry("eng", "not_extractable")])

        resp = client.post("/api/mixer/tasks/t-error/subtitles/search", json={})
        try:
            assert resp.status_code == 200
            assert resp.json() == {
                "ok": True,
                "results": [
                    {"language": "es", "language_code": "spa", "status": "missing", "detail": "HTTP 503"},
                    {
                        "language": "en",
                        "language_code": "eng",
                        "status": "downloaded",
                        "sidecar": str(tmp_path / "Mixer_20261018T120000_mixed.en.srt"),
                    },
                ],
            }
            mock_download.assert_called_once_with("test-os-key", 7)
        finally:
            mux_tasks._tasks.clear()

    @patch("infrastructure.opensubtitles_client.download_subtitle", return_value=_SRT)
    @patch("infrastructure.opensubtitles_client.search_subtitles", return_value=[])
    @patch("infrastructure.settings_store.get_setting", return_value="test-os-key")
    def test_search_without_candidates_marks_not_found(self, _get, mock_search, mock_download, tmp_path):
        _search_task("t-nocand", tmp_path, [_sub_entry("spa", "failed")])

        resp = client.post("/api/mixer/tasks/t-nocand/subtitles/search", json={})
        try:
            assert resp.status_code == 200
            assert resp.json() == {
                "ok": True,
                "results": [{"language": "es", "language_code": "spa", "status": "failed", "detail": "not_found"}],
            }
            mock_download.assert_not_called()
        finally:
            mux_tasks._tasks.clear()

    @patch("infrastructure.opensubtitles_client.download_subtitle", return_value=_SRT)
    @patch("infrastructure.opensubtitles_client.search_subtitles")
    @patch("infrastructure.settings_store.get_setting", return_value="test-os-key")
    def test_search_languages_filter_limits_the_targets(self, _get, mock_search, mock_download, tmp_path):
        mock_search.return_value = [
            {"file_id": 9, "language": "en", "release": "r", "title": "Mixer", "file_name": "Mixer.en.srt"},
        ]
        _search_task("t-filter", tmp_path, [_sub_entry("spa", "missing"), _sub_entry("eng", "missing")])

        resp = client.post("/api/mixer/tasks/t-filter/subtitles/search", json={"languages": ["eng"]})
        try:
            assert resp.status_code == 200
            data = resp.json()
            assert [r["language_code"] for r in data["results"]] == ["eng"]
            mock_search.assert_called_once_with("test-os-key", "Mixer", languages="eng")
        finally:
            mux_tasks._tasks.clear()

    @patch("infrastructure.opensubtitles_client.download_subtitle", return_value=_SRT)
    @patch("infrastructure.opensubtitles_client.search_subtitles")
    @patch("infrastructure.settings_store.get_setting", return_value="test-os-key")
    def test_search_without_output_path_annotates_and_skips(self, _get, mock_search, mock_download, tmp_path):
        # Sin salida no hay sidecar que escribir: la entrada se anota y se
        # sigue — una entrada rara nunca tumba la llamada completa.
        _search_task("t-noout", tmp_path, [_sub_entry("spa", "missing")])
        mux_tasks._tasks["t-noout"]["output_path"] = None

        resp = client.post("/api/mixer/tasks/t-noout/subtitles/search", json={})
        try:
            assert resp.status_code == 200
            assert resp.json() == {
                "ok": True,
                "results": [{"language": "es", "language_code": "spa", "status": "missing", "detail": "no_output_path"}],
            }
            mock_search.assert_not_called()
            mock_download.assert_not_called()
        finally:
            mux_tasks._tasks.clear()

    @patch("infrastructure.opensubtitles_client.download_subtitle", return_value=_SRT)
    @patch("infrastructure.opensubtitles_client.search_subtitles")
    @patch("infrastructure.settings_store.get_setting", return_value="test-os-key")
    def test_search_without_searchable_entries_returns_empty_results(self, _get, mock_search, mock_download, tmp_path):
        # «extracted»/«downloaded» nunca se vuelven a buscar.
        _search_task("t-empty", tmp_path, [
            _sub_entry("spa", "extracted", sidecar=str(tmp_path / "x.es.srt")),
            _sub_entry("eng", "downloaded", sidecar=str(tmp_path / "x.en.srt")),
        ])

        resp = client.post("/api/mixer/tasks/t-empty/subtitles/search", json={})
        try:
            assert resp.status_code == 200
            assert resp.json() == {"ok": True, "results": []}
            mock_search.assert_not_called()
            mock_download.assert_not_called()
        finally:
            mux_tasks._tasks.clear()


# ── Indexer Lookup (S7/T7) ─────────────────────────────────────────────────

class TestTitleFromFilename:
    """`_title_from_filename` — the S7 lookup query parsed from a file name.

    Cut at the first release tag, dots/underscores as spaces, trailing year
    kept (Radarr matches on it): `Dune.Parte.Dos.2024.1080p.WEB-DL.x264.mkv`
    → `Dune Parte Dos 2024`.
    """

    def test_cuts_at_the_first_release_tag_and_keeps_the_year(self):
        assert routes_mixer._title_from_filename(
            "Dune.Parte.Dos.2024.1080p.WEB-DL.x264.mkv"
        ) == "Dune Parte Dos 2024"

    def test_underscores_become_spaces(self):
        assert routes_mixer._title_from_filename(
            "The_Matrix_1999_720p_x265.mkv"
        ) == "The Matrix 1999"

    def test_a_parenthesised_year_is_kept(self):
        assert routes_mixer._title_from_filename(
            "Dune Parte Dos (2024).mkv"
        ) == "Dune Parte Dos (2024)"

    def test_the_audio_tag_ends_the_title_too(self):
        assert routes_mixer._title_from_filename(
            "La.La.Land.2016.DTS.1080p.mkv"
        ) == "La La Land 2016"

    def test_ddp_5_1_counts_as_a_tag(self):
        assert routes_mixer._title_from_filename(
            "Movie.Name.DDP5.1.1080p.mkv"
        ) == "Movie Name"

    def test_a_name_without_tags_survives(self):
        assert routes_mixer._title_from_filename(
            "pelicula rusa 2023.mkv"
        ) == "pelicula rusa 2023"


_RADARR_SERVICE = {"key": "radarr", "kind": "arr", "url": "http://localhost:7878", "api_key": "k"}


class TestLookupEndpoint:
    """POST /api/mixer/lookup — filename → title → Radarr (S7).

    `movie` is non-null only when the lookup resolves a movie that is IN the
    Radarr library (the `ReleaseSearchModal` item); an empty lookup is a 200
    with `movie: null`, and Radarr being unusable is a 502.
    """

    def test_missing_filename_is_400(self):
        resp = client.post("/api/mixer/lookup", json={})
        assert resp.status_code == 400
        assert resp.json() == {"detail": "filename is required"}

    def test_blank_filename_is_400(self):
        resp = client.post("/api/mixer/lookup", json={"filename": "   "})
        assert resp.status_code == 400
        assert resp.json() == {"detail": "filename is required"}

    def test_unparsable_filename_is_400(self):
        resp = client.post("/api/mixer/lookup", json={"filename": "1080p.mkv"})
        assert resp.status_code == 400
        assert resp.json() == {"detail": "Cannot derive a title from: 1080p.mkv"}

    @patch("interfaces.http.routes_mixer.find_service", return_value=_RADARR_SERVICE)
    @patch("interfaces.http.routes_mixer.arr_movie_exists", new_callable=AsyncMock)
    @patch("interfaces.http.routes_mixer.arr_movie_lookup", new_callable=AsyncMock)
    def test_in_library_movie_answers_the_modal_item(self, mock_lookup, mock_exists, _find):
        mock_lookup.return_value = {"tmdbId": 550, "title": "Dune Parte Dos", "year": 2024}
        mock_exists.return_value = 42

        resp = client.post(
            "/api/mixer/lookup",
            json={"filename": "Dune.Parte.Dos.2024.1080p.WEB-DL.x264.mkv"},
        )
        assert resp.status_code == 200
        assert resp.json() == {
            "ok": True,
            "title": "Dune Parte Dos 2024",
            "movie": {"id": 42, "title": "Dune Parte Dos", "year": 2024, "source": "radarr"},
        }
        mock_lookup.assert_awaited_once_with(ANY, _RADARR_SERVICE, "Dune Parte Dos 2024")
        mock_exists.assert_awaited_once_with(ANY, _RADARR_SERVICE, 550)

    @patch("interfaces.http.routes_mixer.find_service", return_value=_RADARR_SERVICE)
    @patch("interfaces.http.routes_mixer.arr_movie_exists", new_callable=AsyncMock, return_value=None)
    @patch("interfaces.http.routes_mixer.arr_movie_lookup", new_callable=AsyncMock)
    def test_movie_not_in_the_library_answers_null(self, mock_lookup, _exists, _find):
        # Lookup resolves the movie but Radarr does not own it: the UI answers
        # «añádela primero» instead of opening the modal.
        mock_lookup.return_value = {"tmdbId": 550, "title": "Dune Parte Dos", "year": 2024}

        resp = client.post(
            "/api/mixer/lookup",
            json={"filename": "Dune.Parte.Dos.2024.1080p.WEB-DL.x264.mkv"},
        )
        assert resp.status_code == 200
        assert resp.json() == {"ok": True, "title": "Dune Parte Dos 2024", "movie": None}

    @patch("interfaces.http.routes_mixer.find_service", return_value=_RADARR_SERVICE)
    @patch("interfaces.http.routes_mixer.arr_movie_exists", new_callable=AsyncMock)
    @patch("interfaces.http.routes_mixer.arr_movie_lookup", new_callable=AsyncMock, return_value={})
    def test_empty_lookup_answers_null(self, _lookup, mock_exists, _find):
        # Radarr answered and had nothing: 200 with `movie: null`, never a 502.
        resp = client.post(
            "/api/mixer/lookup",
            json={"filename": "Dune.Parte.Dos.2024.1080p.WEB-DL.x264.mkv"},
        )
        assert resp.status_code == 200
        assert resp.json() == {"ok": True, "title": "Dune Parte Dos 2024", "movie": None}
        mock_exists.assert_not_awaited()

    @patch("interfaces.http.routes_mixer.find_service", return_value=_RADARR_SERVICE)
    @patch("interfaces.http.routes_mixer.arr_movie_exists", new_callable=AsyncMock)
    @patch("interfaces.http.routes_mixer.arr_movie_lookup", new_callable=AsyncMock)
    def test_radarr_failure_is_502(self, mock_lookup, mock_exists, _find):
        mock_lookup.side_effect = aiohttp.ClientError("connection refused")

        resp = client.post(
            "/api/mixer/lookup",
            json={"filename": "Dune.Parte.Dos.2024.1080p.WEB-DL.x264.mkv"},
        )
        assert resp.status_code == 502
        assert resp.json() == {"detail": "Radarr lookup failed: connection refused"}
        mock_exists.assert_not_awaited()

    @patch("interfaces.http.routes_mixer.arr_movie_lookup", new_callable=AsyncMock)
    @patch("interfaces.http.routes_mixer.find_service", return_value=None)
    def test_unconfigured_radarr_is_502(self, _find, mock_lookup):
        resp = client.post(
            "/api/mixer/lookup",
            json={"filename": "Dune.Parte.Dos.2024.1080p.WEB-DL.x264.mkv"},
        )
        assert resp.status_code == 502
        assert resp.json() == {"detail": "radarr no está configurado (faltan la URL o la API key)"}
        mock_lookup.assert_not_awaited()


# ── Alternatives (S10/T11) ──────────────────────────────────────────────────

_ALT_PATH = "/media/dune/Dune.Parte.Dos.2024.1080p.WEB-DL.x264.mkv"


class TestAlternativesLookupEndpoint:
    """POST /api/mixer/alternatives/lookup — path → title + movie + audio langs.

    The T7 lookup with a real file attached: `_title_from_filename` + Radarr
    (`movie` non-null only when the library owns it) plus `audio_languages` —
    the normalized, deduped codes of the file's audio tracks in the
    ca→en→ru→cat order. A path ffprobe cannot read is 400 (bad input);
    Radarr being unusable is 502, never a silent "not in library".
    """

    def test_missing_path_is_400(self):
        resp = client.post("/api/mixer/alternatives/lookup", json={})
        assert resp.status_code == 400
        assert resp.json() == {"detail": "path is required"}

    def test_blank_path_is_400(self):
        resp = client.post("/api/mixer/alternatives/lookup", json={"path": "   "})
        assert resp.status_code == 400
        assert resp.json() == {"detail": "path is required"}

    @patch("interfaces.http.routes_mixer.probe_file")
    def test_unparsable_path_is_400(self, mock_probe):
        mock_probe.return_value = _probe_fixture("1080p.mkv")

        resp = client.post("/api/mixer/alternatives/lookup", json={"path": "1080p.mkv"})
        assert resp.status_code == 400
        assert resp.json() == {"detail": "Cannot derive a title from: 1080p.mkv"}

    @patch(
        "interfaces.http.routes_mixer.probe_file",
        side_effect=RuntimeError("ffprobe failed: boom"),
    )
    def test_a_failed_probe_is_400(self, _probe):
        resp = client.post("/api/mixer/alternatives/lookup", json={"path": _ALT_PATH})
        assert resp.status_code == 400
        assert resp.json() == {"detail": "ffprobe failed: boom"}

    @patch(
        "interfaces.http.routes_mixer.probe_file",
        side_effect=FileNotFoundError(f"File not found: {_ALT_PATH}"),
    )
    def test_a_missing_file_is_400(self, _probe):
        resp = client.post("/api/mixer/alternatives/lookup", json={"path": _ALT_PATH})
        assert resp.status_code == 400
        assert resp.json() == {"detail": f"File not found: {_ALT_PATH}"}

    @patch("interfaces.http.routes_mixer.find_service", return_value=_RADARR_SERVICE)
    @patch("interfaces.http.routes_mixer.arr_movie_exists", new_callable=AsyncMock)
    @patch("interfaces.http.routes_mixer.arr_movie_lookup", new_callable=AsyncMock)
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_in_library_movie_answers_the_modal_item(
        self, mock_probe, mock_lookup, mock_exists, _find
    ):
        mock_probe.return_value = _probe_fixture(_ALT_PATH, languages=("cat", "en", "spa", "rus"))
        mock_lookup.return_value = {"tmdbId": 550, "title": "Dune Parte Dos", "year": 2024}
        mock_exists.return_value = 42

        resp = client.post("/api/mixer/alternatives/lookup", json={"path": _ALT_PATH})
        assert resp.status_code == 200
        assert resp.json() == {
            "ok": True,
            "title": "Dune Parte Dos 2024",
            "movie": {"id": 42, "title": "Dune Parte Dos", "year": 2024, "source": "radarr"},
            "audio_languages": ["spa", "eng", "rus", "cat"],
            # T3/S4: always in the response — `null` / `[]` when the lookup
            # payload carries no titles, never a missing key.
            "original_title": None,
            "alternate_titles": [],
        }
        mock_probe.assert_called_once_with(_ALT_PATH)
        mock_lookup.assert_awaited_once_with(ANY, _RADARR_SERVICE, "Dune Parte Dos 2024")
        mock_exists.assert_awaited_once_with(ANY, _RADARR_SERVICE, 550)

    @patch("interfaces.http.routes_mixer.find_service", return_value=_RADARR_SERVICE)
    @patch("interfaces.http.routes_mixer.arr_movie_lookup", new_callable=AsyncMock, return_value={})
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_audio_languages_are_normalized_deduped_and_ordered(
        self, mock_probe, _lookup, _find
    ):
        # es→spa, en→eng; cat twice collapses to one; the four ordered codes
        # come first (spa→eng→rus→cat) and the rest follow in code order.
        mock_probe.return_value = _probe_fixture(
            _ALT_PATH, languages=("cat", "cat", "es", "fra", "und", "en")
        )

        resp = client.post("/api/mixer/alternatives/lookup", json={"path": _ALT_PATH})
        assert resp.status_code == 200
        assert resp.json()["audio_languages"] == ["spa", "eng", "cat", "fra", "und"]

    @patch("interfaces.http.routes_mixer.find_service", return_value=_RADARR_SERVICE)
    @patch("interfaces.http.routes_mixer.arr_movie_exists", new_callable=AsyncMock, return_value=None)
    @patch("interfaces.http.routes_mixer.arr_movie_lookup", new_callable=AsyncMock)
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_movie_not_in_the_library_answers_null(
        self, mock_probe, mock_lookup, _exists, _find
    ):
        mock_probe.return_value = _probe_fixture(_ALT_PATH)
        mock_lookup.return_value = {"tmdbId": 550, "title": "Dune Parte Dos", "year": 2024}

        resp = client.post("/api/mixer/alternatives/lookup", json={"path": _ALT_PATH})
        assert resp.status_code == 200
        body = resp.json()
        assert body["movie"] is None
        assert body["audio_languages"] == ["spa"]

    @patch("interfaces.http.routes_mixer.find_service", return_value=_RADARR_SERVICE)
    @patch("interfaces.http.routes_mixer.arr_movie_exists", new_callable=AsyncMock, return_value=42)
    @patch("interfaces.http.routes_mixer.arr_movie_lookup", new_callable=AsyncMock)
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_the_response_surfaces_original_and_alternate_titles(
        self, mock_probe, mock_lookup, _exists, _find
    ):
        """T3/S4: the «Búsqueda en idioma» chips ride the lookup response —
        `original_title` plus `[{title, language}]` in Radarr order, with
        `language: null` where the payload omits it (the documented real
        Radarr shape, tests_wanted_scan.py)."""
        mock_probe.return_value = _probe_fixture(_ALT_PATH)
        mock_lookup.return_value = {
            "tmdbId": 550,
            "title": "Arthur and the Invisibles",
            "year": 2006,
            "original_title": "Arthur et les Minimoys",
            "alternate_titles": [
                {"title": "Артур и минипуты", "language": "ru"},
                {"title": "Ton Nom", "language": None},
            ],
        }

        resp = client.post("/api/mixer/alternatives/lookup", json={"path": _ALT_PATH})
        assert resp.status_code == 200
        body = resp.json()
        assert body["original_title"] == "Arthur et les Minimoys"
        assert body["alternate_titles"] == [
            {"title": "Артур и минипуты", "language": "ru"},
            {"title": "Ton Nom", "language": None},
        ]

    @patch("interfaces.http.routes_mixer.find_service", return_value=_RADARR_SERVICE)
    @patch("interfaces.http.routes_mixer.arr_movie_exists", new_callable=AsyncMock, return_value=None)
    @patch("interfaces.http.routes_mixer.arr_movie_lookup", new_callable=AsyncMock)
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_titles_surface_even_when_the_movie_is_not_in_the_library(
        self, mock_probe, mock_lookup, _exists, _find
    ):
        """The titles come from the LOOKUP payload, not from the library: they
        surface even when `movie` is null (T7's "not in the library" answer).
        The two keys are always served (`str | null` / `list`) — an absent
        payload field is `null`/`[]`, never a missing key (the exact-body test
        above pins that reading)."""
        mock_probe.return_value = _probe_fixture(_ALT_PATH)
        mock_lookup.return_value = {
            "tmdbId": 550,
            "title": "Arthur and the Invisibles",
            "year": 2006,
            "original_title": "Arthur et les Minimoys",
            "alternate_titles": [{"title": "Артур и минипуты", "language": "ru"}],
        }

        resp = client.post("/api/mixer/alternatives/lookup", json={"path": _ALT_PATH})
        assert resp.status_code == 200
        body = resp.json()
        assert body["movie"] is None
        assert body["original_title"] == "Arthur et les Minimoys"
        assert body["alternate_titles"] == [{"title": "Артур и минипуты", "language": "ru"}]

    @patch("interfaces.http.routes_mixer.find_service", return_value=_RADARR_SERVICE)
    @patch("interfaces.http.routes_mixer.arr_movie_lookup", new_callable=AsyncMock)
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_radarr_failure_is_502(self, mock_probe, mock_lookup, _find):
        mock_probe.return_value = _probe_fixture(_ALT_PATH)
        mock_lookup.side_effect = aiohttp.ClientError("connection refused")

        resp = client.post("/api/mixer/alternatives/lookup", json={"path": _ALT_PATH})
        assert resp.status_code == 502
        assert resp.json() == {"detail": "Radarr lookup failed: connection refused"}

    @patch("interfaces.http.routes_mixer.find_service", return_value=None)
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_unconfigured_radarr_is_502(self, mock_probe, _find):
        mock_probe.return_value = _probe_fixture(_ALT_PATH)

        resp = client.post("/api/mixer/alternatives/lookup", json={"path": _ALT_PATH})
        assert resp.status_code == 502
        assert resp.json() == {
            "detail": "radarr no está configurado (faltan la URL o la API key)"
        }


class TestAlternativesStatusEndpoint:
    """GET /api/mixer/alternatives/status — ready | downloading | unknown.

    1) the file Radarr holds → `ready` (`allowed` from `config.path_is_allowed`);
    2) else a downloads row whose casefolded title contains the normalized
       title → `downloading` (its `progress`, null when it cannot be known);
    3) else `unknown`. `movie_id <= 0` or an empty `title` is 400.
    """

    def test_missing_query_is_400(self):
        resp = client.get("/api/mixer/alternatives/status")
        assert resp.status_code == 400

    def test_zero_movie_id_is_400(self):
        resp = client.get(
            "/api/mixer/alternatives/status", params={"movie_id": 0, "title": "Dune"}
        )
        assert resp.status_code == 400

    def test_negative_movie_id_is_400(self):
        resp = client.get(
            "/api/mixer/alternatives/status", params={"movie_id": -3, "title": "Dune"}
        )
        assert resp.status_code == 400

    def test_empty_title_is_400(self):
        resp = client.get(
            "/api/mixer/alternatives/status", params={"movie_id": 42, "title": "  "}
        )
        assert resp.status_code == 400

    @patch("config.path_is_allowed", return_value=True)
    @patch("interfaces.http.routes_mixer.find_service", return_value=_RADARR_SERVICE)
    @patch("interfaces.http.routes_mixer.arr_movie_file", new_callable=AsyncMock)
    def test_ready_when_radarr_has_the_file(self, mock_file, _find, mock_allowed):
        mock_file.return_value = "/movies/Dune Parte Dos (2024)/Dune.mkv"

        resp = client.get(
            "/api/mixer/alternatives/status",
            params={"movie_id": 42, "title": "Dune Parte Dos 2024"},
        )
        assert resp.status_code == 200
        assert resp.json() == {
            "state": "ready",
            "progress": None,
            "path": "/movies/Dune Parte Dos (2024)/Dune.mkv",
            "allowed": True,
        }
        mock_file.assert_awaited_once_with(ANY, _RADARR_SERVICE, 42)
        mock_allowed.assert_called_once_with("/movies/Dune Parte Dos (2024)/Dune.mkv")

    @patch("config.path_is_allowed", return_value=False)
    @patch("interfaces.http.routes_mixer.find_service", return_value=_RADARR_SERVICE)
    @patch("interfaces.http.routes_mixer.arr_movie_file", new_callable=AsyncMock)
    def test_ready_outside_allowed_roots_reports_not_allowed(self, mock_file, _find, _allowed):
        mock_file.return_value = "/elsewhere/Dune.mkv"

        resp = client.get(
            "/api/mixer/alternatives/status",
            params={"movie_id": 42, "title": "Dune Parte Dos 2024"},
        )
        assert resp.status_code == 200
        assert resp.json() == {
            "state": "ready",
            "progress": None,
            "path": "/elsewhere/Dune.mkv",
            "allowed": False,
        }

    @patch("application.use_cases.downloads_cache.get_downloads", new_callable=AsyncMock)
    @patch("interfaces.http.routes_mixer.arr_movie_file", new_callable=AsyncMock, return_value=None)
    @patch("interfaces.http.routes_mixer.find_service", return_value=_RADARR_SERVICE)
    def test_downloading_matches_the_casefolded_title(self, _find, _file, mock_downloads):
        mock_downloads.return_value = {
            "downloads": [
                {"title": "Otra Cosa (2020).mkv", "progress": 10.0},
                {"title": "Dune Parte Dos 2024 1080p WEB-DL x264-GRP", "progress": 31.5},
            ]
        }

        resp = client.get(
            "/api/mixer/alternatives/status",
            params={"movie_id": 42, "title": "Dune Parte Dos 2024"},
        )
        assert resp.status_code == 200
        assert resp.json() == {
            "state": "downloading",
            "progress": 31.5,
            "path": None,
            "allowed": False,
        }

    @patch("application.use_cases.downloads_cache.get_downloads", new_callable=AsyncMock)
    @patch("interfaces.http.routes_mixer.arr_movie_file", new_callable=AsyncMock, return_value=None)
    @patch("interfaces.http.routes_mixer.find_service", return_value=_RADARR_SERVICE)
    def test_downloading_matches_a_dotted_release_name(self, _find, _file, mock_downloads):
        # L25 flow: real torrent rows are dotted release names — the needle
        # and the row title must BOTH be normalized, or the wait never shows
        # progress (parent amendment to worker interpretation 8).
        mock_downloads.return_value = {
            "downloads": [
                {"title": "Dune.Parte.Dos.2024.1080p.WEB-DL.x264-GRP", "progress": 42.0},
            ]
        }

        resp = client.get(
            "/api/mixer/alternatives/status",
            params={"movie_id": 42, "title": "Dune Parte Dos 2024"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["state"] == "downloading"
        assert body["progress"] == 42.0

    @patch("application.use_cases.downloads_cache.get_downloads", new_callable=AsyncMock)
    @patch("interfaces.http.routes_mixer.arr_movie_file", new_callable=AsyncMock, return_value=None)
    @patch("interfaces.http.routes_mixer.find_service", return_value=_RADARR_SERVICE)
    def test_downloading_without_knowable_progress_is_null(self, _find, _file, mock_downloads):
        mock_downloads.return_value = {
            "downloads": [{"title": "Dune Parte Dos 2024 1080p WEB-DL x264-GRP"}]
        }

        resp = client.get(
            "/api/mixer/alternatives/status",
            params={"movie_id": 42, "title": "Dune Parte Dos 2024"},
        )
        assert resp.status_code == 200
        assert resp.json() == {
            "state": "downloading",
            "progress": None,
            "path": None,
            "allowed": False,
        }

    @patch("application.use_cases.downloads_cache.get_downloads", new_callable=AsyncMock)
    @patch("interfaces.http.routes_mixer.arr_movie_file", new_callable=AsyncMock, return_value=None)
    @patch("interfaces.http.routes_mixer.find_service", return_value=_RADARR_SERVICE)
    def test_a_row_for_another_title_does_not_match(self, _find, _file, mock_downloads):
        mock_downloads.return_value = {
            "downloads": [{"title": "Dune 1984 REMASTERED 1080p.mkv", "progress": 50.0}]
        }

        resp = client.get(
            "/api/mixer/alternatives/status",
            params={"movie_id": 42, "title": "Dune Parte Dos 2024"},
        )
        assert resp.status_code == 200
        assert resp.json() == {
            "state": "unknown",
            "progress": None,
            "path": None,
            "allowed": False,
        }

    @patch("application.use_cases.downloads_cache.get_downloads", new_callable=AsyncMock)
    @patch("interfaces.http.routes_mixer.arr_movie_file", new_callable=AsyncMock, return_value=None)
    @patch("interfaces.http.routes_mixer.find_service", return_value=_RADARR_SERVICE)
    def test_unknown_without_file_or_row(self, _find, _file, mock_downloads):
        mock_downloads.return_value = {"downloads": []}

        resp = client.get(
            "/api/mixer/alternatives/status",
            params={"movie_id": 42, "title": "Dune Parte Dos 2024"},
        )
        assert resp.status_code == 200
        assert resp.json() == {
            "state": "unknown",
            "progress": None,
            "path": None,
            "allowed": False,
        }

    @patch("config.path_is_allowed", return_value=True)
    @patch("application.use_cases.downloads_cache.get_downloads", new_callable=AsyncMock)
    @patch("interfaces.http.routes_mixer.arr_movie_file", new_callable=AsyncMock)
    @patch("interfaces.http.routes_mixer.find_service", return_value=_RADARR_SERVICE)
    def test_the_file_wins_over_a_download_row(self, _find, mock_file, mock_downloads, _allowed):
        mock_file.return_value = "/movies/Dune Parte Dos (2024)/Dune.mkv"
        mock_downloads.return_value = {
            "downloads": [{"title": "Dune Parte Dos 2024 1080p WEB-DL x264-GRP"}]
        }

        resp = client.get(
            "/api/mixer/alternatives/status",
            params={"movie_id": 42, "title": "Dune Parte Dos 2024"},
        )
        assert resp.status_code == 200
        assert resp.json()["state"] == "ready"
        mock_downloads.assert_not_awaited()


# ── destination_path: fail-closed substitution target (S11-1/S11-5) ───────

class TestMuxDestination:
    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_destination_that_is_not_an_input_is_400_invalid_destination(
        self, mock_probe, mock_start, mock_isfile
    ):
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/video.mkv"),
            _probe_fixture("/mnt/storage/audio.mkv"),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/video.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/audio.mkv", "track_index": 1}],
                "destination_path": "/mnt/storage/other.mkv",
            },
        )

        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "invalid_destination"
        mock_start.assert_not_called()

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_destination_fails_closed_when_not_allowed(
        self, mock_probe, mock_start, mock_isfile
    ):
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/video.mkv"),
            _probe_fixture("/mnt/storage/audio.mkv"),
        ]

        with patch("config.path_is_allowed", return_value=False):
            resp = client.post(
                "/api/mixer/mux",
                json={
                    "video_source": {"path": "/mnt/storage/video.mkv", "track_index": 0},
                    "audio_sources": [{"path": "/mnt/storage/audio.mkv", "track_index": 1}],
                    "destination_path": "/mnt/storage/video.mkv",
                },
            )

        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "invalid_destination"
        mock_probe.assert_not_called()  # fail closed BEFORE any gate work
        mock_start.assert_not_called()

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_destination_may_be_the_video_input(self, mock_probe, mock_start, mock_isfile):
        mock_start.return_value = "dest-task-video"
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/video.mkv"),
            _probe_fixture("/mnt/storage/audio.mkv"),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/video.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/audio.mkv", "track_index": 1}],
                "destination_path": "/mnt/storage/video.mkv",
            },
        )

        assert resp.status_code == 200
        assert mock_start.call_args.kwargs["destination_path"] == "/mnt/storage/video.mkv"

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_destination_may_be_an_audio_input(self, mock_probe, mock_start, mock_isfile):
        mock_start.return_value = "dest-task-audio"
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/video.mkv"),
            _probe_fixture("/mnt/storage/audio.mkv"),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/video.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/audio.mkv", "track_index": 1}],
                "destination_path": "/mnt/storage/audio.mkv",
            },
        )

        assert resp.status_code == 200
        assert mock_start.call_args.kwargs["destination_path"] == "/mnt/storage/audio.mkv"

    @patch("interfaces.http.routes_mixer.os.path.isfile", return_value=True)
    @patch("interfaces.http.routes_mixer.start_mux")
    @patch("interfaces.http.routes_mixer.probe_file")
    def test_no_destination_keeps_the_legacy_call(self, mock_probe, mock_start, mock_isfile):
        mock_start.return_value = "legacy-task"
        mock_probe.side_effect = [
            _probe_fixture("/mnt/storage/video.mkv"),
            _probe_fixture("/mnt/storage/audio.mkv"),
        ]

        resp = client.post(
            "/api/mixer/mux",
            json={
                "video_source": {"path": "/mnt/storage/video.mkv", "track_index": 0},
                "audio_sources": [{"path": "/mnt/storage/audio.mkv", "track_index": 1}],
            },
        )

        assert resp.status_code == 200
        # Empty destination: legacy output-path-directory mode, untouched.
        assert not mock_start.call_args.kwargs.get("destination_path")
        # The sidecar plan still covers the audio languages (S6/T6).
        plan = mock_start.call_args.kwargs["subtitle_plan"]
        assert [entry["language_code"] for entry in plan] == ["spa"]


# ── task list ordering: running, queued FIFO, terminal desc (S11-4) ───────

class TestTasksListOrdering:
    def test_running_first_then_queued_fifo_then_terminal_by_created_at_desc(self):
        mux_tasks._tasks.clear()
        now = time.time()
        specs = {
            # Inserted scrambled: dict order must NOT decide the listing.
            "done-new": ("done", now - 10),
            "queued-second": ("queued", now - 40),
            "running-1": ("running", now - 100),
            "done-old": ("done", now - 300),
            "queued-first": ("queued", now - 50),
        }
        for task_id, (status, created_at) in specs.items():
            mux_tasks._tasks[task_id] = {
                "status": status,
                "progress": 0.5,
                "detail": "",
                "output_path": None,
                "created_at": created_at,
                "cancelled": False,
                "paused": False,
            }

        resp = client.get("/api/mixer/tasks")

        assert resp.status_code == 200
        ids = [t["task_id"] for t in resp.json()["tasks"]]
        assert ids == [
            "running-1",
            "queued-first",   # FIFO: starts first comes first
            "queued-second",
            "done-new",       # terminal: newest first
            "done-old",
        ]
        mux_tasks._tasks.clear()

    def test_a_queued_task_is_visible_in_list_and_detail(self):
        mux_tasks._tasks.clear()
        mux_tasks._tasks["queued-visible"] = {
            "status": "queued",
            "progress": 0.0,
            "detail": "Queued",
            "output_path": None,
            "created_at": time.time(),
            "cancelled": False,
            "paused": False,
        }

        resp = client.get("/api/mixer/tasks")
        assert resp.status_code == 200
        assert [t["status"] for t in resp.json()["tasks"]] == ["queued"]

        resp = client.get("/api/mixer/tasks/queued-visible")
        assert resp.status_code == 200
        assert resp.json()["status"] == "queued"
        mux_tasks._tasks.clear()


class TestCancelQueuedTask:
    def test_cancelling_a_queued_task_is_terminal_and_ok(self):
        mux_tasks._tasks.clear()
        pause_event = MagicMock()
        pause_event.is_set.return_value = True
        mux_tasks._tasks["queued-cancel"] = {
            "status": "queued",
            "progress": 0.0,
            "detail": "Queued",
            "output_path": None,
            "created_at": time.time(),
            "cancelled": False,
            "paused": False,
            "pause_event": pause_event,
            "process": None,
        }

        resp = client.post("/api/mixer/tasks/queued-cancel/cancel")

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
        # Consistent terminal vocabulary: `cancelled`, never left to run.
        assert resp.json()["status"] == "cancelled"
        mux_tasks._tasks.clear()
