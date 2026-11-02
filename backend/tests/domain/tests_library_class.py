"""Library class (`domain.library_class`) — the label the V2 list wears.

Pure: what Radarr reports about the file plus the configured 3D folder in, one
class out. The vocabulary is the design's — `4K`, `3D`, `1080`, `otros`,
`sin archivo` — and the chips of the Películas V2 header count exactly these
buckets, so the buckets must be exclusive and cover everything.
"""

from __future__ import annotations

from domain import library_class

#: The purity check below reads source, so it must read THIS module's bytes.
from tests import BACKEND_ROOT  # noqa: E402

MODULE_PATH = BACKEND_ROOT / "domain" / "library_class.py"


def _class(quality: str, *, has_file: bool = True, path: str = "", path_3d: str = "") -> str:
    return library_class.library_class(
        has_file=has_file, quality=quality, path=path, path_3d=path_3d
    )


# ── The four classes the design names ────────────────────────────────────────


def test_a_2160p_file_is_the_4k_class():
    assert _class("Bluray-2160p") == "4K"
    assert _class("WEBDL-2160p") == "4K"


def test_a_1080p_file_is_the_1080_class():
    assert _class("WEBDL-1080p") == "1080"
    assert _class("Bluray-1080p") == "1080"


def test_a_720p_file_is_not_1080_it_is_otros():
    """The design's own mock: Godzilla Minus One (HDTV-720p) wears `Otros`."""
    assert _class("HDTV-720p") == "otros"


def test_a_missing_quality_is_otros():
    assert _class("") == "otros"


def test_a_file_under_the_3d_folder_is_3d_whatever_its_resolution():
    assert _class("Bluray-2160p", path="/mnt/3d/Movie (2016)", path_3d="/mnt/3d/") == "3D"
    assert _class("Bluray-1080p", path="/mnt/3d/Movie (2016)", path_3d="/mnt/3d") == "3D"


def test_the_3d_folder_only_matches_its_own_tree():
    """A sibling folder sharing the prefix is not inside it."""
    assert _class("Bluray-1080p", path="/mnt/3d-old/Movie (2016)", path_3d="/mnt/3d") == "1080"


def test_an_unconfigured_3d_folder_matches_nothing():
    assert _class("Bluray-2160p", path="/mnt/movies/Movie (2016)", path_3d="") == "4K"


# ── The fifth bucket: the one the V1 calls "Faltantes" ───────────────────────


def test_a_movie_without_a_file_is_sin_archivo():
    assert _class("", has_file=False) == "sin archivo"
    # No file outranks any quality Radarr still remembers from a deleted file:
    # the chip must answer "what is not here", never "what it once was".
    assert _class("Bluray-2160p", has_file=False) == "sin archivo"


# ── The buckets the chips count ──────────────────────────────────────────────


def test_counts_are_exclusive_and_add_up_to_the_catalogue():
    items = [
        {"has_file": True, "quality": "Bluray-2160p", "path": "/m/a"},
        {"has_file": True, "quality": "Bluray-2160p", "path": "/m/b"},
        {"has_file": True, "quality": "WEBDL-1080p", "path": "/3d/c"},
        {"has_file": True, "quality": "HDTV-720p", "path": "/m/d"},
        {"has_file": False, "quality": "", "path": "/m/e"},
    ]

    counts = library_class.class_counts(items, path_3d="/3d")

    assert counts == {
        "todos": 5,
        "sin archivo": 1,
        "4K": 2,
        "3D": 1,
        "1080": 0,
        "otros": 1,
    }
    assert sum(counts[c] for c in library_class.CLASSES) == counts["todos"]


def test_an_empty_catalogue_counts_zero_everywhere():
    counts = library_class.class_counts([], path_3d="")

    assert counts["todos"] == 0
    assert all(counts[c] == 0 for c in library_class.CLASSES)


def test_the_module_is_pure():
    """No imports of config, disk or the network: the caller passes the folder."""
    source = MODULE_PATH.read_text(encoding="utf-8")

    assert "import config" not in source
    assert "os." not in source
    assert "aiohttp" not in source
