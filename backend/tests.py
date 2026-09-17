"""Tests para las funciones de path resolution y copy_files."""
import os
import shutil
import tempfile
from pathlib import Path

import pytest

# Configurar env vars antes de importar app
os.environ.setdefault("FOLDER_DOWNLOAD_AMULE", "/mnt/storage-6tb/shared-downloads/amule")
os.environ.setdefault("FOLDER_DOWNLOAD_TORRENT", "/mnt/storage/downloads/qbittorrent/completed")
os.environ.setdefault("RADARR_URL", "http://localhost:7878")
os.environ.setdefault("SONARR_URL", "http://localhost:8989")
os.environ.setdefault("AMUTORRENT_URL", "http://localhost:4000")

from traces import host_path as _host_path, resolve_current_path as _resolve_current_path
from config import _VOLUME_MAP
from copy_engine import copy_files_to_root as _copy_files_to_root, _tasks, CopyCancelled


# ── _host_path ──────────────────────────────────────────────────────────────

class TestHostPath:
    def test_data_mapping(self):
        assert _host_path("/data/shared-media/movies") == "/mnt/storage/shared-media/movies"

    def test_data_6tb_mapping(self):
        assert _host_path("/data-6tb/shared-media/movies") == "/mnt/storage-6tb/shared-media/movies"

    def test_downloads_incoming_amule(self):
        # _host_path requiere trailing slash para matchear /downloads/incoming/
        assert _host_path("/downloads/incoming/") == "/mnt/storage-6tb/shared-downloads/amule/"

    def test_downloads_incoming_no_slash(self):
        # Sin trailing slash, matchea /downloads/ → shared-downloads/
        assert _host_path("/downloads/incoming") == "/mnt/storage-6tb/shared-downloads/incoming"

    def test_downloads_other(self):
        result = _host_path("/downloads/torrents/completed")
        assert result == "/mnt/storage-6tb/shared-downloads/torrents/completed"

    def test_unknown_path_unchanged(self):
        assert _host_path("/some/unknown/path") == "/some/unknown/path"

    def test_empty_string(self):
        assert _host_path("") == ""


# ── _resolve_current_path ───────────────────────────────────────────────────

class TestResolveCurrentPath:
    def test_amule_by_client_name(self):
        result = _resolve_current_path("/downloads/incoming", "amule")
        assert result == "/mnt/storage-6tb/shared-downloads/amule"

    def test_amutorrent_by_client_name(self):
        result = _resolve_current_path("/downloads/incoming", "aMuTorrent")
        assert result == "/mnt/storage-6tb/shared-downloads/amule"

    def test_qbittorrent_by_client_name(self):
        result = _resolve_current_path("/downloads/completed", "qBittorrent")
        assert result == "/mnt/storage/downloads/qbittorrent/completed"

    def test_qbit_by_client_name(self):
        result = _resolve_current_path("/downloads/completed", "qbit-vpn")
        assert result == "/mnt/storage/downloads/qbittorrent/completed"

    def test_amule_by_pattern(self):
        result = _resolve_current_path("/downloads/incoming", None)
        assert result == "/mnt/storage-6tb/shared-downloads/amule"

    def test_torrent_by_pattern(self):
        result = _resolve_current_path("/downloads/something", None)
        assert result == "/mnt/storage/downloads/qbittorrent/completed"

    def test_fallback_to_volume_map(self):
        result = _resolve_current_path("/data/shared-media/movies", None)
        assert result == "/mnt/storage/shared-media/movies"

    def test_empty_save_path(self):
        result = _resolve_current_path("", None)
        assert result == ""

    def test_no_client_no_match(self):
        result = _resolve_current_path("/opt/files", None)
        assert result == "/opt/files"


# ── _copy_files_to_root ─────────────────────────────────────────────────────

class TestCopyFilesToRoot:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()

    def teardown_method(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_copy_single_file(self):
        src_dir = os.path.join(self.tmpdir, "src")
        dst_dir = os.path.join(self.tmpdir, "dst")
        os.makedirs(src_dir)
        os.makedirs(dst_dir)

        # Crear archivo fuente
        src_file = os.path.join(src_dir, "movie.mkv")
        Path(src_file).write_text("fake video data")

        result = _copy_files_to_root(src_file, dst_dir, is_host_path=True)
        assert result["ok"] is True
        assert result["files_copied"] == 1
        assert os.path.exists(os.path.join(dst_dir, "movie.mkv"))

    def test_copy_directory(self):
        src_dir = os.path.join(self.tmpdir, "src")
        dst_dir = os.path.join(self.tmpdir, "dst")
        os.makedirs(src_dir)
        os.makedirs(dst_dir)

        # Crear archivos en directorio fuente
        for name in ["a.mkv", "b.nfo", "subdir"]:
            path = os.path.join(src_dir, name)
            if name == "subdir":
                os.makedirs(path)
            else:
                Path(path).write_text(f"data {name}")

        result = _copy_files_to_root(src_dir, dst_dir, is_host_path=True)
        assert result["ok"] is True
        assert result["files_copied"] == 2  # solo archivos, no subdirectorios
        assert os.path.exists(os.path.join(dst_dir, "a.mkv"))
        assert os.path.exists(os.path.join(dst_dir, "b.nfo"))

    def test_source_not_found(self):
        result = _copy_files_to_root("/nonexistent/path/file.mkv", "/tmp/dst", is_host_path=True)
        assert result["ok"] is False
        assert "fuente no encontrada" in result["detail"]

    def test_creates_dst_dir(self):
        src_dir = os.path.join(self.tmpdir, "src")
        dst_dir = os.path.join(self.tmpdir, "new", "nested", "dst")
        os.makedirs(src_dir)
        Path(os.path.join(src_dir, "file.txt")).write_text("hello")

        result = _copy_files_to_root(src_dir, dst_dir, is_host_path=True)
        assert result["ok"] is True
        assert os.path.isdir(dst_dir)

    def test_copy_with_task_id_updates_progress(self):
        src_dir = os.path.join(self.tmpdir, "src")
        dst_dir = os.path.join(self.tmpdir, "dst")
        os.makedirs(src_dir)
        os.makedirs(dst_dir)

        for name in ["a.mkv", "b.mkv", "c.mkv"]:
            Path(os.path.join(src_dir, name)).write_text(f"data {name}")

        task_id = "test-task-001"
        _tasks[task_id] = {
            "status": "running",
            "copied_bytes": 0,
            "total_bytes": 0,
            "files_done": 0,
            "files_total": 0,
        }

        result = _copy_files_to_root(src_dir, dst_dir, is_host_path=True, task_id=task_id)
        assert result["ok"] is True
        assert result["files_copied"] == 3

        task = _tasks[task_id]
        assert task["status"] == "running"
        assert task["files_done"] == 3
        assert task["files_total"] == 3
        assert task["total_bytes"] > 0
        assert task["copied_bytes"] == task["total_bytes"]

        del _tasks[task_id]

    def test_copy_single_file_with_task_id(self):
        src_dir = os.path.join(self.tmpdir, "src")
        dst_dir = os.path.join(self.tmpdir, "dst")
        os.makedirs(src_dir)
        os.makedirs(dst_dir)
        Path(os.path.join(src_dir, "movie.mkv")).write_text("fake video data")

        task_id = "test-task-002"
        _tasks[task_id] = {
            "status": "running",
            "copied_bytes": 0,
            "total_bytes": 0,
            "files_done": 0,
            "files_total": 0,
        }

        result = _copy_files_to_root(
            os.path.join(src_dir, "movie.mkv"), dst_dir, is_host_path=True, task_id=task_id
        )
        assert result["ok"] is True
        assert result["files_copied"] == 1

        task = _tasks[task_id]
        assert task["files_done"] == 1
        assert task["files_total"] == 1
        assert task["copied_bytes"] == task["total_bytes"]

        del _tasks[task_id]

    def test_cancellation_between_files(self):
        src_dir = os.path.join(self.tmpdir, "src")
        dst_dir = os.path.join(self.tmpdir, "dst")
        os.makedirs(src_dir)
        os.makedirs(dst_dir)

        for name in ["a.mkv", "b.mkv", "c.mkv"]:
            Path(os.path.join(src_dir, name)).write_text(f"data {name}")

        task_id = "test-cancel-001"
        _tasks[task_id] = {
            "status": "running",
            "cancelled": True,
            "copied_bytes": 0,
            "total_bytes": 0,
            "files_done": 0,
            "files_total": 0,
        }

        result = _copy_files_to_root(src_dir, dst_dir, is_host_path=True, task_id=task_id)
        assert result["ok"] is False
        assert "cancelado" in result["detail"]

        del _tasks[task_id]

    def test_copy_chunked_copies_file_content(self):
        src_dir = os.path.join(self.tmpdir, "src")
        dst_dir = os.path.join(self.tmpdir, "dst")
        os.makedirs(src_dir)
        os.makedirs(dst_dir)

        content = "x" * (1024 * 1024 + 42)  # 1 MB + 42 bytes to test chunking
        Path(os.path.join(src_dir, "big.mkv")).write_text(content)

        result = _copy_files_to_root(src_dir, dst_dir, is_host_path=True)
        assert result["ok"] is True
        assert result["files_copied"] == 1

        dst_file = os.path.join(dst_dir, "big.mkv")
        assert os.path.exists(dst_file)
        assert Path(dst_file).read_text() == content


# ── _VOLUME_MAP ─────────────────────────────────────────────────────────────

class TestVolumeMap:
    def test_map_order(self):
        """El mapeo de /downloads/incoming/ debe venir antes que /downloads/."""
        idx_incoming = next(i for i, (p, _) in enumerate(_VOLUME_MAP) if p == "/downloads/incoming/")
        idx_downloads = next(i for i, (p, _) in enumerate(_VOLUME_MAP) if p == "/downloads/")
        assert idx_incoming < idx_downloads, "El mapeo /downloads/incoming/ debe ir antes que /downloads/"


# ── Smart rename tests ──────────────────────────────────────────────────────

from copy_engine import copy_files_to_root


class TestCopyWithTargetName:
    def test_single_file_with_target_name(self, tmp_path):
        src_dir = tmp_path / "source"
        src_dir.mkdir()
        src_file = src_dir / "old-name.mkv"
        src_file.write_bytes(b"fake video content")

        dst_dir = tmp_path / "dest"
        dst_dir.mkdir()

        result = copy_files_to_root(
            str(src_file), str(dst_dir), is_host_path=True, target_name="New.Name.S01E01.mkv"
        )
        assert result["ok"] is True
        assert result["files_copied"] == 1
        assert (dst_dir / "New.Name.S01E01.mkv").exists()
        assert not (dst_dir / "old-name.mkv").exists()

    def test_single_file_without_target_name(self, tmp_path):
        src_dir = tmp_path / "source"
        src_dir.mkdir()
        src_file = src_dir / "original.mkv"
        src_file.write_bytes(b"fake video content")

        dst_dir = tmp_path / "dest"
        dst_dir.mkdir()

        result = copy_files_to_root(
            str(src_file), str(dst_dir), is_host_path=True
        )
        assert result["ok"] is True
        assert (dst_dir / "original.mkv").exists()

    def test_directory_copy_ignores_target_name(self, tmp_path):
        src_dir = tmp_path / "source"
        src_dir.mkdir()
        (src_dir / "file1.mkv").write_bytes(b"content1")
        (src_dir / "file2.mkv").write_bytes(b"content2")

        dst_dir = tmp_path / "dest"
        dst_dir.mkdir()

        result = copy_files_to_root(
            str(src_dir), str(dst_dir), is_host_path=True, target_name="should-be-ignored.mkv"
        )
        assert result["ok"] is True
        assert result["files_copied"] == 2
        assert (dst_dir / "file1.mkv").exists()
        assert (dst_dir / "file2.mkv").exists()


# ── API endpoint tests ────────────────────────────────────────────────────────

from fastapi.testclient import TestClient
from app import app

client = TestClient(app, raise_server_exceptions=False)


class TestHealthEndpoint:
    def test_health_returns_ok(self):
        resp = client.get("/api/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


class TestConfigEndpoint:
    def test_config_developer_default(self):
        resp = client.get("/api/config")
        assert resp.status_code == 200
        data = resp.json()
        assert "developer" in data


class TestActionsEndpoint:
    def test_list_actions(self):
        resp = client.get("/api/actions")
        assert resp.status_code == 200
        data = resp.json()
        assert "actions" in data
        assert "safe_mode" in data
        assert isinstance(data["actions"], list)
        assert len(data["actions"]) > 0

    def test_action_has_required_fields(self):
        resp = client.get("/api/actions")
        data = resp.json()
        for action in data["actions"]:
            assert "key" in action
            assert "label" in action
            assert "destructive" in action
            assert "scope" in action


class TestStatusEndpoint:
    def test_status_returns_cache(self):
        resp = client.get("/api/status")
        assert resp.status_code == 200
        data = resp.json()
        assert "radarr" in data
        assert "sonarr" in data
        assert "amutorrent" in data
        assert "flow" in data


class TestTasksEndpoint:
    def test_get_nonexistent_task(self):
        resp = client.get("/api/tasks/nonexistent-id")
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is False
        assert "no encontrada" in data["error"]

    def test_cancel_nonexistent_task(self):
        resp = client.post("/api/tasks/nonexistent-id/cancel")
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is False


class TestRunActionValidation:
    def test_unknown_action(self):
        resp = client.post(
            "/api/actions/unknown_action",
            json={"source": "radarr"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is False
        assert "desconocida" in data["error"]


class TestSpaFallback:
    def test_root_returns_index(self):
        resp = client.get("/")
        assert resp.status_code == 200

    def test_api_unknown_returns_not_found(self):
        resp = client.get("/api/nonexistent")
        assert resp.status_code == 200
        data = resp.json()
        assert data["detail"] == "Not Found"

    def test_prototypes_unknown_returns_not_found(self):
        resp = client.get("/prototypes/nonexistent")
        assert resp.status_code in (200, 404)
