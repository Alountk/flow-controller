"""Tests for the pure part of naming a file Radarr cannot see itself.

No network: these build a value dict, evaluate a pattern, and assert. The
orchestration that fetches the pattern lives in `clients`/`copy_engine` and is
covered there; what is pinned here is the part that can silently write a wrong
name.
"""

from domain import media_info, naming
from domain.naming import build_values, clean_title, evaluate, reproduced_radarr


# ── What the tokens mean ──────────────────────────────────────────────────────


def test_the_default_pattern_evaluates():
    pattern = "{Movie Title} ({Release Year}) - {Quality Full}"
    values = build_values(title="Everything Everywhere", year=2022, quality="Bluray-2160p")

    assert evaluate(pattern, values) == "Everything Everywhere (2022) - Bluray-2160p"


def test_the_pattern_radarr_ships_by_default_also_evaluates():
    # The literal default in Radarr's own docs, `Movie Year` spelling and all.
    pattern = "{Movie Title} ({Movie Year}) - {Quality Full}"
    values = build_values(title="Película", year=2020, quality="WEBDL-2160p")

    assert evaluate(pattern, values) == "Película (2020) - WEBDL-2160p"


def test_a_bare_unknown_token_fails_closed():
    """A token we have never heard of is not a token we may drop.

    An empty `{Release Group}` is different: Radarr itself writes nothing there
    (or `Radarr`), so it renders empty and the self-check decides. This is the
    other kind — a name we do not understand — and it must stop the render.
    """
    values = build_values(title="Película", year=2020, quality="Bluray-2160p")

    assert evaluate("{Movie Title} - {Something Radarr Never Had}", values) is None


def test_media_info_tokens_render_empty_rather_than_refusing():
    """Radarr has no value either when the file is not probed, so the name is
    short — and `proposal` is what refuses to use it, because it knows whether
    it probed the copy."""
    values = build_values(title="Película", year=2020, quality="Bluray-2160p")

    assert evaluate("{Movie Title}.{Movie Year}.{MEDIAINFO VIDEOCODEC}", values) == "Película.2020."


def test_an_optional_group_is_dropped_when_it_has_no_data():
    """Radarr omits `[EDITION TAGS]` for a film with no edition, so omitting it
    here is reproducing it, not skipping it."""
    values = build_values(title="Película", year=2020, quality="Bluray-2160p")

    assert evaluate("{Movie Title} ({Release Year}){[Edition Tags]}", values) == (
        "Película (2020)"
    )


def test_an_optional_group_keeps_the_data_it_does_have():
    values = build_values(title="Película", year=2020, quality="Bluray-2160p")

    assert evaluate("{Movie Title} ({Release Year}){[Quality Full]}", values) == (
        "Película (2020)[Bluray-2160p]"
    )


def test_an_empty_title_fails_rather_than_naming_a_file_nothing():
    values = build_values(title="", year=2020, quality="Bluray-2160p")

    assert evaluate("{Movie Title} ({Release Year})", values) is None


def test_a_missing_year_fails_the_same_way():
    values = build_values(title="Película", year=None, quality="Bluray-2160p")

    assert evaluate("{Movie Title} ({Release Year})", values) is None


# ── The self-check ────────────────────────────────────────────────────────────


def test_the_self_check_passes_when_we_reproduce_radarr():
    pattern = "{Movie Title} ({Release Year}) - {Quality Full}"
    existing = build_values(title="Película", year=2020, quality="Bluray-1080p")
    # What Radarr itself named the file it already owns.
    actual = "Película (2020) - Bluray-1080p.mkv"

    assert reproduced_radarr(pattern, existing, actual) is True


def test_the_self_check_fails_when_we_do_not():
    pattern = "{Movie Title} ({Release Year}) - {Quality Full}"
    existing = build_values(title="Película", year=2020, quality="Bluray-1080p")
    # Radarr wrote something richer than we can reproduce.
    actual = "Película (2020) - [BLURAY-1080P][DTS 5.1][X264]-GROUP.mkv"

    assert reproduced_radarr(pattern, existing, actual) is False


def test_the_self_check_fails_when_the_pattern_itself_cannot_be_evaluated():
    assert reproduced_radarr(
        "{Movie Title} - {Release Group}",
        build_values(title="Película", year=2020, quality="Bluray-1080p"),
        "Película - GROUP.mkv",
    ) is False


def test_the_self_check_is_compared_on_the_file_name_not_the_folder():
    """`relativePath` may or may not carry a folder prefix depending on the
    deployment; the folder comes from Radarr's own `movie.path` anyway."""
    pattern = "{Movie Title} ({Release Year}) - {Quality Full}"
    existing = build_values(title="Película", year=2020, quality="Bluray-1080p")

    assert reproduced_radarr(
        pattern, existing, "Carpeta/Película (2020) - Bluray-1080p.mkv"
    ) is True


# ── clean_title ──────────────────────────────────────────────────────────────


def test_clean_title_drops_everything_radarr_drops():
    assert clean_title("L'Étranger: La Película!") == "letrangerlapelicula"


def test_the_self_check_also_agrees_when_radarr_kept_an_iso():
    """`.iso` counts as video (a disc image we have), so the extension is
    stripped from BOTH sides exactly as it is for `.mkv`: the gate compares
    the name, and Radarr appends the container itself."""
    pattern = "{Movie Title} ({Release Year}) - {Quality Full}"
    existing = build_values(title="Película", year=2020, quality="Bluray-1080p")

    assert reproduced_radarr(pattern, existing, "Película (2020) - Bluray-1080p.iso") is True


def test_the_self_check_still_fails_on_a_different_name_with_an_iso():
    """Stripping `.iso` must agree on the STEM, never on a different name:
    an extension-only shortcut would hand the pattern a pass it did not earn."""
    pattern = "{Movie Title} ({Release Year}) - {Quality Full}"
    existing = build_values(title="Película", year=2020, quality="Bluray-1080p")

    assert (
        reproduced_radarr(pattern, existing, "Otra Película (2020) - Bluray-1080p.iso") is False
    )


def test_a_proper_suffix_is_not_mistaken_for_an_extension():
    """`suffix` alone would call `.PROPER` an extension and chop it, turning a
    name Radarr would have written into a mismatch — and the feature off."""
    pattern = "{Movie Title} ({Release Year}) - {Quality Full}"
    existing = build_values(title="Película", year=2020, quality="Bluray-1080p.PROPER")

    assert reproduced_radarr(
        pattern, existing, "Película (2020) - Bluray-1080p.PROPER.mkv"
    ) is True


def test_a_pattern_that_writes_its_own_extension_still_matches():
    pattern = "{Movie Title} ({Release Year}) - {Quality Full}.mkv"
    existing = build_values(title="Película", year=2020, quality="Bluray-1080p")

    assert reproduced_radarr(
        pattern, existing, "Película (2020) - Bluray-1080p.mkv"
    ) is True


class TestMediaInfoTokens:
    """S1: the pattern Radarr writes with probed facts, rendered the same way."""

    PATTERN = (
        "{Movie Title} ({Release Year}) {Quality Full} "
        "{MediaInfo VideoDynamicRange} {MediaInfo AudioCodec} "
        "{MediaInfo AudioChannels} {Release Group}"
    )

    FACTS = {
        "video_codec": "x265",
        "video_bit_depth": "10",
        "video_dynamic_range": "HDR",
        "audio_codec": "DTS-HD MA",
        "audio_channels": "5.1",
        "audio_languages": "en/es",
        "simple": "x265 10bit HDR DTS-HD MA 5.1",
        "full": "x265 10bit HDR DTS-HD MA 5.1 en/es subtitles es/en",
        "release_group": "FraMeSToR",
    }

    def _values(self, **over):
        return naming.build_values(
            title="The Batman",
            year=2022,
            quality="Remux-2160p",
            media_info={**self.FACTS, **over},
        )

    def test_renders_the_name_radarr_would_write(self):
        assert naming.evaluate(self.PATTERN, self._values()) == (
            "The Batman (2022) Remux-2160p HDR DTS-HD MA 5.1 FraMeSToR"
        )

    def test_keeps_the_spelling_radarr_uses_for_each_token(self):
        rendered = naming.evaluate(
            "{MediaInfo VideoCodec} {MediaInfo VideoBitDepth} {MediaInfo Simple}", self._values()
        )

        assert rendered == "x265 10 x265 10bit HDR DTS-HD MA 5.1"

    def test_an_unprobed_file_leaves_the_measured_tokens_empty_and_lists_them(self):
        # `evaluate` alone cannot refuse: Radarr renders these tokens as nothing
        # for real files. `proposal` is the guard — it refuses a measured pattern
        # it could not probe — and this list is what it tells the person.
        values = naming.build_values(title="The Batman", year=2022, quality="Remux-2160p")

        assert naming.missing(self.PATTERN, values) == [
            "{MediaInfo VideoDynamicRange}",
            "{MediaInfo AudioCodec}",
            "{MediaInfo AudioChannels}",
            "{Release Group}",
        ], "every token that needs the file is named"

    def test_an_optional_media_token_degrades_instead_of_failing(self):
        values = naming.build_values(title="Dune", year=2021, quality="Bluray-2160p")

        assert naming.evaluate("{Movie Title} ({Release Year}){[MediaInfo VideoCodec]}", values) == (
            "Dune (2021)"
        )

    def test_a_group_the_name_does_not_declare_is_never_invented(self):
        values = self._values(release_group="")

        # Radarr would write `Radarr` here. We write nothing: the empty segment
        # makes the name differ from Radarr's, and the self-check refuses it.
        assert naming.evaluate("{Movie Title}-{Release Group}", values) == "The Batman-"


class TestTheRealTemplate:
    """S7: the templates Radarr has configured on the user's instance, verbatim.

    `{Quality Title}` is why this exists: it was not a token we knew, so the
    whole pattern refused to render — the name came out as "no proposal".
    """

    FILE = (
        "{Movie Title} ({Release Year}) {Quality Title} - "
        "{MediaInfo Simple} - {MediaInfo AudioLanguages}"
    )
    FOLDER = "{Movie Title} ({Release Year})"

    def test_a_4k_remux_copia_se_nombra_como_radarr(self):
        values = naming.build_values(
            title="The Batman",
            year=2022,
            quality="Remux-2160p",
            media_info={
                "video_codec": "x265",
                "video_bit_depth": "10",
                "video_dynamic_range": "HDR",
                "audio_codec": "DTS-HD MA",
                "audio_channels": "5.1",
                "audio_languages": "[EN+ES]",
            },
        )

        assert naming.evaluate(self.FILE, values) == (
            "The Batman (2022) Remux-2160p - x265 DTS-HD MA - [EN+ES]"
        )
        assert naming.evaluate(self.FOLDER, values) == "The Batman (2022)"
        assert naming.missing(self.FILE, values) == []

    def test_a_1080p_copy_keeps_its_quality_title(self):
        values = naming.build_values(
            title="Alien",
            year=1979,
            quality="Bluray-1080p",
            media_info={
                "video_codec": "x264",
                "video_bit_depth": "8",
                "video_dynamic_range": "SDR",
                "audio_codec": "AC3",
                "audio_channels": "5.1",
                "audio_languages": "",
            },
        )

        # Radarr writes nothing at all for an English-only track, and the name
        # simply ends one dash earlier.
        assert naming.evaluate(self.FILE, values) == "Alien (1979) Bluray-1080p - x264 AC3 - "

    def test_the_quality_token_spellings_radarr_offers_all_render_it(self):
        values = naming.build_values(title="Alien", year=1979, quality="Bluray-1080p")

        for spelling in ("{Quality}", "{Quality Full}", "{Quality Title}", "{Quality Name}"):
            assert naming.evaluate(spelling, values) == "Bluray-1080p", spelling


class TestTheNameRadarrActuallyWrote:
    """S7, end to end: a real name from the instance, reproduced from a probe.

    The instance writes `(2012) Bluray-1080p - h265 AC3 - [ES+EN+RU].mkv`, so a
    copy that is the same file must get that exact name back. This is the test
    that would have caught every one of the three mistakes before it: `x265`
    where Radarr writes `h265`, `en/es` where it writes `[ES+EN+RU]`, and a
    `{MediaInfo Simple}` with bit depth and channels that Radarr never puts
    there.
    """

    PATTERN = (
        "{Movie Title} ({Release Year}) {Quality Title} - "
        "{MediaInfo Simple} - {MediaInfo AudioLanguages}"
    )
    REAL_NAME = "Movie (2012) Bluray-1080p - h265 AC3 - [ES+EN+RU].mkv"

    PROBE = {
        "video_tracks": [
            {"codec": "hevc", "height": 1080, "pix_fmt": "yuv420p", "color_transfer": "bt709"}
        ],
        "audio_tracks": [
            {"codec": "ac3", "channels": 6, "channel_layout": "5.1(side)", "language": "spa"},
            {"codec": "ac3", "channels": 6, "channel_layout": "5.1(side)", "language": "eng"},
            {"codec": "ac3", "channels": 6, "channel_layout": "5.1(side)", "language": "rus"},
        ],
        "subtitle_tracks": [],
    }

    def _values(self):
        facts = media_info.from_probe(self.PROBE, self.REAL_NAME)
        quality = media_info.quality(self.REAL_NAME, "", "Bluray-1080p", self.PROBE)
        return naming.build_values(
            title="Movie", year=2012, quality=quality, media_info=facts
        )

    def test_writes_the_name_the_instance_writes(self):
        assert naming.evaluate(self.PATTERN, self._values()) == self.REAL_NAME.rsplit(".", 1)[0]

    def test_the_self_check_agrees_with_the_name_on_disk(self):
        assert naming.reproduced_radarr(
            self.PATTERN, self._values(), self.REAL_NAME
        ) is True

    def test_a_different_language_line_is_not_the_same_name(self):
        values = self._values()
        values["audio_languages"] = "[EN+ES+RU]"

        assert naming.reproduced_radarr(self.PATTERN, values, self.REAL_NAME) is False
