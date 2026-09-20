"""Tests para las rutas API de media_mixer."""
import os
import time
from unittest.mock import patch, MagicMock

# Configurar env vars antes de importar
os.environ.setdefault("FOLDER_OUTPUT_MIXED", "/tmp/mixed-test")

from fastapi.testclient import TestClient
from app import app
from task_manager import mux_tasks

client = TestClient(app, raise_server_exceptions=False)


# ── Probe Endpoint ──────────────────────────────────────────────────────────

class TestProbeEndpoint:
    @patch("routes_mixer.os.path.isfile", return_value=True)
    @patch("routes_mixer.check_compatibility")
    @patch("routes_mixer.probe_file")
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

    @patch("routes_mixer.os.path.isfile", return_value=True)
    @patch("routes_mixer.check_compatibility")
    @patch("routes_mixer.probe_file")
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

class TestMuxEndpoint:
    @patch("routes_mixer.os.path.isfile", return_value=True)
    @patch("routes_mixer.start_mux")
    def test_mux_starts_task(self, mock_start, mock_isfile):
        mock_start.return_value = "test-task-id-123"

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

    @patch("routes_mixer.os.path.isfile", return_value=True)
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

    @patch("routes_mixer.os.path.isfile", return_value=True)
    @patch("routes_mixer.start_mux")
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
