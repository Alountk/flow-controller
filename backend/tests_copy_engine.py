"""Tests for the copy engine's recursive folder copy.

A folder payload used to lose every subfolder: only the first level was copied
and it was flattened into the destination root. These tests pin the fixed
behaviour — full tree mirrored, relative structure preserved, no overwrites.
"""
from copy_engine import copy_files_to_root, copy_tasks


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
