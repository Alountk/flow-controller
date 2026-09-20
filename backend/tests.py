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
from copy_engine import copy_files_to_root as _copy_files_to_root, copy_tasks, CopyCancelled


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
        copy_tasks.create(task_id,
            status="running",
            copied_bytes=0,
            total_bytes=0,
            files_done=0,
            files_total=0,
        )

        result = _copy_files_to_root(src_dir, dst_dir, is_host_path=True, task_id=task_id)
        assert result["ok"] is True
        assert result["files_copied"] == 3

        task = copy_tasks.get(task_id)
        assert task["status"] == "running"
        assert task["files_done"] == 3
        assert task["files_total"] == 3
        assert task["total_bytes"] > 0
        assert task["copied_bytes"] == task["total_bytes"]

        del copy_tasks._tasks[task_id]

    def test_copy_single_file_with_task_id(self):
        src_dir = os.path.join(self.tmpdir, "src")
        dst_dir = os.path.join(self.tmpdir, "dst")
        os.makedirs(src_dir)
        os.makedirs(dst_dir)
        Path(os.path.join(src_dir, "movie.mkv")).write_text("fake video data")

        task_id = "test-task-002"
        copy_tasks.create(task_id,
            status="running",
            copied_bytes=0,
            total_bytes=0,
            files_done=0,
            files_total=0,
        )

        result = _copy_files_to_root(
            os.path.join(src_dir, "movie.mkv"), dst_dir, is_host_path=True, task_id=task_id
        )
        assert result["ok"] is True
        assert result["files_copied"] == 1

        task = copy_tasks.get(task_id)
        assert task["files_done"] == 1
        assert task["files_total"] == 1
        assert task["copied_bytes"] == task["total_bytes"]

        del copy_tasks._tasks[task_id]

    def test_cancellation_between_files(self):
        src_dir = os.path.join(self.tmpdir, "src")
        dst_dir = os.path.join(self.tmpdir, "dst")
        os.makedirs(src_dir)
        os.makedirs(dst_dir)

        for name in ["a.mkv", "b.mkv", "c.mkv"]:
            Path(os.path.join(src_dir, name)).write_text(f"data {name}")

        task_id = "test-cancel-001"
        copy_tasks.create(task_id,
            status="running",
            cancelled=True,
            copied_bytes=0,
            total_bytes=0,
            files_done=0,
            files_total=0,
        )

        result = _copy_files_to_root(src_dir, dst_dir, is_host_path=True, task_id=task_id)
        assert result["ok"] is False
        assert "cancelado" in result["detail"]

        del copy_tasks._tasks[task_id]

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
from state import file_queue
import routes.files

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


# ── Calendar Endpoints ───────────────────────────────────────────────────────

from unittest.mock import patch, AsyncMock


class TestCalendarSearch:
    @patch("routes.calendar.arr_search_movie", new_callable=AsyncMock)
    def test_movie_search_calls_arr(self, mock_search):
        mock_search.return_value = {"ok": True, "detail": "Command queued"}
        resp = client.post(
            "/api/calendar/search",
            json={"source": "radarr", "type": "movie", "id": 42},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        mock_search.assert_called_once()

    @patch("routes.calendar.arr_search_episode", new_callable=AsyncMock)
    def test_episode_search_calls_arr(self, mock_search):
        mock_search.return_value = {"ok": True, "detail": "Command queued"}
        resp = client.post(
            "/api/calendar/search",
            json={"source": "sonarr", "type": "episode", "id": 99},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        mock_search.assert_called_once()

    def test_unknown_type_returns_error(self):
        resp = client.post(
            "/api/calendar/search",
            json={"source": "radarr", "type": "season", "id": 1},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is False
        assert "desconocido" in data["detail"]

    def test_unknown_source_returns_error(self):
        resp = client.post(
            "/api/calendar/search",
            json={"source": "jackett", "type": "movie", "id": 1},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is False
        assert "desconocido" in data["detail"]


class TestCalendarAdd:
    @patch("routes.calendar.arr_search_movie", new_callable=AsyncMock)
    @patch("routes.calendar.arr_add_movie", new_callable=AsyncMock)
    @patch("routes.calendar.arr_movie_exists", new_callable=AsyncMock)
    @patch("routes.calendar.arr_movie_lookup", new_callable=AsyncMock)
    @patch("routes.calendar.arr_root_folders", new_callable=AsyncMock)
    def test_add_movie_uses_real_root_folder(self, mock_folders, mock_lookup, mock_exists, mock_add, mock_search):
        mock_folders.return_value = ["/mnt/storage/Movies"]
        mock_lookup.return_value = {"tmdbId": 550, "title": "Test Movie", "year": 2024, "qualityProfileId": 1}
        mock_exists.return_value = None  # Not in library yet
        mock_add.return_value = {"ok": True, "id": 42, "detail": "OK"}
        mock_search.return_value = {"ok": True, "detail": "queued"}

        resp = client.post(
            "/api/calendar/add",
            json={"source": "radarr", "type": "movie", "title": "Test Movie", "year": 2024},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["id"] == 42
        # Verify root folder was fetched and used
        mock_folders.assert_called_once()
        # arr_add_movie(session, service, payload) — payload is 3rd arg
        payload = mock_add.call_args[0][2]
        assert payload["rootFolderPath"] == "/mnt/storage/Movies"
        assert payload["title"] == "Test Movie"
        assert payload["tmdbId"] == 550

    @patch("routes.calendar.arr_movie_lookup", new_callable=AsyncMock)
    @patch("routes.calendar.arr_root_folders", new_callable=AsyncMock)
    def test_add_movie_without_tmdb_returns_error(self, mock_folders, mock_lookup):
        mock_folders.return_value = ["/movies"]
        mock_lookup.return_value = {}  # Lookup failed

        resp = client.post(
            "/api/calendar/add",
            json={"source": "radarr", "type": "movie", "title": "Unknown Movie"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is False
        assert "No se encontró" in data["detail"]

    @patch("routes.calendar.arr_add_series", new_callable=AsyncMock)
    @patch("routes.calendar.arr_series_exists", new_callable=AsyncMock)
    @patch("routes.calendar.arr_series_lookup", new_callable=AsyncMock)
    @patch("routes.calendar.arr_root_folders", new_callable=AsyncMock)
    def test_add_series_uses_real_root_folder(self, mock_folders, mock_lookup, mock_exists, mock_add):
        mock_folders.return_value = ["/mnt/storage-6tb/Series"]
        mock_lookup.return_value = {"tvdbId": 12345, "title": "Test Show", "year": 2023, "seasonFolder": True, "qualityProfileId": 1}
        mock_exists.return_value = None  # Not in library yet
        mock_add.return_value = {"ok": True, "id": 7, "detail": "OK"}

        resp = client.post(
            "/api/calendar/add",
            json={"source": "sonarr", "type": "episode", "title": "Test Show", "year": 2023},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["id"] == 7
        payload = mock_add.call_args[0][2]
        assert payload["rootFolderPath"] == "/mnt/storage-6tb/Series"
        assert payload["tvdbId"] == 12345

    @patch("routes.calendar.arr_series_lookup", new_callable=AsyncMock)
    @patch("routes.calendar.arr_root_folders", new_callable=AsyncMock)
    def test_add_series_without_tvdb_returns_error(self, mock_folders, mock_lookup):
        mock_folders.return_value = ["/series"]
        mock_lookup.return_value = {}  # Lookup failed

        resp = client.post(
            "/api/calendar/add",
            json={"source": "sonarr", "type": "episode", "title": "Unknown Show"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is False
        assert "No se encontró" in data["detail"]

    @patch("routes.calendar.arr_search_movie", new_callable=AsyncMock)
    @patch("routes.calendar.arr_movie_exists", new_callable=AsyncMock)
    @patch("routes.calendar.arr_movie_lookup", new_callable=AsyncMock)
    @patch("routes.calendar.arr_root_folders", new_callable=AsyncMock)
    def test_add_movie_already_exists_searches_directly(self, mock_folders, mock_lookup, mock_exists, mock_search):
        mock_folders.return_value = ["/movies"]
        mock_lookup.return_value = {"tmdbId": 550, "title": "Fight Club", "year": 1999, "qualityProfileId": 1}
        mock_exists.return_value = 99  # Already in Radarr with ID 99
        mock_search.return_value = {"ok": True, "detail": "queued"}

        resp = client.post(
            "/api/calendar/add",
            json={"source": "radarr", "type": "movie", "title": "Fight Club"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["id"] == 99
        assert "ya está" in data["detail"]
        mock_search.assert_called_once()

    @patch("routes.calendar.arr_series_exists", new_callable=AsyncMock)
    @patch("routes.calendar.arr_series_lookup", new_callable=AsyncMock)
    @patch("routes.calendar.arr_root_folders", new_callable=AsyncMock)
    def test_add_series_already_exists_returns_info(self, mock_folders, mock_lookup, mock_exists):
        mock_folders.return_value = ["/series"]
        mock_lookup.return_value = {"tvdbId": 12345, "title": "Breaking Bad", "year": 2008, "seasonFolder": True, "qualityProfileId": 1}
        mock_exists.return_value = 55  # Already in Sonarr with ID 55

        resp = client.post(
            "/api/calendar/add",
            json={"source": "sonarr", "type": "episode", "title": "Breaking Bad"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["id"] == 55
        assert "ya está" in data["detail"]

    @patch("routes.calendar.arr_root_folders", new_callable=AsyncMock)
    def test_add_without_root_folders_returns_error(self, mock_folders):
        mock_folders.return_value = []

        resp = client.post(
            "/api/calendar/add",
            json={"source": "radarr", "type": "movie", "title": "No Root"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is False
        assert "carpetas raíz" in data["detail"]

    @patch("routes.calendar.arr_search_movie", new_callable=AsyncMock)
    @patch("routes.calendar.arr_add_movie", new_callable=AsyncMock)
    @patch("routes.calendar.arr_movie_exists", new_callable=AsyncMock)
    @patch("routes.calendar.arr_movie_lookup", new_callable=AsyncMock)
    @patch("routes.calendar.arr_root_folders", new_callable=AsyncMock)
    def test_add_movie_radarr_error_propagates(self, mock_folders, mock_lookup, mock_exists, mock_add, mock_search):
        mock_folders.return_value = ["/movies"]
        mock_lookup.return_value = {"tmdbId": 550, "title": "Fail Movie", "year": 2024, "qualityProfileId": 1}
        mock_exists.return_value = None
        mock_add.return_value = {"ok": False, "id": None, "detail": "HTTP 400: validation error"}

        resp = client.post(
            "/api/calendar/add",
            json={"source": "radarr", "type": "movie", "title": "Fail Movie"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is False
        assert "400" in data["detail"]
        mock_search.assert_not_called()

    def test_add_unknown_type_returns_error(self):
        # Root folders are fetched before type check, so mock it
        with patch("routes.calendar.arr_root_folders", new_callable=AsyncMock, return_value=["/movies"]):
            resp = client.post(
                "/api/calendar/add",
                json={"source": "radarr", "type": "season", "title": "X"},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["ok"] is False
            assert "desconocido" in data["detail"]


class TestCalendarReleases:
    @patch("routes.calendar.arr_fetch_releases", new_callable=AsyncMock)
    def test_movie_releases(self, mock_fetch):
        mock_fetch.return_value = {
            "releases": [{"guid": "g1", "title": "Rel1", "quality": "1080p", "size": 1_000_000_000, "indexer": "Torznab", "seeders": 10, "leechers": 2, "languages": ["English"]}],
            "detail": "1 releases",
        }
        resp = client.post(
            "/api/calendar/releases",
            json={"source": "radarr", "type": "movie", "id": 42},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["releases"]) == 1
        assert data["releases"][0]["guid"] == "g1"

    @patch("routes.calendar.arr_fetch_releases", new_callable=AsyncMock)
    def test_episode_releases(self, mock_fetch):
        mock_fetch.return_value = {"releases": [], "detail": "0 releases"}
        resp = client.post(
            "/api/calendar/releases",
            json={"source": "sonarr", "type": "episode", "id": 99},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["releases"] == []

    def test_unknown_type_returns_error(self):
        resp = client.post(
            "/api/calendar/releases",
            json={"source": "radarr", "type": "season", "id": 1},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["releases"] == []
        assert "desconocido" in data["detail"]


class TestCalendarGrab:
    @patch("routes.calendar.arr_grab_release", new_callable=AsyncMock)
    def test_grab_ok(self, mock_grab):
        mock_grab.return_value = {"ok": True, "detail": "Release encolado"}
        resp = client.post(
            "/api/calendar/grab",
            json={"source": "radarr", "guid": "some-guid-123"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        mock_grab.assert_called_once()

    @patch("routes.calendar.arr_grab_release", new_callable=AsyncMock)
    def test_grab_error(self, mock_grab):
        mock_grab.return_value = {"ok": False, "detail": "HTTP 404: not found"}
        resp = client.post(
            "/api/calendar/grab",
            json={"source": "radarr", "guid": "bad-guid"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is False


class TestCalendarIndexers:
    @patch("routes.calendar.arr_indexers", new_callable=AsyncMock)
    def test_indexers_returned(self, mock_idx):
        mock_idx.return_value = [
            {"id": 1, "name": "Torznab", "implementation": "Torznab", "enableSearch": True},
        ]
        resp = client.get("/api/calendar/indexers?source=radarr")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["indexers"]) == 1
        assert data["indexers"][0]["name"] == "Torznab"

    def test_unknown_source_returns_empty(self):
        resp = client.get("/api/calendar/indexers?source=jackett")
        assert resp.status_code == 200
        data = resp.json()
        assert data["indexers"] == []


class TestSonarrSeriesCommands:
    def test_arr_rescan_series(self):
        import asyncio
        from clients import arr_rescan_series
        with patch("clients.arr_command", new_callable=AsyncMock) as mock_cmd:
            mock_cmd.return_value = {"ok": True, "detail": "RescanSeries command queued"}
            res = asyncio.run(arr_rescan_series(None, {"url": "http://sonarr:8989", "api_key": "abc"}, 10))
            assert res["ok"] is True
            mock_cmd.assert_called_once_with(None, {"url": "http://sonarr:8989", "api_key": "abc"}, {"name": "RescanSeries", "seriesId": 10})

    def test_arr_refresh_series(self):
        import asyncio
        from clients import arr_refresh_series
        with patch("clients.arr_command", new_callable=AsyncMock) as mock_cmd:
            mock_cmd.return_value = {"ok": True, "detail": "RefreshSeries command queued"}
            res = asyncio.run(arr_refresh_series(None, {"url": "http://sonarr:8989", "api_key": "abc"}, 10))
            assert res["ok"] is True
            mock_cmd.assert_called_once_with(None, {"url": "http://sonarr:8989", "api_key": "abc"}, {"name": "RefreshSeries", "seriesId": 10})


class TestQueueAddSeries:
    def test_queue_add_with_series_id(self):
        resp = client.post(
            "/api/files/queue/add",
            json={
                "source": "move",
                "remote_path": "/mnt/storage/downloads/ep.mkv",
                "local_path": "/mnt/storage/Series/Show/ep.mkv",
                "host": "sonarr",
                "ids": {"series_id": 99},
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["op"]["series_id"] == 99
        assert data["op"]["arr_source"] == "sonarr"


class TestPaginatedWantedEndpoints:
    @patch("routes.wanted.fetch_all_movies_detailed", new_callable=AsyncMock)
    def test_all_movies_pagination_params(self, mock_fetch):
        mock_fetch.return_value = {"items": [{"id": 1, "title": "M1"}], "total": 100, "page": 2, "page_size": 10}
        resp = client.get("/api/wanted/all?page=2&page_size=10")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 100
        assert data["page"] == 2
        assert data["page_size"] == 10

    @patch("routes.wanted.fetch_all_series_detailed", new_callable=AsyncMock)
    def test_all_series_pagination_params(self, mock_fetch):
        mock_fetch.return_value = {"items": [{"id": 1, "title": "S1"}], "total": 50, "page": 1, "page_size": 25}
        resp = client.get("/api/wanted/series/all?page=1&page_size=25")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 50
        assert data["page"] == 1
        assert data["page_size"] == 25


class TestValidatePathContainerMapping:
    def test_validate_path_converts_data_to_mnt_storage(self):
        from routes.files import _validate_path
        path = _validate_path("/data/shared-media/movies/Test (2024)")
        assert path == "/mnt/storage/shared-media/movies/Test (2024)"

    def test_validate_path_converts_data_6tb_to_mnt_storage_6tb(self):
        from routes.files import _validate_path
        path = _validate_path("/data-6tb/shared-media/series/Test Show")
        assert path == "/mnt/storage-6tb/shared-media/series/Test Show"


class TestConsumeQueuePostMoveImport:
    @patch("import_service.arr_refresh_movie", new_callable=AsyncMock)
    @patch("import_service.arr_rescan_movie", new_callable=AsyncMock)
    @patch("import_service.arr_manual_import", new_callable=AsyncMock)
    def test_radarr_post_move_triggers_manual_import_and_rescan_and_refresh(
        self, mock_manual, mock_rescan, mock_refresh, tmp_path
    ):
        import asyncio
        import app
        mock_manual.return_value = {"ok": True, "detail": "Manual import OK"}
        mock_rescan.return_value = {"ok": True, "detail": "RescanMovie OK"}
        mock_refresh.return_value = {"ok": True, "detail": "RefreshMovie OK"}

        src = tmp_path / "src_movie.mkv"
        src.write_bytes(b"content")
        dst = tmp_path / "dst_movie.mkv"

        op = {
            "id": "test-radarr-1",
            "type": "move",
            "src": str(src),
            "dst": str(dst),
            "name": "src_movie.mkv",
            "status": "pending",
            "cancelled": False,
            "arr_source": "radarr",
            "movie_id": 42,
            "series_id": None,
        }
        file_queue.append(op)
        asyncio.run(routes.files._consume_queue())

        assert op["status"] == "done"
        assert op["import_status"] == "imported"
        mock_manual.assert_called_once()
        mock_rescan.assert_called_once()
        mock_refresh.assert_called_once()

    @patch("import_service.arr_refresh_series", new_callable=AsyncMock)
    @patch("import_service.arr_rescan_series", new_callable=AsyncMock)
    def test_sonarr_post_move_triggers_rescan_and_refresh(
        self, mock_rescan, mock_refresh, tmp_path
    ):
        import asyncio
        import app
        mock_rescan.return_value = {"ok": True, "detail": "RescanSeries OK"}
        mock_refresh.return_value = {"ok": True, "detail": "RefreshSeries OK"}

        src = tmp_path / "src_ep.mkv"
        src.write_bytes(b"content")
        dst = tmp_path / "dst_ep.mkv"

        op = {
            "id": "test-sonarr-1",
            "type": "move",
            "src": str(src),
            "dst": str(dst),
            "name": "src_ep.mkv",
            "status": "pending",
            "cancelled": False,
            "arr_source": "sonarr",
            "movie_id": None,
            "series_id": 88,
        }
        file_queue.append(op)
        asyncio.run(routes.files._consume_queue())

        assert op["status"] == "done"
        assert op["import_status"] == "imported"
        mock_rescan.assert_called_once()
        mock_refresh.assert_called_once()



