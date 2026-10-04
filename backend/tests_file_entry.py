"""`_file_entry`'s `is_video`: what ONE entry proves about the file it is.

The frontend's has-file tags count a copy in a routing folder only when the
entry is a directory or a VIDEO file. The classification lives HERE, computed
from `naming.MEDIA_EXTENSIONS` — the repo's single definition of "this file is
a video" (promoted to public in #128 precisely so a second list cannot drift
and silently stop matching).

The bug this pins: Dune's `path_4k` held a `.srt` (and `.nfo` files) and
nothing else, and `holdsCopy` counted that subtitle as "we have the 4K".
"""

from routes.files import _file_entry


def test_a_video_file_is_classified_as_video(tmp_path):
    p = tmp_path / "Dune (2021) Bluray-2160p - x265 AC3 - [ES+EN].mkv"
    p.write_bytes(b"x")

    entry = _file_entry(p)

    assert entry["is_video"] is True
    assert entry["is_dir"] is False


def test_a_subtitle_is_not(tmp_path):
    """The Dune case: a subtitle beside (or instead of) the video proves
    nothing — it must not light the 4K tag."""
    p = tmp_path / "Dune (2021) Bluray-2160p - x265 AC3 - [ES+EN].srt"
    p.write_text("1\n00:00:01,000 --> 00:00:02,000\nHola\n")

    entry = _file_entry(p)

    assert entry["is_video"] is False
    assert entry["is_dir"] is False


def test_an_nfo_sidecar_is_not(tmp_path):
    p = tmp_path / "Dune (2021).nfo"
    p.write_text("<movie />")

    entry = _file_entry(p)

    assert entry["is_video"] is False
    assert entry["is_dir"] is False


def test_an_iso_disc_image_is_video(tmp_path):
    """`.iso` is the flat historical copy format too (and now part of the
    shared list): a disc image counts, a sidecar never does."""
    p = tmp_path / "Película (2020) 3D.iso"
    p.write_bytes(b"x")

    entry = _file_entry(p)

    assert entry["is_video"] is True


def test_a_directory_is_a_directory_and_not_a_video(tmp_path):
    """The nested layout's copy (`path_4k/<folder>/<file>`) is proved by
    `is_dir` alone: a directory is not a file, so `is_video` is False while
    `is_dir` stays True."""
    p = tmp_path / "Dune (2021)"
    p.mkdir()

    entry = _file_entry(p)

    assert entry["is_dir"] is True
    assert entry["is_video"] is False
