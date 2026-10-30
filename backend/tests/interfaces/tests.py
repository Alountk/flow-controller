"""Tests para las funciones de path resolution y copy_files."""
import os
import shutil
import tempfile
from pathlib import Path

import aiohttp

# Configurar env vars antes de importar app
os.environ.setdefault("FOLDER_DOWNLOAD_AMULE", "/mnt/storage-6tb/shared-downloads/amule")
os.environ.setdefault("FOLDER_DOWNLOAD_TORRENT", "/mnt/storage/downloads/qbittorrent/completed")
os.environ.setdefault("RADARR_URL", "http://localhost:7878")
os.environ.setdefault("SONARR_URL", "http://localhost:8989")
os.environ.setdefault("AMUTORRENT_URL", "http://localhost:4000")

from traces import host_path as _host_path, resolve_current_path as _resolve_current_path
from config import _VOLUME_MAP
from infrastructure.arr_client import arr_indexers
from copy_engine import copy_files_to_root as _copy_files_to_root, copy_tasks


# ── _host_path ──────────────────────────────────────────────────────────────

class TestHostPath:
    def test_data_mapping(self):
        assert _host_path("/data/shared-media/movies") == "/mnt/storage/shared-media/movies"

    def test_data_6tb_mapping(self):
        assert _host_path("/data-6tb/shared-media/movies") == "/mnt/storage-6tb/shared-media/movies"

    def test_downloads_incoming_amule(self):
        assert _host_path("/downloads/incoming/") == "/mnt/storage-6tb/shared-downloads/amule/"

    def test_downloads_incoming_no_slash(self):
        # The old expectation here was the defect: without a trailing slash the
        # path fell through to the shorter /downloads/ prefix and became
        # /mnt/storage-6tb/shared-downloads/incoming. The exact container root
        # must map to its OWN replacement, .../amule — that is the path the
        # aMule download actually lives at on the host.
        assert _host_path("/downloads/incoming") == "/mnt/storage-6tb/shared-downloads/amule"

    def test_downloads_other(self):
        result = _host_path("/downloads/torrents/completed")
        assert result == "/mnt/storage-6tb/shared-downloads/torrents/completed"

    def test_unknown_path_unchanged(self):
        assert _host_path("/some/unknown/path") == "/some/unknown/path"

    def test_empty_string(self):
        assert _host_path("") == ""

    def test_every_prefix_maps_with_its_trailing_slash(self):
        for prefix, replacement in _VOLUME_MAP:
            assert _host_path(prefix) == replacement

    def test_every_exact_root_maps_without_its_trailing_slash(self):
        # The boundary defect affected every entry, not just aMule's. An exact
        # root (prefix minus "/") maps to the replacement minus "/".
        for prefix, replacement in _VOLUME_MAP:
            assert _host_path(prefix.rstrip("/")) == replacement.rstrip("/")

    def test_every_child_path_keeps_its_suffix(self):
        for prefix, replacement in _VOLUME_MAP:
            child = "Show/movie.mkv"
            assert _host_path(prefix + child) == replacement + child

    def test_exact_container_roots(self):
        # The named roots the boundary fix must handle, pinned explicitly.
        assert _host_path("/downloads/incoming") == "/mnt/storage-6tb/shared-downloads/amule"
        assert _host_path("/downloads") == "/mnt/storage-6tb/shared-downloads"
        assert _host_path("/data") == "/mnt/storage"
        assert _host_path("/data-6tb") == "/mnt/storage-6tb"

    def test_no_prefix_match_passes_through(self):
        # A real host path must not be rewritten: host_path is a no-op when
        # nothing in _VOLUME_MAP matches.
        assert _host_path("/mnt/storage-6tb/library/Show/movie.mkv") == (
            "/mnt/storage-6tb/library/Show/movie.mkv"
        )
        assert _host_path("/tmp/some/file.mkv") == "/tmp/some/file.mkv"


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
from interfaces.http import routes

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

    def test_a_valid_action_reaches_do_action(self):
        """A valid action must not 500.

        The handler imported `_http_session` from `state`, which never defined
        it — the global lives in the lifespan — so every valid action raised
        ImportError before reaching `do_action`. The suite stayed green because
        the only action posted here was an unknown one, which returns earlier.
        """
        with patch("interfaces.http.routes.actions.do_action", new_callable=AsyncMock) as action:
            action.return_value = {
                "ok": True,
                "steps": [{"target": "arr", "ok": True, "detail": "Comando encolado"}],
            }
            resp = client.post("/api/actions/retry_import", json={"source": "radarr"})

        assert resp.status_code == 200
        assert resp.json()["ok"] is True

        session, name, payload = action.await_args.args
        assert name == "retry_import"
        assert payload["source"] == "radarr"
        assert isinstance(session, aiohttp.ClientSession), (
            "do_action needs a live session: passing None turns every arr call "
            "into an AttributeError 500 instead of a classified failure"
        )


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

import asyncio
import threading
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

from application import gateways
from application.use_cases.grab_release import grab_tasks
from application.use_cases.release_search import release_tasks
from tests._stubs import post_grab_and_settle


@asynccontextmanager
async def _gated_worker_session(gate: threading.Event):
    """A session factory that holds the release-search worker BEFORE the arr.

    The TestClient's portal dies with each request, so a worker left running
    would be cancelled anyway — but it could still reach the arr inside the
    request. This gate makes that impossible: with the worker parked here,
    every call to the arr mock would have to come from the HANDLER itself,
    which is exactly the inline search C-10 removes.

    The wait is bounded (2 s) so the gate can never hang a test written
    against the old synchronous handler, which also opens a session.
    """
    for _ in range(200):
        if gate.is_set():
            break
        await asyncio.sleep(0.01)
    yield MagicMock()


class TestCalendarSearch:
    @patch("interfaces.http.routes.calendar.arr_search_movie", new_callable=AsyncMock)
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

    @patch("interfaces.http.routes.calendar.arr_search_episode", new_callable=AsyncMock)
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
    @patch("interfaces.http.routes.calendar.arr_search_movie", new_callable=AsyncMock)
    @patch("interfaces.http.routes.calendar.arr_add_movie", new_callable=AsyncMock)
    @patch("interfaces.http.routes.calendar.arr_movie_exists", new_callable=AsyncMock)
    @patch("interfaces.http.routes.calendar.arr_movie_lookup", new_callable=AsyncMock)
    @patch("interfaces.http.routes.calendar.arr_root_folders", new_callable=AsyncMock)
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

    @patch("interfaces.http.routes.calendar.arr_movie_lookup", new_callable=AsyncMock)
    @patch("interfaces.http.routes.calendar.arr_root_folders", new_callable=AsyncMock)
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

    @patch("interfaces.http.routes.calendar.arr_add_series", new_callable=AsyncMock)
    @patch("interfaces.http.routes.calendar.arr_series_exists", new_callable=AsyncMock)
    @patch("interfaces.http.routes.calendar.arr_series_lookup", new_callable=AsyncMock)
    @patch("interfaces.http.routes.calendar.arr_root_folders", new_callable=AsyncMock)
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

    @patch("interfaces.http.routes.calendar.arr_series_lookup", new_callable=AsyncMock)
    @patch("interfaces.http.routes.calendar.arr_root_folders", new_callable=AsyncMock)
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

    @patch("interfaces.http.routes.calendar.arr_search_movie", new_callable=AsyncMock)
    @patch("interfaces.http.routes.calendar.arr_movie_exists", new_callable=AsyncMock)
    @patch("interfaces.http.routes.calendar.arr_movie_lookup", new_callable=AsyncMock)
    @patch("interfaces.http.routes.calendar.arr_root_folders", new_callable=AsyncMock)
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

    @patch("interfaces.http.routes.calendar.arr_series_exists", new_callable=AsyncMock)
    @patch("interfaces.http.routes.calendar.arr_series_lookup", new_callable=AsyncMock)
    @patch("interfaces.http.routes.calendar.arr_root_folders", new_callable=AsyncMock)
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

    @patch("interfaces.http.routes.calendar.arr_root_folders", new_callable=AsyncMock)
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

    @patch("interfaces.http.routes.calendar.arr_search_movie", new_callable=AsyncMock)
    @patch("interfaces.http.routes.calendar.arr_add_movie", new_callable=AsyncMock)
    @patch("interfaces.http.routes.calendar.arr_movie_exists", new_callable=AsyncMock)
    @patch("interfaces.http.routes.calendar.arr_movie_lookup", new_callable=AsyncMock)
    @patch("interfaces.http.routes.calendar.arr_root_folders", new_callable=AsyncMock)
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
        with patch("interfaces.http.routes.calendar.arr_root_folders", new_callable=AsyncMock, return_value=["/movies"]):
            resp = client.post(
                "/api/calendar/add",
                json={"source": "radarr", "type": "season", "title": "X"},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["ok"] is False
            assert "desconocido" in data["detail"]


class TestCalendarReleases:
    """C-10 keeps its job machinery; S1 (calendario-directo) changes WHO the
    job asks: our own sources, never the arr.

    The synchronous version of this endpoint awaited Radarr × 20 indexers for
    91.6 s inside the request — longer than the proxy's ~60 s cut, so the
    client got a 504 before any release could come back (masked once by
    raising `proxy_read_timeout` to 250 s by hand in nginx). Now the POST
    answers with a task id, `GET /api/calendar/releases/{task_id}` serves the
    payload the old handler used to return, and the worker runs the fan-out
    over the project's direct sources (Torznab registry + aMule EC +
    Prowlarr) with the item's title as query — `arr_fetch_releases` is out of
    this path entirely (S1).
    """

    @staticmethod
    def _await_release(task_id: str, timeout: float = 2.0) -> dict:
        """Poll the release registry until the worker settles. The app's loop
        runs in the TestClient's portal thread, so the shared registry is the
        only surface this thread reads."""
        import time

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            task = release_tasks.get(task_id)
            if task and task.get("status") in ("done", "error"):
                return task
            time.sleep(0.01)
        raise AssertionError(
            f"release job {task_id} never settled: {release_tasks.get(task_id)}"
        )

    @patch("interfaces.http.routes.calendar.search_sources", new_callable=AsyncMock)
    def test_post_starts_a_job_over_our_own_sources(self, mock_sources):
        """T1/S1 — the POST still answers a task id immediately; the worker
        calls OUR fan-out once with the item's title, and its rows are what
        the status endpoint serves."""
        mock_sources.return_value = {
            "ok": True,
            "results": [{
                "source": "torznab",
                "indexer": "Mi Indexador",
                "name": "Blade Runner 1982 (1982) 1080p BluRay",
                "size": 12345,
                "seeders": 7,
                "guid": "https://t.example/1",
                "link": "magnet:?xt=urn:btih:aa",
            }],
            "skipped": [],
        }
        resp = client.post(
            "/api/calendar/releases",
            json={
                "source": "radarr",
                "type": "movie",
                "id": 42,
                "title": "Blade Runner 1982",
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["task_id"]
        assert data["status"] == "running"
        assert "releases" not in data
        task = self._await_release(data["task_id"])
        try:
            assert task["status"] == "done"
            assert mock_sources.await_count == 1
            assert mock_sources.await_args.args == ("Blade Runner 1982",)
            assert task["releases"] == [{
                "title": "Blade Runner 1982 (1982) 1080p BluRay",
                "guid": "https://t.example/1",
                "link": "magnet:?xt=urn:btih:aa",
                "size": 12345,
                "seeders": 7,
                "indexer": "Mi Indexador",
                "source": "torznab",
                "quality": "Bluray-1080p",
            }]
            assert task["detail"] == "1 releases"
        finally:
            release_tasks._tasks.pop(data["task_id"], None)

    @patch("interfaces.http.routes.calendar.search_sources", new_callable=AsyncMock)
    def test_episode_post_starts_a_job(self, mock_sources):
        """T1/S1 — `type: episode` rides the same direct fan-out."""
        mock_sources.return_value = {"ok": True, "results": [], "skipped": []}
        resp = client.post(
            "/api/calendar/releases",
            json={"source": "sonarr", "type": "episode", "id": 99, "title": "Via Láctea"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["task_id"]
        assert data["status"] == "running"
        task = self._await_release(data["task_id"])
        try:
            assert task["status"] == "done"
            assert mock_sources.await_args.args == ("Via Láctea",)
        finally:
            release_tasks._tasks.pop(data["task_id"], None)

    @patch("interfaces.http.routes.calendar.search_sources", new_callable=AsyncMock)
    def test_rows_carry_what_the_sources_said_and_invent_nothing(self, mock_sources):
        """S1: the mapping keeps every fact the source stated (title, guid,
        link, size, seeders when present, indexer/source) and NEVER invents
        the arr fields the direct sources don't have — no quality, languages,
        indexerId, leechers, protocol, releaseGroup or indexerFlags keys."""
        mock_sources.return_value = {
            "ok": True,
            "results": [
                {
                    "source": "amule",
                    "name": "Otra Pelicula (2020)",
                    "size": 9,
                    "guid": "0123456789abcdef0123456789abcdef",
                    "link": "ed2k://|file|x.mkv|9|0123456789abcdef0123456789abcdef|/",
                    "sources": 12,
                },
                {
                    "source": "prowlarr",
                    "name": "Tercer Titulo S01E02",
                    "size": 5,
                    "link": "magnet:?xt=urn:btih:bb",
                },
            ],
            "skipped": [{"source": "torznab", "reason": "sin indexadores habilitados"}],
        }
        resp = client.post(
            "/api/calendar/releases",
            json={"source": "sonarr", "type": "episode", "id": 7, "title": "Tercer Titulo"},
        )
        data = resp.json()
        task = self._await_release(data["task_id"])
        try:
            assert task["status"] == "done"
            first, second = task["releases"]
            assert set(first) == {"title", "guid", "link", "size", "indexer", "source"}
            assert first == {
                "title": "Otra Pelicula (2020)",
                "guid": "0123456789abcdef0123456789abcdef",
                "link": "ed2k://|file|x.mkv|9|0123456789abcdef0123456789abcdef|/",
                "size": 9,
                "indexer": "amule",
                "source": "amule",
            }
            assert set(second) == {"title", "guid", "link", "size", "indexer", "source"}
            assert second["title"] == "Tercer Titulo S01E02"
            assert second["link"] == "magnet:?xt=urn:btih:bb"
            # guid falls back to the link so the grab always has a target.
            assert second["guid"] == "magnet:?xt=urn:btih:bb"
            # An answered fan-out with skips stays a success whose detail is
            # honest about what it never saw.
            assert "fuentes omitidas" in task["detail"]
            assert "torznab: sin indexadores habilitados" in task["detail"]
        finally:
            release_tasks._tasks.pop(data["task_id"], None)

    @patch("interfaces.http.routes.calendar.search_sources", new_callable=AsyncMock)
    def test_rows_carry_quality_and_languages_the_title_declares(self, mock_sources):
        """S1 (filtros-directos): the settled row carries quality/languages
        derived from the tokens the source's own title declares."""
        mock_sources.return_value = {
            "ok": True,
            "results": [{
                "source": "torznab",
                "indexer": "Mi Indexador",
                "name": "Blade Runner 2049 (2017) SPANISH 1080p BluRay x264-GRP",
                "size": 54321,
                "seeders": 3,
                "guid": "https://t.example/2",
                "link": "magnet:?xt=urn:btih:cc",
            }],
            "skipped": [],
        }
        resp = client.post(
            "/api/calendar/releases",
            json={"source": "radarr", "type": "movie", "id": 42, "title": "Blade Runner 2049"},
        )
        data = resp.json()
        task = self._await_release(data["task_id"])
        try:
            assert task["status"] == "done"
            assert task["releases"] == [{
                "title": "Blade Runner 2049 (2017) SPANISH 1080p BluRay x264-GRP",
                "guid": "https://t.example/2",
                "link": "magnet:?xt=urn:btih:cc",
                "size": 54321,
                "seeders": 3,
                "indexer": "Mi Indexador",
                "source": "torznab",
                "quality": "Bluray-1080p",
                "languages": ["Spanish"],
            }]
        finally:
            release_tasks._tasks.pop(data["task_id"], None)

    @patch("interfaces.http.routes.calendar.search_sources", new_callable=AsyncMock)
    def test_every_source_failing_settles_the_job_as_an_error(self, mock_sources):
        """S1: when every source failed the job settles as ERROR carrying the
        fan-out's reasons — never done + empty releases, which would read as
        «sin resultados»."""
        reasons = (
            "todas las fuentes seleccionadas fallaron — "
            "amule: no está configurado; torznab: sin indexadores habilitados"
        )
        mock_sources.return_value = {
            "ok": False,
            "results": [],
            "skipped": [
                {"source": "amule", "reason": "no está configurado"},
                {"source": "torznab", "reason": "sin indexadores habilitados"},
            ],
            "detail": reasons,
        }
        resp = client.post(
            "/api/calendar/releases",
            json={"source": "radarr", "type": "movie", "id": 3, "title": "Dune 2021"},
        )
        data = resp.json()
        task = self._await_release(data["task_id"])
        try:
            assert task["status"] == "error"
            assert task["detail"] == reasons
            assert task["releases"] == []
        finally:
            release_tasks._tasks.pop(data["task_id"], None)

    def test_a_missing_title_refuses_synchronously_without_a_job(self):
        """S1: the query IS the item's title — without it there is no honest
        search, and validation keeps answering in the old synchronous shape:
        `releases: []` + detail, no task id."""
        resp = client.post(
            "/api/calendar/releases",
            json={"source": "radarr", "type": "movie", "id": 42},
        )
        data = resp.json()
        assert data["releases"] == []
        assert "Falta el título" in data["detail"]
        assert "task_id" not in data

    def test_release_status_endpoint_serves_the_task(self):
        """The collect endpoint answers in the `{"ok": True, **task}` shape
        `GET /api/tasks/{task_id}` already uses, with the old synchronous
        payload (`releases` + `detail`) inside the task once it settles."""
        task_id = "rel-status-001"
        release_tasks.create(
            task_id,
            status="done",
            detail="1 releases",
            releases=[{"guid": "g1", "title": "Rel1"}],
        )
        data = client.get(f"/api/calendar/releases/{task_id}").json()
        assert data["ok"] is True
        assert data["id"] == task_id
        assert data["status"] == "done"
        assert data["detail"] == "1 releases"
        assert data["releases"] == [{"guid": "g1", "title": "Rel1"}]
        release_tasks._tasks.pop(task_id, None)

    def test_release_status_unknown_task_uses_the_task_endpoint_shape(self):
        data = client.get("/api/calendar/releases/no-such-task").json()
        assert data == {"ok": False, "error": "tarea no encontrada"}

    def test_unknown_service_refuses_without_starting_a_job(self):
        """Validation still answers synchronously, exactly as before: no job
        id for a request that could never run."""
        resp = client.post(
            "/api/calendar/releases",
            json={"source": "pluto", "type": "movie", "id": 1},
        )
        data = resp.json()
        assert data["releases"] == []
        assert "Servicio desconocido" in data["detail"]
        assert "task_id" not in data

    def test_unknown_type_returns_error(self):
        resp = client.post(
            "/api/calendar/releases",
            json={"source": "radarr", "type": "season", "id": 1},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["releases"] == []
        assert "desconocido" in data["detail"]

    @patch("interfaces.http.routes.calendar.search_sources", new_callable=AsyncMock)
    def test_post_without_selection_passes_no_subset(self, mock_sources):
        """Absent fields keep today's fan-out: the fetcher forwards Nones."""
        mock_sources.return_value = {"ok": True, "results": [], "skipped": []}
        data = client.post(
            "/api/calendar/releases",
            json={"source": "radarr", "type": "movie", "id": 1, "title": "Nulo"},
        ).json()
        task = self._await_release(data["task_id"])
        try:
            assert task["status"] == "done"
            kwargs = mock_sources.await_args.kwargs
            assert kwargs["sources"] is None
            assert kwargs["indexer_ids"] is None
            assert kwargs["raw_counts"] is True
        finally:
            release_tasks._tasks.pop(data["task_id"], None)

    @patch("interfaces.http.routes.calendar.search_sources", new_callable=AsyncMock)
    def test_post_with_a_site_subset_threads_the_selection(self, mock_sources):
        """The checkbox selection reaches the fan-out verbatim (sites request)."""
        mock_sources.return_value = {"ok": True, "results": [], "skipped": []}
        data = client.post(
            "/api/calendar/releases",
            json={
                "source": "radarr",
                "type": "movie",
                "id": 1,
                "title": "Sub",
                "sources": ["amule"],
            },
        ).json()
        task = self._await_release(data["task_id"])
        try:
            assert task["status"] == "done"
            kwargs = mock_sources.await_args.kwargs
            assert kwargs["sources"] == ["amule"]
            assert kwargs["indexer_ids"] is None
        finally:
            release_tasks._tasks.pop(data["task_id"], None)

    @patch("interfaces.http.routes.calendar.search_sources", new_callable=AsyncMock)
    def test_post_with_a_registry_subset_threads_indexer_ids(self, mock_sources):
        """Checked registry rows travel as indexer_ids beside torznab."""
        mock_sources.return_value = {"ok": True, "results": [], "skipped": []}
        data = client.post(
            "/api/calendar/releases",
            json={
                "source": "radarr",
                "type": "episode",
                "id": 2,
                "title": "Ids",
                "sources": ["torznab", "amule"],
                "indexer_ids": [7, 9],
            },
        ).json()
        task = self._await_release(data["task_id"])
        try:
            assert task["status"] == "done"
            kwargs = mock_sources.await_args.kwargs
            assert kwargs["sources"] == ["torznab", "amule"]
            assert kwargs["indexer_ids"] == [7, 9]
        finally:
            release_tasks._tasks.pop(data["task_id"], None)

    @patch("interfaces.http.routes.calendar.search_sources", new_callable=AsyncMock)
    def test_post_refuses_an_empty_site_selection(self, mock_sources):
        """No sites checked never fans out: synchronous honest refusal."""
        resp = client.post(
            "/api/calendar/releases",
            json={
                "source": "radarr",
                "type": "movie",
                "id": 1,
                "title": "Nada",
                "sources": [],
            },
        )
        data = resp.json()
        assert data["releases"] == []
        assert data["detail"] == "Selecciona al menos un sitio para buscar"
        assert "task_id" not in data
        assert mock_sources.await_count == 0

    @patch("interfaces.http.routes.calendar.search_sources", new_callable=AsyncMock)
    def test_post_names_an_unknown_source_synchronously(self, mock_sources):
        """A typo in the selection is refused in the old shape, naming it."""
        resp = client.post(
            "/api/calendar/releases",
            json={
                "source": "radarr",
                "type": "movie",
                "id": 1,
                "title": "Typo",
                "sources": ["amulee"],
            },
        )
        data = resp.json()
        assert data["releases"] == []
        assert data["detail"] == "fuente desconocida: «amulee»"
        assert "task_id" not in data
        assert mock_sources.await_count == 0

    @patch("interfaces.http.routes.calendar.search_sources", new_callable=AsyncMock)
    def test_post_names_a_bad_indexer_id_synchronously(self, mock_sources):
        """A non-positive id never reaches the fan-out: 400 text, old shape."""
        resp = client.post(
            "/api/calendar/releases",
            json={
                "source": "radarr",
                "type": "movie",
                "id": 1,
                "title": "Bad id",
                "sources": ["torznab"],
                "indexer_ids": [0],
            },
        )
        data = resp.json()
        assert data["releases"] == []
        assert data["detail"] == "id de indexador no válido: «0»"
        assert "task_id" not in data
        assert mock_sources.await_count == 0

    @patch("interfaces.http.routes.calendar.search_sources", new_callable=AsyncMock)
    def test_detail_says_when_a_source_found_or_dropped_nothing(self, mock_sources):
        """The amule report: 0 raw vs raw-but-filtered are different truths."""
        mock_sources.return_value = {
            "ok": True,
            "results": [],
            "skipped": [],
            "raw_counts": {"torznab": 0, "amule": 0, "prowlarr": 4},
        }
        data = client.post(
            "/api/calendar/releases",
            json={"source": "radarr", "type": "movie", "id": 5, "title": "Hoyo"},
        ).json()
        task = self._await_release(data["task_id"])
        try:
            assert task["detail"] == (
                "0 releases — torznab: 0 resultados — amule: 0 resultados — "
                "prowlarr: 4 resultados sin coincidencias con la búsqueda"
            )
        finally:
            release_tasks._tasks.pop(data["task_id"], None)

    @patch("interfaces.http.routes.calendar.search_sources", new_callable=AsyncMock)
    def test_detail_stays_quiet_for_healthy_sources_and_skips(self, mock_sources):
        """No noise for a source that delivered; skips keep their own line."""
        mock_sources.return_value = {
            "ok": True,
            "results": [{
                "source": "torznab",
                "indexer": "Sitio",
                "name": "Película Grande 1080p",
                "size": 1,
                "guid": "g1",
                "link": "magnet:?xt=urn:btih:aa",
            }],
            "skipped": [{"source": "prowlarr", "reason": "no está configurado"}],
            "raw_counts": {"torznab": 2, "amule": 1},
        }
        data = client.post(
            "/api/calendar/releases",
            json={"source": "radarr", "type": "movie", "id": 6, "title": "Grande"},
        ).json()
        task = self._await_release(data["task_id"])
        try:
            assert task["detail"] == (
                "1 releases — amule: 1 resultado sin coincidencias con la búsqueda — "
                "fuentes omitidas: prowlarr: no está configurado"
            )
        finally:
            release_tasks._tasks.pop(data["task_id"], None)


class TestSearchSourceCounts:
    """raw_counts: pre-relevance tallies, only when the calendar asks."""

    @patch("interfaces.http.routes.indexers._source_task", new_callable=AsyncMock)
    def test_raw_counts_report_rows_before_the_relevance_filter(self, mock_task):
        # no pytest-asyncio in this repo: drive the coroutine explicitly.
        import asyncio

        from interfaces.http.routes.indexers import search_sources

        mock_task.return_value = {
            "rows": [{"source": "amule", "name": "zzz-no-token"}],
            "ok": True,
            "skipped": [],
        }
        counted = asyncio.run(
            search_sources("Zeta Grande", sources=["amule"], raw_counts=True)
        )
        plain = asyncio.run(search_sources("Zeta Grande", sources=["amule"]))
        assert counted["raw_counts"] == {"amule": 1}
        assert counted["results"] == []  # dropped by relevance, still counted
        assert "raw_counts" not in plain


class TestCalendarGrab:
    """async-grab — the POST starts a job; the grab runs in a worker.

    The synchronous version of this endpoint awaited the whole chain inline —
    the ED2K resolve alone measures 30-60 s against a proxy that cuts at ~60 s,
    so the request died as a 504 while the download was already on its way.
    Now the POST answers with a task id, `GET /api/calendar/grab/{task_id}`
    serves the payload the old handler used to return, and the gateways are
    only ever asked by the worker.
    """

    @patch("interfaces.http.routes.calendar.dispatch_direct", new_callable=AsyncMock)
    def test_post_starts_a_job_without_running_the_grab_inline(self, mock_dispatch):
        mock_dispatch.return_value = {"ok": True, "detail": "Release encolado"}
        gate = threading.Event()
        with patch(
            "interfaces.http.routes.calendar.http_session",
            lambda: _gated_worker_session(gate),
        ):
            resp = client.post(
                "/api/calendar/grab",
                json={"source": "radarr", "guid": "some-guid-123"},
            )
            assert resp.status_code == 200
            data = resp.json()
            # A task id NOW, status running, and no payload — where the old
            # handler would still be awaiting the arr.
            assert data["ok"] is True
            assert data["task_id"]
            assert data["status"] == "running"
            assert "direct" not in data
            # The worker is held at the session gate, so this call could only
            # have come from the HANDLER itself — the inline grab async-grab
            # removes.
            mock_dispatch.assert_not_awaited()
            task = grab_tasks.get(data["task_id"])
            assert task is not None
            assert task["status"] == "running"
            grab_tasks._tasks.pop(data["task_id"], None)
        gate.set()

    @patch("interfaces.http.routes.calendar.dispatch_direct", new_callable=AsyncMock)
    def test_grab_ok(self, mock_dispatch):
        mock_dispatch.return_value = {"ok": True, "detail": "Release encolado"}
        body = post_grab_and_settle({"source": "radarr", "guid": "some-guid-123"})
        assert body["ok"] is True
        assert body["status"] == "done"
        assert body["detail"] == "Release encolado"
        mock_dispatch.assert_awaited_once()

    @patch("interfaces.http.routes.calendar.dispatch_direct", new_callable=AsyncMock)
    def test_grab_error(self, mock_dispatch):
        mock_dispatch.return_value = {"ok": False, "detail": "HTTP 404: not found"}
        body = post_grab_and_settle({"source": "radarr", "guid": "bad-guid"})
        assert body["ok"] is False
        assert body["status"] == "done"
        assert body["detail"] == "HTTP 404: not found"

    def test_grab_status_endpoint_serves_the_task(self):
        """The collect endpoint answers in the `{"ok": True, **task}` shape
        `GET /api/tasks/{task_id}` already uses, with the payload the
        synchronous POST used to return inside the task once it settles."""
        task_id = "grab-status-001"
        grab_tasks.create(
            task_id,
            status="done",
            ok=True,
            detail="Release encolado",
            direct=False,
        )
        data = client.get(f"/api/calendar/grab/{task_id}").json()
        assert data["ok"] is True
        assert data["id"] == task_id
        assert data["status"] == "done"
        assert data["detail"] == "Release encolado"
        assert data["direct"] is False
        grab_tasks._tasks.pop(task_id, None)

    def test_grab_status_unknown_task_uses_the_task_endpoint_shape(self):
        data = client.get("/api/calendar/grab/no-such-task").json()
        assert data == {"ok": False, "error": "tarea no encontrada"}

    @patch("interfaces.http.routes.calendar.dispatch_direct", new_callable=AsyncMock)
    def test_unknown_service_refuses_without_starting_a_job(self, mock_dispatch):
        """Validation still answers synchronously, exactly as before: no job
        id for a request that could never run."""
        resp = client.post(
            "/api/calendar/grab",
            json={"source": "pluto", "guid": "g1"},
        )
        data = resp.json()
        assert data == {"ok": False, "detail": "servicio desconocido: pluto"}
        assert "task_id" not in data
        mock_dispatch.assert_not_awaited()

    @patch("interfaces.http.routes.calendar.dispatch_direct", new_callable=AsyncMock)
    def test_destination_not_allowed_refuses_without_starting_a_job(self, mock_dispatch):
        resp = client.post(
            "/api/calendar/grab",
            json={"source": "radarr", "guid": "g1", "destination": "/etc/not-allowed"},
        )
        data = resp.json()
        assert data == {"ok": False, "detail": "Destino no permitido: /etc/not-allowed"}
        assert "task_id" not in data
        mock_dispatch.assert_not_awaited()

    # ── T2 (calendario-directo S2-S4): the grab dispatches DIRECT, by shape ──
    #
    # The five RED tests of T2: `POST /api/calendar/grab` adds by the SHAPE of
    # the target exactly like `POST /api/indexers/download`, the category is
    # chosen by DESTINATION (S3), and no flow touches `arr_grab_release` (S2).
    # `arr_grab_release`/`arr_root_folders` are patched with `create=True`
    # because S2-S4 DELETES those seams from the worker: the patch keeps
    # "never called" assertable in both worlds.

    def test_a_library_grab_adds_to_qbit_under_the_arrs_watched_category(self, monkeypatch):
        """S2/S3: destination None (library) → the NATIVE qBittorrent add with
        the category the arr watches (`radarr` for source radarr — Radarr
        imports and organises as before). No `arr_grab_release` anywhere (S2),
        and the own-grab row is `direct=True` on every success (S2)."""
        monkeypatch.delenv("AMULE_EC_DIRECT", raising=False)
        link = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Some.Movie.2024"
        calls = []

        async def fake_qbit(session, url, category=None):
            calls.append({"url": url, "category": category})
            return {
                "ok": True,
                "detail": f"Descarga añadida en qBittorrent (stub), categoría {category}",
            }

        with patch.object(gateways, "qbit_add_download", fake_qbit), \
                patch(
                    "application.use_cases.grab_release.arr_grab_release",
                    new=AsyncMock(return_value={"ok": True, "detail": "encolado"}),
                    create=True,
                ) as arr, \
                patch("application.use_cases.grab_release.record_own_grab", new=MagicMock()) as record:
            body = post_grab_and_settle(
                {"source": "radarr", "guid": "g1", "link": link, "movieId": 855}
            )

        assert body["ok"] is True
        assert calls == [{"url": link, "category": "radarr"}]
        arr.assert_not_awaited(), "S2: el grab ya no pasa por el arr"
        assert record.call_args.kwargs["direct"] is True

    def test_an_explicit_destination_adds_under_the_direct_category(self, monkeypatch):
        """S3: an explicit destination leaves the library → category `flow`
        (our own client category; the arr neither sees nor imports it) and the
        success detail keeps the honesty suffix. `arr_root_folders` is not
        consulted anymore: nothing passes through the arr (S3)."""
        monkeypatch.delenv("AMULE_EC_DIRECT", raising=False)
        link = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Some.Movie.2024"
        calls = []

        async def fake_qbit(session, url, category=None):
            calls.append({"url": url, "category": category})
            return {
                "ok": True,
                "detail": f"Descarga añadida en qBittorrent (stub), categoría {category}",
            }

        with patch.object(gateways, "qbit_add_download", fake_qbit), \
                patch(
                    "application.use_cases.grab_release.arr_grab_release",
                    new=AsyncMock(return_value={"ok": True, "detail": "encolado"}),
                    create=True,
                ) as arr, \
                patch(
                    "application.use_cases.grab_release.arr_root_folders",
                    new=AsyncMock(return_value=["/mnt/storage/movies"]),
                    create=True,
                ) as roots, \
                patch("application.use_cases.grab_release.record_own_grab", new=MagicMock()) as record:
            body = post_grab_and_settle(
                {
                    "source": "radarr",
                    "guid": "g1",
                    "link": link,
                    "movieId": 855,
                    "destination": "/mnt/storage/movies/_manual",
                }
            )

        assert body["ok"] is True
        assert calls == [{"url": link, "category": "flow"}]
        assert "directa" in body["detail"], "S2: el detalle de éxito lo dice"
        assert body["direct"] is True
        arr.assert_not_awaited()
        roots.assert_not_awaited()
        assert record.call_args.kwargs["direct"] is True
        assert record.call_args.kwargs["destination"] == "/mnt/storage/movies/_manual"

    def test_an_ed2k_target_is_added_by_the_ec_seam_and_never_the_arr(self, monkeypatch):
        """S2: `ed2k://` dispatches to the direct EC add (AMULE_EC_DIRECT's
        default) — NO re-search, the row already carries the link — and the
        arr is never told."""
        monkeypatch.delenv("AMULE_EC_DIRECT", raising=False)
        link = (
            "ed2k://|file Your.Name.2016.1080p.BluRay.x264-GRP.mkv"
            "|8589934592|ABCDEF0123456789ABCDEF0123456789|/"
        )
        calls = []

        def fake_add(ed2k_link):
            calls.append(ed2k_link)

        with patch.object(gateways, "amule_add_ed2k", fake_add), \
                patch.object(gateways, "qbit_add_download", new=AsyncMock()) as qbit, \
                patch(
                    "application.use_cases.grab_release.arr_grab_release",
                    new=AsyncMock(return_value={"ok": True, "detail": "encolado"}),
                    create=True,
                ) as arr, \
                patch("application.use_cases.grab_release.record_own_grab", new=MagicMock()) as record:
            body = post_grab_and_settle(
                {"source": "radarr", "guid": link, "movieId": 855}
            )

        assert body["ok"] is True
        assert calls == [link]
        qbit.assert_not_awaited(), "el ed2k es dominio de aMule, nunca de qBittorrent"
        arr.assert_not_awaited()
        assert record.call_args.kwargs["direct"] is True

    def test_a_malformed_target_settles_an_honest_refusal(self):
        """The dispatch refuses what it cannot recognise and the refusal
        PROPAGATES as the settled {ok: False, detail} — the `_BAD_SCHEME`
        honesty of `POST /api/indexers/download`, byte for byte."""
        with patch(
            "application.use_cases.grab_release.arr_grab_release",
            new=AsyncMock(return_value={"ok": True, "detail": "encolado"}),
            create=True,
        ) as arr, \
                patch("application.use_cases.grab_release.record_own_grab", new=MagicMock()) as record:
            body = post_grab_and_settle(
                {"source": "radarr", "guid": "not-a-link", "movieId": 855}
            )

        assert body["status"] == "done", "una negativa del worker, no un job fallido"
        assert body["ok"] is False
        assert body["detail"] == (
            "link no válido: se espera ed2k://, magnet:, http(s) o un hash de aMule (32 hex)"
        )
        arr.assert_not_awaited()
        record.assert_not_called()


class TestCalendarIndexers:
    """The list must never claim "there are none" when it failed to ask.

    Before this contract, three layers flattened every failure into `[]`, so a
    timeout was indistinguishable from an unconfigured arr and the modal simply
    showed nothing. The failure has to reach the screen with its reason.
    """

    def _get(self, source: str = "radarr"):
        """Clears first so every test starts cold — but never after, so a test
        that wants to prove the cache works can still see it."""
        from interfaces.http.routes.calendar import _indexers_cache

        _indexers_cache.clear()
        return client.get(f"/api/calendar/indexers?source={source}")

    @patch("interfaces.http.routes.calendar.arr_indexers", new_callable=AsyncMock)
    def test_indexers_returned(self, mock_idx):
        mock_idx.return_value = {
            "indexers": [
                {"id": 1, "name": "Torznab", "implementation": "Torznab", "enableSearch": True},
            ]
        }
        data = self._get().json()
        assert len(data["indexers"]) == 1
        assert data["indexers"][0]["name"] == "Torznab"
        assert "error" not in data, "a successful answer must not carry an error"

    def test_an_unconfigured_source_says_so_instead_of_looking_empty(self):
        """Was `test_unknown_source_returns_empty`, which asserted the bug."""
        data = self._get("jackett").json()
        assert data["indexers"] == []
        assert data.get("error"), "an unknown source must explain itself"
        assert data.get("error_kind")

    @patch("interfaces.http.routes.calendar.arr_indexers", new_callable=AsyncMock)
    def test_a_failure_is_surfaced_not_flattened(self, mock_idx):
        mock_idx.return_value = {
            "indexers": [],
            "error_kind": "timeout",
            "error": "radarr: no respondio a tiempo",
        }
        data = self._get().json()
        assert data["indexers"] == []
        assert data["error_kind"] == "timeout"
        assert data["error"]

    @patch("interfaces.http.routes.calendar.arr_indexers", new_callable=AsyncMock)
    def test_the_list_is_cached_per_source_so_it_is_not_refetched(self, mock_idx):
        """The user's own words: asking once for Radarr must not ask again."""
        mock_idx.return_value = {"indexers": [{"id": 1, "name": "Torznab"}]}
        self._get()
        first = mock_idx.call_count
        client.get("/api/calendar/indexers?source=radarr")
        assert first == 1
        assert mock_idx.call_count == first, "the second open hit the network again"

        from interfaces.http.routes.calendar import _indexers_cache

        _indexers_cache.clear()

    @patch("interfaces.http.routes.calendar.arr_indexers", new_callable=AsyncMock)
    def test_a_failure_is_never_cached(self, mock_idx):
        """Caching a failure would keep the modal broken for the whole TTL."""
        from interfaces.http.routes.calendar import _indexers_cache

        _indexers_cache.clear()
        mock_idx.return_value = {"indexers": [], "error_kind": "unreachable", "error": "radarr: caido"}
        client.get("/api/calendar/indexers?source=radarr")
        assert _indexers_cache == {}, "a failure must not enter the cache"

        mock_idx.return_value = {"indexers": [{"id": 7, "name": "Torznab"}]}
        data = client.get("/api/calendar/indexers?source=radarr").json()
        assert data["indexers"], "the next call must re-ask and recover"
        _indexers_cache.clear()


class TestArrIndexersReportsWhyItFailed:
    """`arr_indexers` used to answer `[]` for every failure."""

    _SERVICE = {"key": "radarr", "url": "http://radarr:7878", "api_key": "k"}

    def test_a_timeout_is_reported_not_swallowed(self):
        import asyncio

        session = MagicMock()
        session.get.side_effect = asyncio.TimeoutError()
        result = asyncio.run(arr_indexers(session, self._SERVICE))
        assert result["indexers"] == []
        assert result["error_kind"] == "timeout"

    def test_a_rejected_api_key_is_reported_not_swallowed(self):
        import asyncio

        resp = MagicMock(status=401)
        resp.text = AsyncMock(return_value="Unauthorized")
        cm = MagicMock()
        cm.__aenter__ = AsyncMock(return_value=resp)
        cm.__aexit__ = AsyncMock(return_value=False)
        session = MagicMock()
        session.get.return_value = cm
        result = asyncio.run(arr_indexers(session, self._SERVICE))
        assert result["indexers"] == []
        assert result["error_kind"] == "auth"


class TestSonarrSeriesCommands:
    def test_arr_rescan_series(self):
        import asyncio
        from infrastructure.arr_client import arr_rescan_series
        with patch("infrastructure.arr_client.arr_command", new_callable=AsyncMock) as mock_cmd:
            mock_cmd.return_value = {"ok": True, "detail": "RescanSeries command queued"}
            res = asyncio.run(arr_rescan_series(None, {"url": "http://sonarr:8989", "api_key": "abc"}, 10))
            assert res["ok"] is True
            mock_cmd.assert_called_once_with(None, {"url": "http://sonarr:8989", "api_key": "abc"}, {"name": "RescanSeries", "seriesId": 10})

    def test_arr_refresh_series(self):
        import asyncio
        from infrastructure.arr_client import arr_refresh_series
        with patch("infrastructure.arr_client.arr_command", new_callable=AsyncMock) as mock_cmd:
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
    @patch("interfaces.http.routes.wanted.fetch_all_movies_detailed", new_callable=AsyncMock)
    def test_all_movies_pagination_params(self, mock_fetch):
        mock_fetch.return_value = {"items": [{"id": 1, "title": "M1"}], "total": 100, "page": 2, "page_size": 10}
        resp = client.get("/api/wanted/all?page=2&page_size=10")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 100
        assert data["page"] == 2
        assert data["page_size"] == 10

    @patch("interfaces.http.routes.wanted.fetch_all_series_detailed", new_callable=AsyncMock)
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
        from interfaces.http.routes.files import _validate_path
        path = _validate_path("/data/shared-media/movies/Test (2024)")
        assert path == "/mnt/storage/shared-media/movies/Test (2024)"

    def test_validate_path_converts_data_6tb_to_mnt_storage_6tb(self):
        from interfaces.http.routes.files import _validate_path
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





class TestConsumeQueuePlacesWithoutDestroying:
    """Placement must keep the source alive, and must not cost a copy.

    The scan flow used to enqueue a `move`, so `os.rename` took the download
    away from aMule/qBittorrent and the hardlink they were sharing disappeared
    with it. Placing a file therefore has to leave `src` in place — and when
    both ends sit on one filesystem, a hardlink does that for free, which also
    keeps the operation as instant as the rename it replaces.
    """

    def _queue(self, tmp_path: Path, op_type: str, dst: Path) -> tuple[dict, Path]:
        import asyncio

        src = tmp_path / "seed" / "Movie (2016).mkv"
        src.parent.mkdir(parents=True, exist_ok=True)
        src.write_bytes(b"payload")
        op = {
            "id": f"test-{op_type}-place",
            "type": op_type,
            "src": str(src),
            "dst": str(dst),
            "name": src.name,
            "status": "pending",
            "cancelled": False,
            "arr_source": "",
            "movie_id": None,
            "series_id": None,
        }
        file_queue.append(op)
        asyncio.run(routes.files._consume_queue())
        return op, src

    def test_a_copy_keeps_the_source_and_costs_no_extra_bytes(self, tmp_path):
        # Nested destination whose parent does not exist yet: the old `move`
        # branch created it, so placement must not lose that.
        dst = tmp_path / "library" / "Movie (2016)" / "Movie (2016).mkv"
        op, src = self._queue(tmp_path, "copy", dst)

        assert op["status"] == "done", op.get("detail")
        assert src.exists(), "the download must survive or the seed is gone"
        assert dst.exists()
        assert os.stat(src).st_ino == os.stat(dst).st_ino, (
            "same filesystem: a hardlink would have done this without copying a byte"
        )
        assert op["progress"] == 100
        assert op["total_bytes"] == len(b"payload")

    def test_replacing_a_destination_that_already_points_at_the_source(self, tmp_path):
        """A shared inode must never be opened for writing.

        If `dst` already IS a link to `src` (a re-run of the same placement),
        a plain copy opens it with "wb", truncates the inode the two names
        share and empties the source — destroying exactly what this flow exists
        to protect.
        """
        dst = tmp_path / "library" / "Movie (2016).mkv"
        dst.parent.mkdir(parents=True, exist_ok=True)
        _, src = self._queue(tmp_path, "copy", tmp_path / "library" / "first.mkv")
        os.link(src, dst)

        op, src = self._queue(tmp_path, "copy", dst)

        assert op["status"] == "done", op.get("detail")
        assert src.read_bytes() == b"payload", "the source was truncated to zero"
        assert os.stat(src).st_ino == os.stat(dst).st_ino


    def test_copying_a_folder_links_every_file_instead_of_duplicating(self, tmp_path):
        """A release folder is tens of GB: `copytree` must not fork them.

        Same device means one inode per file at both ends, so the seed keeps
        sharing and the disk does not grow. A cross-device copy still falls
        back to real bytes — that is the only case with no choice.
        """
        import asyncio

        src = tmp_path / "seed" / "release"
        (src / "Subs").mkdir(parents=True)
        (src / "release.mkv").write_bytes(b"video")
        (src / "Subs" / "es.srt").write_bytes(b"sub")
        dst = tmp_path / "library" / "release"

        op = {
            "id": "test-folder-link",
            "type": "copy",
            "src": str(src),
            "dst": str(dst),
            "name": src.name,
            "status": "pending",
            "cancelled": False,
            "arr_source": "",
            "movie_id": None,
            "series_id": None,
        }
        file_queue.append(op)
        asyncio.run(routes.files._consume_queue())

        assert op["status"] == "done", op.get("detail")
        assert src.exists(), "the folder must survive intact"
        for rel in ("release.mkv", "Subs/es.srt"):
            assert os.stat(src / rel).st_ino == os.stat(dst / rel).st_ino, f"{rel} was duplicated"


class TestSeedIsNeverBroken:
    """A torrent client shares a PATH, not an inode.

    Moving a file out of the download folder deletes the entry the client is
    sharing, and renaming it does the same even though the data stays intact
    — the seeder's path is gone either way. Placement is fine: a hardlink adds
    a name without removing anything.

    **Only the torrent folder is guarded.** aMule is deliberately not:

    - its downloads live on a *different mount* from the library
      (`/mnt/storage-6tb` vs `/mnt/storage`), so a hardlink between them is
      impossible — there was never a hardlink here to protect;
    - aMule has no seed ratio and no swarm obligation, and an ED2K is
      re-downloadable from the network, so a file there is disposable on a
      schedule rather than a fragile seed (see the retention feature).

    Torrent files are the ones that sit on the same mount as the library,
    where a hardlink works and where losing the path ends the seeding.
    """

    def _post(self, src: str, dst: str, op_type: str = "move"):
        return client.post(
            "/api/files/queue/add",
            json={"source": op_type, "remote_path": src, "local_path": dst},
        )

    def test_moving_a_file_out_of_the_torrent_folder_is_refused(self):
        from config import FOLDER_DOWNLOAD_TORRENT

        src = f"{FOLDER_DOWNLOAD_TORRENT}/Movie (2016)/Movie.mkv"
        resp = self._post(src, "/mnt/storage/movies/Movie (2016)/Movie.mkv")

        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is False
        assert "semilla" in data["detail"] or "hardlink" in data["detail"], data["detail"]
        from state import file_queue

        assert all(o["src"] != src for o in file_queue), (
            "a refused operation must never reach the queue"
        )

    def test_moving_an_aMule_file_is_allowed(self):
        """aMule downloads are on another mount and have no seed to protect.

        Hardlinks to the library are impossible from `/mnt/storage-6tb`, so
        the guard was refusing an operation it was never protecting anything
        with — and aMule files are disposable on a schedule anyway.
        """
        from config import FOLDER_DOWNLOAD_AMULE

        resp = self._post(
            f"{FOLDER_DOWNLOAD_AMULE}/Movie (2016)/Movie.mkv",
            "/mnt/storage/movies/Movie (2016)/Movie.mkv",
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["ok"] is True, (
            "an aMule file is not a seed: the guard must not refuse it"
        )

    def test_the_refusal_does_not_block_placing_a_copy_from_the_torrent_folder(self):
        from config import FOLDER_DOWNLOAD_TORRENT

        resp = self._post(
            f"{FOLDER_DOWNLOAD_TORRENT}/Movie (2016)/Movie.mkv",
            "/mnt/storage/movies/Movie (2016)/Movie.mkv",
            op_type="copy",
        )

        assert resp.json()["ok"] is True, "a copy keeps the source, so it is always allowed"

    def test_moving_a_library_file_still_moves(self):
        resp = self._post(
            "/mnt/storage/movies/Movie (2016)/Movie.mkv",
            "/mnt/storage/movies/_archive/Movie (2016)/Movie.mkv",
        )

        assert resp.json()["ok"] is True, "outside the download folders a move is harmless"

    def test_renaming_a_file_inside_the_torrent_folder_is_refused(self):
        from config import FOLDER_DOWNLOAD_TORRENT

        resp = client.post(
            "/api/files/rename",
            json={
                "remote_path": f"{FOLDER_DOWNLOAD_TORRENT}/release.mkv",
                "local_path": f"{FOLDER_DOWNLOAD_TORRENT}/release-fixed.mkv",
            },
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is False
        assert "semilla" in data["detail"] or "hardlink" in data["detail"], data["detail"]

    def test_the_unguarded_move_endpoint_is_gone(self):
        """`POST /api/files/move` had no guard and no caller.

        Under the seed rule an unguarded destructive path is not worth keeping
        alive "just in case": grep across the frontend found zero uses of it.
        """
        # `app.routes` holds `_IncludedRouter` objects with no `path`, so the
        # flattened OpenAPI document is the only reliable view of the surface.
        paths = set(app.openapi()["paths"])
        assert "/api/files/move" not in paths, "an unguarded destructive endpoint is back"
        assert "/api/files/rename" in paths, "renaming is still offered, just guarded"
