"""`domain.rename_plan` — names a rename may produce, and who travels along.

The rules the dialog depends on: which sibling files are sidecars of the video
(same base name AND a sidecar extension), and which user-typed names are even
allowed to become a path. Everything here is pure, so the dangerous part —
touching the disk — stays a thin, separately tested layer.
"""

import pytest

from domain import rename_plan


class TestBaseName:
    def test_strips_a_media_extension(self):
        assert rename_plan.base_name("Alien.1979.1080p.mkv") == "Alien.1979.1080p"

    def test_keeps_the_name_when_the_extension_is_not_media(self):
        assert rename_plan.base_name("notes.txt") == "notes.txt"

    def test_strips_the_extension_case_insensitively(self):
        assert rename_plan.base_name("Alien.MKV") == "Alien"


class TestSidecars:
    """S3: same base name and a sidecar extension, nothing else."""

    def test_takes_the_srt_the_nfo_and_the_thumb(self):
        video = "Alien.1979.1080p.mkv"
        siblings = [
            "Alien.1979.1080p.srt",
            "Alien.1979.1080p.nfo",
            "Alien.1979.1080p-thumb.jpg",
        ]
        assert sorted(rename_plan.sidecars(video, siblings)) == sorted(siblings)

    def test_takes_a_language_suffixed_subtitle(self):
        assert rename_plan.sidecars("Alien.1979.mkv", ["Alien.1979.es.srt"]) == [
            "Alien.1979.es.srt"
        ]

    def test_ignores_another_movie_in_the_same_folder(self):
        assert rename_plan.sidecars("Alien.1979.mkv", ["Aliens.1986.srt"]) == []

    def test_ignores_a_name_that_only_shares_a_prefix(self):
        # `Alien.1979.REMASTERED.mkv` is a different file, not a sidecar of
        # `Alien.1979.mkv` — the boundary is the dot or dash after the stem.
        assert rename_plan.sidecars("Alien.1979.mkv", ["Alien.1979.REMASTERED.mkv"]) == []

    def test_ignores_a_second_video_with_the_stem_as_prefix(self):
        assert rename_plan.sidecars("Alien.mkv", ["Alien.Extended.mkv"]) == []

    def test_ignores_an_extension_nobody_uses_as_a_sidecar(self):
        assert rename_plan.sidecars("Alien.1979.mkv", ["Alien.1979.json"]) == []

    def test_never_returns_the_video_itself(self):
        assert rename_plan.sidecars("Alien.1979.mkv", ["Alien.1979.mkv"]) == []


class TestValidFolderName:
    def test_accepts_a_radarr_folder_name(self):
        assert rename_plan.folder_name("The Batman (2022)") == "The Batman (2022)"

    def test_accepts_a_colon_free_name(self):
        assert rename_plan.folder_name("Dune - Part Two (2024)") == "Dune - Part Two (2024)"

    @pytest.mark.parametrize("bad", ["", "   ", ".", "..", "a/b", "a\\b", "a\x00b", "a\nb"])
    def test_rejects_a_name_that_would_escape_or_break(self, bad):
        assert rename_plan.folder_name(bad) is None

    def test_rejects_a_name_too_long_for_a_filesystem(self):
        assert rename_plan.folder_name("x" * 256) is None

    def test_rejects_a_leading_dot(self):
        # A dot-leading folder is a hidden folder: never what the dialog meant.
        assert rename_plan.folder_name(".hidden") is None

    def test_trims_surrounding_spaces(self):
        assert rename_plan.folder_name("  Dune (2021)  ") == "Dune (2021)"


class TestValidFileStem:
    def test_accepts_a_radarr_file_name(self):
        assert rename_plan.file_stem("The Batman (2022) - 2160p") == "The Batman (2022) - 2160p"

    def test_rejects_an_extension_inside_the_stem(self):
        assert rename_plan.file_stem("The Batman (2022).mkv") is None

    @pytest.mark.parametrize("bad", ["", "  ", ".", "..", "a/b", "a\\b", "a\x00b"])
    def test_rejects_a_name_that_would_escape_or_break(self, bad):
        assert rename_plan.file_stem(bad) is None

    def test_trims_surrounding_spaces(self):
        assert rename_plan.file_stem("  Dune (2021) - 2160p  ") == "Dune (2021) - 2160p"


class TestSidecarTarget:
    """The sidecar keeps the shape it had: `-thumb.jpg` and `.es.srt` survive."""

    def test_keeps_a_thumb_suffix(self):
        assert (
            rename_plan.sidecar_target("Alien.1979.mkv", "Alien.1979-thumb.jpg", "Alien (1979)")
            == "Alien (1979)-thumb.jpg"
        )

    def test_keeps_a_language_suffix(self):
        assert (
            rename_plan.sidecar_target("Alien.1979.mkv", "Alien.1979.es.srt", "Alien (1979)")
            == "Alien (1979).es.srt"
        )

    def test_takes_the_plain_extension(self):
        assert (
            rename_plan.sidecar_target("Alien.1979.mkv", "Alien.1979.nfo", "Alien (1979)")
            == "Alien (1979).nfo"
        )
