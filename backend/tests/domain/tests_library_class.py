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
    """A name that states 720p is SD, not `otros`: the name IS a claim.

    `otros` is reserved for files that prove nothing at all (below), because
    "we do not know" and "we know it is small" are different answers.
    """
    assert _class("HDTV-720p") == "SD"
    assert _class("Bluray-1080p") == "1080"
    assert _class("DVD") == "SD"


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
        {"has_file": True, "quality": "", "path": "/m/f"},
        {"has_file": False, "quality": "", "path": "/m/e"},
    ]

    counts = library_class.class_counts(items, path_3d="/3d")

    assert counts == {
        "todos": 6,
        "sin archivo": 1,
        "4K": 2,
        "3D": 1,
        "1080": 0,
        "SD": 1,
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


# ── S1: the resolutions a row lights are what the DISK proves ────────────────


def _res(
    quality: str,
    *,
    has_file: bool = True,
    path: str = "/mnt/movies/Alien (1979)",
    path_4k: str = "/mnt/movies4k",
    path_3d: str = "/mnt/movies3d",
    copies_4k: tuple[str, ...] = (),
    copies_3d: tuple[str, ...] = (),
    file_name: str = "",
    folder_files: tuple[str, ...] = (),
) -> list[str]:
    return library_class.available_resolutions(
        has_file=has_file,
        quality=quality,
        path=path,
        path_4k=path_4k,
        path_3d=path_3d,
        copies_4k=copies_4k,
        copies_3d=copies_3d,
        file_name=file_name,
        folder_files=folder_files,
    )


def test_a_1080p_file_with_a_4k_copy_lights_both():
    """The bug: a movie lives in ONE folder, so its own path can never be inside
    the 4K root and the 3D root at once. The copies are the only proof."""
    assert _res(
        "WEBDL-1080p",
        folder_files=("Alien (1979) WEBDL-1080p.mkv",),
        copies_4k=("Alien (1979) [4K]",),
    ) == ["4K", "1080p"]


def test_a_3d_copy_adds_the_third_resolution():
    assert _res(
        "WEBDL-1080p",
        folder_files=("Alien (1979) WEBDL-1080p.mkv",),
        copies_4k=("Alien (1979) [4K]",),
        copies_3d=("Alien (1979) [3D]",),
    ) == ["4K", "3D", "1080p"]


def test_the_own_file_living_in_the_4k_root_lights_4k():
    assert _res("Bluray-2160p", path="/mnt/movies4k/Alien (1979)") == ["4K"]


def test_a_2160p_file_lights_4k_without_any_copy():
    assert _res("Bluray-2160p", folder_files=("Alien (1979) Bluray-2160p.mkv",)) == ["4K"]


def test_an_sd_file_stays_sd_until_a_copy_proves_more():
    assert _res("HDTV-720p", folder_files=("Alien (1979) HDTV-720p.mkv",)) == ["SD"]
    assert _res(
        "HDTV-720p",
        folder_files=("Alien (1979) HDTV-720p.mkv",),
        copies_3d=("Alien (1979) [3D]",),
    ) == ["3D", "SD"]


def test_a_movie_without_a_file_lights_nothing_even_with_copies():
    assert _res("", has_file=False, copies_4k=("Alien (1979) [4K]",)) == []


def test_the_quality_alone_lights_nothing_without_the_physical_file():
    """El `movieFile`/`quality` de Radarr NO decide el encendido (S1): the
    folder listing is the proof, and an unlisted folder proves nothing."""
    assert _res("WEBDL-1080p") == []


def test_a_sidecar_named_1080p_lights_nothing():
    """S1 says «el archivo»: a subtitle named after the rip proves no video."""
    assert _res(
        "Bluray-2160p",
        folder_files=("Alien (1979) Bluray-2160p.mkv", "Alien (1979) WEBDL-1080p.srt"),
    ) == ["4K"]


def test_an_unconfigured_root_proves_nothing():
    """Empty means "not configured", never "everything"."""
    assert _res(
        "WEBDL-1080p",
        folder_files=("Alien (1979) WEBDL-1080p.mkv",),
        path_4k="",
        path_3d="",
    ) == ["1080p"]


def test_an_unreadable_root_proves_nothing():
    """The route hands over an empty listing when the folder cannot be read."""
    assert _res(
        "WEBDL-1080p",
        folder_files=("Alien (1979) WEBDL-1080p.mkv",),
        copies_4k=(),
        copies_3d=(),
    ) == ["1080p"]


def test_the_order_is_the_chip_order():
    both = _res(
        "WEBDL-1080p",
        folder_files=("Alien (1979) WEBDL-1080p.mkv",),
        copies_4k=("Alien (1979)",),
        copies_3d=("Alien (1979)",),
    )
    assert both == ["4K", "3D", "1080p"]
    assert both == [r for r in library_class.RESOLUTIONS if r in both]


def test_a_copy_folder_is_recognised_by_the_movie_folder_prefix():
    """`Alien (1979) [4K]` is the movie's copy; `Aliens (1986)` is another movie."""
    own = {"folder_files": ("Alien (1979) WEBDL-1080p.mkv",)}
    assert _res("WEBDL-1080p", **own, copies_4k=("Aliens (1986)",)) == ["1080p"]
    assert _res("WEBDL-1080p", **own, copies_4k=("Alien (1979)",)) == ["4K", "1080p"]
    assert _res("WEBDL-1080p", **own, copies_4k=("Alien (1979) [IMAX]",)) == ["4K", "1080p"]


class TestTheProbeBeatsTheName:
    """El caso que reportó el usuario, literal.

    `/mnt/storage/movies/es/John Wick - Chapter 3 - Parabellum (2019)/… Bluray-720p
    - h265 AC3 - [ES+EN].mkv` — el nombre dice 720p y el frame es 1920×800 (bandas
    recortadas). Sale como SD porque se leía el nombre. Un probe midió el frame:
    esa medida manda.
    """

    def test_a_720p_name_over_a_1920_frame_is_1080(self):
        assert library_class.library_class(
            has_file=True,
            quality="Bluray-720p",
            resolution="1080",
            path="/mnt/storage/movies/es/John Wick 3 (2019)",
        ) == "1080"

    def test_without_a_probe_the_name_still_decides(self):
        # "Never probed" is not a measurement: the old behaviour stands.
        assert library_class.library_class(has_file=True, quality="Bluray-720p") == "SD"

    def test_a_1080p_name_over_a_720_frame_is_not_1080(self):
        # The lie goes both ways, and the probe wins both times.
        assert library_class.library_class(has_file=True, quality="Bluray-1080p", resolution="720") == "SD"

    def test_a_probed_2160_lights_4K_over_a_1080p_name(self):
        assert library_class.library_class(has_file=True, quality="Bluray-1080p", resolution="2160") == "4K"

    def test_the_row_lights_1080p_for_the_probed_file(self):
        libraries = library_class.available_resolutions(
            has_file=True,
            quality="Bluray-720p",
            resolution="1080",
            file_name="Wick (2019) Bluray-720p.mkv",
            folder_files=("Wick (2019) Bluray-720p.mkv",),
        )
        assert libraries == ["1080p"]

    def test_the_counts_follow_the_probe(self):
        counts = library_class.class_counts([
            {"has_file": True, "quality": "Bluray-720p", "resolution": "1080"},
            {"has_file": True, "quality": "Bluray-720p", "resolution": "720"},
        ])
        assert counts["1080"] == 1
        assert counts["SD"] == 1
        assert counts["otros"] == 0


# ── S2: the presented file is the 1080, or nothing ───────────────────────────


def _own(
    quality: str,
    *,
    has_file: bool = True,
    path: str = "/mnt/movies/Kubo (2016)",
    resolution: str = "",
    file_name: str = "",
    folder_files: tuple[str, ...] = (),
) -> str:
    return library_class.own_1080_file(
        has_file=has_file,
        quality=quality,
        path=path,
        resolution=resolution,
        file_name=file_name,
        folder_files=folder_files,
    )


def test_the_1080_file_is_presented_even_after_the_4k_was_adopted():
    """The reported bug: manualimport adopts the 4K as movieFile and the
    presented file stopped being the 1080 (S2: 1080-o-nada)."""
    assert _own(
        "Bluray-2160p",
        file_name="Kubo (2016) Bluray-2160p.mkv",
        folder_files=("Kubo (2016) Bluray-2160p.mkv", "Kubo (2016) WEBDL-1080p.mkv"),
    ) == "Kubo (2016) WEBDL-1080p.mkv"


def test_when_the_moviefile_is_the_1080_file_its_basename_is_presented():
    assert _own(
        "WEBDL-1080p",
        file_name="/mnt/movies/Kubo (2016)/Kubo (2016) WEBDL-1080p.mkv",
        folder_files=("Kubo (2016) WEBDL-1080p.mkv",),
    ) == "Kubo (2016) WEBDL-1080p.mkv"


def test_no_1080_video_presents_nothing():
    assert _own(
        "Bluray-2160p",
        file_name="Kubo (2016) Bluray-2160p.mkv",
        folder_files=("Kubo (2016) Bluray-2160p.mkv",),
    ) == ""


def test_a_1080p_sidecar_is_not_a_presented_file():
    assert _own(
        "Bluray-2160p",
        file_name="Kubo (2016) Bluray-2160p.mkv",
        folder_files=("Kubo (2016) Bluray-2160p.mkv", "Kubo (2016) WEBDL-1080p.srt", "Kubo (2016).nfo"),
    ) == ""


def test_a_movie_without_a_file_presents_nothing():
    assert _own("", has_file=False, folder_files=("Kubo (2016) WEBDL-1080p.mkv",)) == ""


def test_the_moviefile_wins_the_1080_slot_over_an_earlier_listing_entry():
    assert _own(
        "WEBDL-1080p",
        file_name="Kubo (2016) WEBDL-1080p.mkv",
        folder_files=("Kubo (2016) HDTV-1080p.mkv", "Kubo (2016) WEBDL-1080p.mkv"),
    ) == "Kubo (2016) WEBDL-1080p.mkv"


def test_the_probe_gives_the_1080_slot_to_a_720p_name():
    """The John Wick rule at presentation: the measure beats the name."""
    assert _own(
        "Bluray-720p",
        resolution="1080",
        file_name="Kubo (2016) Bluray-720p.mkv",
        folder_files=("Kubo (2016) Bluray-720p.mkv",),
    ) == "Kubo (2016) Bluray-720p.mkv"
