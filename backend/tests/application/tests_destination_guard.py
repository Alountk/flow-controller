import asyncio

from application.use_cases import destination_guard
from domain import destination_fit

P4K, P3D = "/m/4k", "/m/3d"


def _probe(width, height):
    return lambda path: {"video_tracks": [{"width": width, "height": height}]}


def _check(src, dest, probe, library_root=None):
    return asyncio.run(
        destination_guard.check(str(src), dest, path_4k=P4K, path_3d=P3D, probe=probe, library_root=library_root)
    )


def test_a_2160_file_headed_to_the_library_is_flagged_with_the_4k_folder(tmp_path):
    video = tmp_path / "movie.mkv"
    video.write_bytes(b"x")
    found = _check(video, "/m/es/Movie", _probe(3840, 1600))
    assert found == {"file": "movie.mkv", "resolution": "2160", "destination": "/m/es/Movie", "suggested": P4K}


def test_a_1080_file_headed_to_the_4k_folder_suggests_the_library_root(tmp_path):
    video = tmp_path / "movie.mkv"
    video.write_bytes(b"x")

    async def library_root():
        return "/m/es/Movie"

    found = _check(video, P4K, _probe(1920, 800), library_root)
    assert found["suggested"] == "/m/es/Movie" and found["resolution"] == "1080"


def test_a_folder_is_judged_by_its_biggest_video(tmp_path):
    (tmp_path / "sample.mkv").write_bytes(b"x")
    (tmp_path / "movie.mkv").write_bytes(b"xxxx")
    seen = []
    _check(tmp_path, P4K, lambda path: seen.append(path) or {"resolution": "2160"})
    assert seen == [str(tmp_path / "movie.mkv")]


def test_a_fitting_file_passes(tmp_path):
    video = tmp_path / "movie.mkv"
    video.write_bytes(b"x")
    assert _check(video, P4K, _probe(3840, 2160)) is None
    assert _check(video, "/m/es/Movie", _probe(1920, 1080)) is None


def test_an_unreadable_file_never_blocks(tmp_path):
    video = tmp_path / "movie.mkv"
    video.write_bytes(b"x")

    def broken(path):
        raise OSError("ffprobe failed")

    assert _check(video, P4K, broken) is None
    assert _check(tmp_path / "missing.mkv", P4K, _probe(1920, 1080)) is None


def test_the_3d_folder_is_never_judged():
    assert destination_fit.misfit("2160", "3d") == ""
    assert destination_fit.role_of("/m/3d/x", P4K, P3D) == "3d"
    assert destination_fit.role_of("/m/4kids/x", P4K, P3D) == "library"
