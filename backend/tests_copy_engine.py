"""Tests for the copy engine's recursive copy and hardlink behaviour.

These cover the two defects fixed in the T1/T2 slice: a folder payload used to
lose every subfolder, and every byte was copied even when a hardlink was free.

The S2 tests at the end cover the foreign destination: which root the engine
writes to, when it takes the item out of the arr's queue, and when it must stop
asking the arr to import.
"""
import asyncio
import errno
import os

import clients
import config
import copy_engine
from copy_engine import copy_files_to_root, copy_tasks, do_action, run_copy_background


class TestRecursiveStructurePreserved:
    def test_nested_subfolder_is_mirrored_not_flattened(self, tmp_path):
        src = tmp_path / "release"
        (src / "Sample").mkdir(parents=True)
        (src / "movie.mkv").write_bytes(b"movie bytes")
        (src / "Sample" / "sample.mkv").write_bytes(b"sample bytes")

        dst = tmp_path / "library"
        result = copy_files_to_root(str(src), str(dst), is_host_path=True)

        assert result["ok"] is True
        assert result["files_copied"] == 2
        assert (dst / "movie.mkv").exists()
        # The nested file must keep its subfolder, not land next to the movie.
        assert (dst / "Sample" / "sample.mkv").exists()
        assert not (dst / "sample.mkv").exists()

    def test_existing_destination_file_is_skipped_not_overwritten(self, tmp_path):
        src = tmp_path / "release"
        src.mkdir()
        (src / "movie.mkv").write_bytes(b"new content")

        dst = tmp_path / "library"
        dst.mkdir()
        (dst / "movie.mkv").write_bytes(b"sentinel content")

        result = copy_files_to_root(str(src), str(dst), is_host_path=True)

        assert result["ok"] is True
        assert (dst / "movie.mkv").read_bytes() == b"sentinel content"
        assert result["files_copied"] == 0
        assert "ya existían" in result["detail"]

    def test_progress_total_excludes_already_present_files(self, tmp_path):
        src = tmp_path / "release"
        src.mkdir()
        (src / "a.mkv").write_bytes(b"aaaa")
        (src / "b.mkv").write_bytes(b"bbbb")

        dst = tmp_path / "library"
        dst.mkdir()
        (dst / "a.mkv").write_bytes(b"existing")

        task_id = "test-copy-engine-progress"
        copy_tasks.create(task_id, status="running", copied_bytes=0, total_bytes=0, files_done=0, files_total=0)
        try:
            result = copy_files_to_root(str(src), str(dst), is_host_path=True, task_id=task_id)
            task = copy_tasks.get(task_id)
            assert result["files_copied"] == 1
            assert task["files_total"] == 1
            # Only b.mkv is copied; its 4 bytes are the whole total.
            assert task["copied_bytes"] == task["total_bytes"] == 4
        finally:
            del copy_tasks._tasks[task_id]


class TestHardlinkBeforeCopy:
    def test_same_filesystem_creates_a_hardlink(self, tmp_path):
        src = tmp_path / "release"
        src.mkdir()
        src_file = src / "movie.mkv"
        src_file.write_bytes(b"movie bytes")

        dst = tmp_path / "library"
        result = copy_files_to_root(str(src), str(dst), is_host_path=True)

        assert result["ok"] is True
        dst_file = dst / "movie.mkv"
        assert dst_file.exists()
        # Same inode and nlink 2 prove a link, not a plain copy.
        assert os.stat(dst_file).st_ino == os.stat(src_file).st_ino
        assert os.stat(dst_file).st_nlink == 2

    def test_exdev_falls_back_to_a_real_copy(self, tmp_path, monkeypatch):
        def _raise_exdev(src, dst):
            raise OSError(errno.EXDEV, "Invalid cross-device link")

        monkeypatch.setattr(os, "link", _raise_exdev)

        src = tmp_path / "release"
        src.mkdir()
        (src / "movie.mkv").write_bytes(b"movie bytes")

        dst = tmp_path / "library"
        result = copy_files_to_root(str(src), str(dst), is_host_path=True)

        assert result["ok"] is True
        src_file = src / "movie.mkv"
        dst_file = dst / "movie.mkv"
        assert dst_file.exists()
        assert dst_file.read_bytes() == b"movie bytes"
        assert src_file.exists()
        # The fallback copied bytes, so the inodes differ.
        assert os.stat(dst_file).st_ino != os.stat(src_file).st_ino


class TestSingleFileSmartName:
    def test_single_file_payload_keeps_target_name(self, tmp_path):
        src_file = tmp_path / "old.name.mkv"
        src_file.write_bytes(b"content")

        dst = tmp_path / "library"
        result = copy_files_to_root(
            str(src_file), str(dst), is_host_path=True, target_name="New.Name.S01E01.mkv"
        )

        assert result["ok"] is True
        assert (dst / "New.Name.S01E01.mkv").exists()
        assert not (dst / "old.name.mkv").exists()


# ── S2: the foreign destination ───────────────────────────────────────────────
#
# A copy into a folder the arr does not own must (a) land in that folder exactly
# as given, (b) take the item out of the arr's queue without deleting it from the
# client, and (c) NOT ask the arr to import, or it would catalogue the content
# into the library a second time.


def _arr_service(key="radarr", url="http://radarr.test:7878"):
    return {"key": key, "kind": "arr", "url": url, "api_key": "test-key"}


async def _noop_coro():
    return None


class TestRunCopyBackgroundImportToggle:
    def test_a_foreign_copy_ends_done_and_never_touches_the_arr(self, tmp_path, monkeypatch):
        src = tmp_path / "release"
        src.mkdir()
        (src / "movie.mkv").write_bytes(b"movie bytes")
        dst = tmp_path / "chosen"
        task_id = "s2-foreign-background"
        arr_calls: list[dict] = []
        verify_calls: list[str] = []

        async def fake_arr_command(session, service, body):
            arr_calls.append(body)
            return {"ok": True, "detail": "ok"}

        async def fake_verify_import(task_id_, service, source, ids):
            verify_calls.append(task_id_)

        monkeypatch.setattr(copy_engine, "arr_command", fake_arr_command)
        monkeypatch.setattr(copy_engine, "verify_import", fake_verify_import)

        copy_tasks.create(task_id, status="running", copied_bytes=0, total_bytes=0, files_done=0, files_total=0)
        try:
            asyncio.run(
                run_copy_background(
                    task_id, str(src), str(dst), _arr_service(), "radarr", {}, import_after_copy=False
                )
            )
            task = copy_tasks.get(task_id)
            assert task["status"] == "done"
            assert "carpeta elegida" in task["detail"]
            assert "el arr no lo tocará" in task["detail"]
            assert arr_calls == [], "a foreign copy must not force the arr to import"
            assert verify_calls == [], "a foreign copy must not poll the arr for an import"
        finally:
            del copy_tasks._tasks[task_id]

    def test_the_default_still_forces_the_arr_and_verifies(self, tmp_path, monkeypatch):
        src = tmp_path / "release"
        src.mkdir()
        (src / "movie.mkv").write_bytes(b"movie bytes")
        dst = tmp_path / "library"
        task_id = "s2-default-background"
        arr_calls: list[dict] = []
        verify_calls: list[str] = []

        async def fake_arr_command(session, service, body):
            arr_calls.append(body)
            return {"ok": True, "detail": "ok"}

        async def fake_verify_import(task_id_, service, source, ids):
            verify_calls.append(task_id_)

        monkeypatch.setattr(copy_engine, "arr_command", fake_arr_command)
        monkeypatch.setattr(copy_engine, "verify_import", fake_verify_import)

        copy_tasks.create(task_id, status="running", copied_bytes=0, total_bytes=0, files_done=0, files_total=0)
        try:
            asyncio.run(
                run_copy_background(task_id, str(src), str(dst), _arr_service(), "radarr", {})
            )
            task = copy_tasks.get(task_id)
            assert arr_calls == [{"name": "ProcessMonitoredDownloads"}]
            assert verify_calls == [task_id]
            assert task["status"] == "importing"
        finally:
            del copy_tasks._tasks[task_id]


def _foreign_payload(tmp_path, *, queue_id=42, dest_root=None):
    src = tmp_path / "release"
    src.mkdir(exist_ok=True)
    (src / "movie.mkv").write_bytes(b"movie bytes")
    ids = {"movie_id": 855}
    if queue_id is not None:
        ids["queue_id"] = queue_id
    return {
        "source": "radarr",
        "ids": ids,
        "output_path": str(src),
        "dest_root": str(dest_root if dest_root is not None else tmp_path / "chosen"),
    }


def _delete_recorder(calls, result):
    async def fake_delete(session, service, queue_id, blocklist, *, remove_from_client=True):
        calls.append(
            {"queue_id": queue_id, "blocklist": blocklist, "remove_from_client": remove_from_client}
        )
        return result

    return fake_delete


def _run_recorder(calls):
    def fake_run(*args, **kwargs):
        calls.append({"args": args, "kwargs": kwargs})
        return _noop_coro()

    return fake_run


class TestCopyFilesForeignDestination:
    def test_copies_to_the_foreign_root_and_removes_the_queue_without_deleting(
        self, tmp_path, monkeypatch
    ):
        payload = _foreign_payload(tmp_path)
        dest_root = tmp_path / "chosen"
        removals: list[dict] = []

        monkeypatch.setattr(copy_engine, "SERVICES", [_arr_service()])
        monkeypatch.setattr(config, "path_is_allowed", lambda path: True)
        monkeypatch.setattr(
            clients,
            "arr_delete_queue",
            _delete_recorder(removals, {"ok": True, "detail": "Item eliminado de la cola"}),
        )

        async def _scenario():
            result = await do_action(None, "copy_files", payload)
            for _ in range(100):
                task = copy_tasks.get(result["task_id"]) or {}
                if task.get("status") in ("done", "error", "cancelled"):
                    return result, task
                await asyncio.sleep(0.01)
            return result, copy_tasks.get(result["task_id"])

        result, task = asyncio.run(_scenario())

        assert result["ok"] is True
        assert removals == [
            {"queue_id": 42, "blocklist": False, "remove_from_client": False}
        ]
        assert task["status"] == "done"
        # The foreign root is used exactly: contents go straight to it, with no
        # `Season XX` subfolder, which only belongs to the library layout.
        assert (dest_root / "movie.mkv").read_bytes() == b"movie bytes"
        assert not (dest_root / "Season 1").exists()
        del copy_tasks._tasks[result["task_id"]]

    def test_proceeds_when_the_arr_is_not_tracking_the_item(self, tmp_path, monkeypatch):
        payload = _foreign_payload(tmp_path, queue_id=7)
        removals: list[dict] = []
        dispatches: list[dict] = []

        monkeypatch.setattr(copy_engine, "SERVICES", [_arr_service()])
        monkeypatch.setattr(config, "path_is_allowed", lambda path: True)
        monkeypatch.setattr(
            clients,
            "arr_delete_queue",
            _delete_recorder(removals, {"ok": False, "not_found": True, "detail": "HTTP 404"}),
        )
        monkeypatch.setattr(copy_engine, "run_copy_background", _run_recorder(dispatches))

        result = asyncio.run(do_action(None, "copy_files", payload))

        assert result["ok"] is True
        assert removals[0]["remove_from_client"] is False
        assert dispatches[0]["kwargs"]["import_after_copy"] is False
        del copy_tasks._tasks[result["task_id"]]

    def test_fails_closed_when_the_queue_removal_errors(self, tmp_path, monkeypatch):
        payload = _foreign_payload(tmp_path, queue_id=7)
        removals: list[dict] = []
        dispatches: list[dict] = []

        monkeypatch.setattr(copy_engine, "SERVICES", [_arr_service()])
        monkeypatch.setattr(config, "path_is_allowed", lambda path: True)
        monkeypatch.setattr(
            clients,
            "arr_delete_queue",
            _delete_recorder(removals, {"ok": False, "detail": "HTTP 500: boom"}),
        )
        monkeypatch.setattr(copy_engine, "run_copy_background", _run_recorder(dispatches))

        result = asyncio.run(do_action(None, "copy_files", payload))

        assert result["ok"] is False
        detail = result["steps"][0]["detail"]
        assert "no se pudo quitar de la cola del arr" in detail
        assert "HTTP 500" in detail
        assert dispatches == [], "a failed removal must not start a copy"
        assert "task_id" not in result

    def test_fails_closed_without_a_queue_id(self, tmp_path, monkeypatch):
        payload = _foreign_payload(tmp_path, queue_id=None)
        removals: list[dict] = []
        dispatches: list[dict] = []

        monkeypatch.setattr(copy_engine, "SERVICES", [_arr_service()])
        monkeypatch.setattr(config, "path_is_allowed", lambda path: True)
        monkeypatch.setattr(
            clients,
            "arr_delete_queue",
            _delete_recorder(removals, {"ok": True, "detail": "Item eliminado de la cola"}),
        )
        monkeypatch.setattr(copy_engine, "run_copy_background", _run_recorder(dispatches))

        result = asyncio.run(do_action(None, "copy_files", payload))

        assert result["ok"] is False
        assert "falta el id de la cola" in result["steps"][0]["detail"]
        assert removals == [], "without a queue id there is nothing to remove"
        assert dispatches == []
        assert "task_id" not in result

    def test_rejects_a_dest_root_outside_the_allowed_roots(self, tmp_path, monkeypatch):
        payload = _foreign_payload(tmp_path)
        removals: list[dict] = []
        dispatches: list[dict] = []

        monkeypatch.setattr(copy_engine, "SERVICES", [_arr_service()])
        monkeypatch.setattr(config, "path_is_allowed", lambda path: False)
        monkeypatch.setattr(
            clients,
            "arr_delete_queue",
            _delete_recorder(removals, {"ok": True, "detail": "Item eliminado de la cola"}),
        )
        monkeypatch.setattr(copy_engine, "run_copy_background", _run_recorder(dispatches))

        result = asyncio.run(do_action(None, "copy_files", payload))

        assert result["ok"] is False
        assert "destino no permitido" in result["steps"][0]["detail"]
        assert removals == [], "an invalid destination is rejected before touching the arr"
        assert dispatches == []
        assert "task_id" not in result

    def test_without_a_destination_it_still_uses_the_arr_root(self, tmp_path, monkeypatch):
        output = tmp_path / "release"
        output.mkdir()
        payload = {
            "source": "radarr",
            "ids": {"movie_id": 855},
            "output_path": str(output),
        }
        dispatches: list[dict] = []

        monkeypatch.setattr(copy_engine, "SERVICES", [_arr_service()])
        monkeypatch.setattr(copy_engine, "run_copy_background", _run_recorder(dispatches))

        async def fake_root(session, service, movie_id):
            return "/mnt/library/Movies"

        monkeypatch.setattr(copy_engine, "arr_movie_root_folder", fake_root)

        result = asyncio.run(do_action(None, "copy_files", payload))

        assert result["ok"] is True
        assert dispatches[0]["args"][2] == "/mnt/library/Movies"
        assert dispatches[0]["kwargs"]["import_after_copy"] is True
        assert result["dst_path"] == "/mnt/library/Movies/release"
        del copy_tasks._tasks[result["task_id"]]


# ── fix_path_mapping resolves the local path through the app's authority ──────
#
# The frontend used to send a hardcoded local_path of /downloads/incoming, so
# the mapping was /downloads/incoming → /downloads/incoming: a mapping that maps
# nothing, persisted in the arr while the import kept failing. The backend now
# owns the translation and refuses a mapping that would be a no-op.


class TestFixPathMappingResolution:
    def _run(self, monkeypatch, payload):
        added: list[dict] = []
        retries: list[dict] = []

        async def fake_paths(session, service):
            return []

        async def fake_add(session, service, host, remote_path, local_path):
            added.append({"host": host, "remote_path": remote_path, "local_path": local_path})
            return {"ok": True, "detail": "mapeo creado"}

        async def fake_command(session, service, body):
            retries.append(body)
            return {"ok": True, "detail": "ok"}

        monkeypatch.setattr(copy_engine, "SERVICES", [_arr_service()])
        monkeypatch.setattr(clients, "arr_remote_paths", fake_paths)
        monkeypatch.setattr(clients, "arr_add_remote_path", fake_add)
        monkeypatch.setattr(copy_engine, "arr_command", fake_command)

        result = asyncio.run(do_action(None, "fix_path_mapping", payload))
        return result, added, retries

    def test_amule_path_resolves_to_the_configured_host_folder(self, monkeypatch):
        payload = {
            "source": "radarr",
            "host": "amule-host",
            "remote_path": "/downloads/incoming",
        }
        result, added, _ = self._run(monkeypatch, payload)

        assert result["ok"] is True
        assert added[0]["local_path"] == config.FOLDER_DOWNLOAD_AMULE
        assert added[0]["local_path"] == "/mnt/storage-6tb/shared-downloads/amule"

    def test_data_prefix_still_resolves_to_the_storage_root(self, monkeypatch):
        payload = {
            "source": "radarr",
            "host": "arr-host",
            "remote_path": "/data/movies/Some.Movie",
        }
        result, added, _ = self._run(monkeypatch, payload)

        assert result["ok"] is True
        assert added[0]["local_path"] == "/mnt/storage/movies/Some.Movie"

    def test_unknown_path_does_not_write_a_self_mapping(self, monkeypatch):
        payload = {
            "source": "radarr",
            "host": "amule-host",
            "remote_path": "/opt/files/movie.mkv",
        }
        result, added, retries = self._run(monkeypatch, payload)

        assert result["ok"] is False
        assert added == [], "a self-mapping must never reach the arr"
        assert retries == [], "no import retry without a mapping to fix"
        detail = result["steps"][0]["detail"]
        assert "no hay una traducción conocida" in detail
        assert "/opt/files/movie.mkv" in detail

    def test_an_explicit_local_path_is_still_respected(self, monkeypatch):
        payload = {
            "source": "radarr",
            "host": "amule-host",
            "remote_path": "/downloads/incoming",
            "local_path": "/mnt/custom/amule",
        }
        result, added, _ = self._run(monkeypatch, payload)

        assert result["ok"] is True
        assert added[0]["local_path"] == "/mnt/custom/amule"


# ── copy_files translates the container path before the copy runs ─────────────
#
# An absolute container path (/downloads/incoming/...) is not a host path. It
# used to be used as-is, so the copy looked up a file that does not exist. The
# path is resolved once, and the copy worker — which runs with is_host_path=True
# — must receive the already-translated path.


class TestCopyFilesTranslatesContainerPath:
    def _dispatch(self, monkeypatch, output_path):
        dispatches: list[dict] = []
        monkeypatch.setattr(copy_engine, "SERVICES", [_arr_service()])
        monkeypatch.setattr(copy_engine, "run_copy_background", _run_recorder(dispatches))

        async def fake_root(session, service, movie_id):
            return "/mnt/library/Movies"

        monkeypatch.setattr(copy_engine, "arr_movie_root_folder", fake_root)
        payload = {
            "source": "radarr",
            "ids": {"movie_id": 855},
            "output_path": output_path,
        }
        result = asyncio.run(do_action(None, "copy_files", payload))
        return result, dispatches

    def test_absolute_container_path_is_translated(self, monkeypatch):
        result, dispatches = self._dispatch(
            monkeypatch,
            "/downloads/incoming/Wonder.Woman.(2017)/Wonder.Woman.(2017).mkv",
        )

        assert result["ok"] is True
        expected = "/mnt/storage-6tb/shared-downloads/amule/Wonder.Woman.(2017)/Wonder.Woman.(2017).mkv"
        assert dispatches[0]["args"][1] == expected
        assert result["src_path"] == expected
        del copy_tasks._tasks[result["task_id"]]

    def test_a_real_host_path_passes_through_untouched(self, tmp_path, monkeypatch):
        output = str(tmp_path / "release" / "movie.mkv")
        result, dispatches = self._dispatch(monkeypatch, output)

        assert result["ok"] is True
        assert dispatches[0]["args"][1] == output
        assert result["src_path"] == output
        del copy_tasks._tasks[result["task_id"]]
