"""Tests para las rutas API de media_mixer."""
import os
import time
from unittest.mock import patch, MagicMock

# Configurar env vars antes de importar
os.environ.setdefault("FOLDER_OUTPUT_MIXED", "/tmp/mixed-test")

from fastapi.testclient import TestClient
from app import app
import media_mixer
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
