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

from app import _host_path, _resolve_current_path, _copy_files_to_root, _VOLUME_MAP


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


# ── _VOLUME_MAP ─────────────────────────────────────────────────────────────

class TestVolumeMap:
    def test_map_order(self):
        """El mapeo de /downloads/incoming/ debe venir antes que /downloads/."""
        idx_incoming = next(i for i, (p, _) in enumerate(_VOLUME_MAP) if p == "/downloads/incoming/")
        idx_downloads = next(i for i, (p, _) in enumerate(_VOLUME_MAP) if p == "/downloads/")
        assert idx_incoming < idx_downloads, "El mapeo /downloads/incoming/ debe ir antes que /downloads/"
