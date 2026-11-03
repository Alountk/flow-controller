"""What the disk says about a copy, in Radarr's own words.

The probes below are the shape `media_mixer.probe_file` returns, trimmed to the
fields this module reads: a real ffprobe on a 4K HEVC HDR remux with DTS-HD MA
looks like `REAL`.
"""

from domain import media_info

REAL = {
    "video_tracks": [
        {
            "codec": "hevc",
            "width": 3840,
            "height": 2160,
            "profile": "Main 10",
            "color_transfer": "smpte2084",
            "color_primaries": "bt2020",
            "pix_fmt": "yuv420p10le",
        }
    ],
    "audio_tracks": [
        {"codec": "dts", "profile": "DTS-HD MA", "channels": 6, "language": "eng"},
        {"codec": "ac3", "profile": "Dolby Digital", "channels": 6, "language": "spa"},
    ],
    "subtitle_tracks": [
        {"codec": "subrip", "language": "spa"},
        {"codec": "subrip", "language": "eng"},
    ],
}

SDR_1080 = {
    "video_tracks": [
        {"codec": "h264", "height": 1080, "pix_fmt": "yuv420p", "color_transfer": "bt709"}
    ],
    "audio_tracks": [{"codec": "eac3", "channels": 2, "language": "eng"}],
    "subtitle_tracks": [],
}


class TestValues:
    """Radarr's own source is the spec: `MediaInfoFormatter` + `FileNameBuilder`."""

    def test_reads_the_codec_the_way_radarr_spells_it(self):
        # FormatVideoCodec: `HEVC`/`x265`/`h265` come from the release name, and
        # the last one is the default when the name says nothing.
        assert media_info.video_codec(REAL) == "h265"
        assert media_info.video_codec(REAL, "Film.2022.2160p.x265-GRP.mkv") == "x265"
        assert media_info.video_codec(REAL, "Film.2022.2160p.HEVC-GRP.mkv") == "HEVC"
        assert media_info.video_codec(SDR_1080) == "h264"
        assert media_info.video_codec({"video_tracks": [{"codec": "av1"}]}) == "AV1"
        assert media_info.video_codec({"video_tracks": [{"codec": "mpeg2video"}]}) == "MPEG2"

    def test_reads_the_bit_depth_from_the_pixel_format(self):
        assert media_info.video_bit_depth(REAL) == "10"
        assert media_info.video_bit_depth(SDR_1080) == "8"

    def test_names_the_dynamic_range_with_radarrs_own_words(self):
        # FormatVideoDynamicRange answers "" for SDR: Radarr writes nothing.
        assert media_info.video_dynamic_range(REAL) == "HDR"
        assert media_info.video_dynamic_range(SDR_1080) == ""
        dv = {"video_tracks": [{"codec": "hevc", "profile": "Dolby Vision / SMPTE ST 2086"}]}
        assert media_info.video_dynamic_range(dv) == "HDR"
        assert media_info.video_dynamic_range_type(dv) == "DV"
        assert media_info.video_dynamic_range_type(REAL) == "HDR10"
        assert media_info.video_dynamic_range_type(SDR_1080) == "SDR"

    def test_keeps_the_dts_flavour_the_stream_declares(self):
        assert media_info.audio_codec(REAL) == "DTS-HD MA"
        assert media_info.audio_codec(SDR_1080) == "EAC3"
        assert media_info.audio_codec({"audio_tracks": [{"codec": "dts"}]}) == "DTS"

    def test_writes_channels_the_way_radarr_does(self):
        # One decimal, from channel positions when the stream has them.
        assert media_info.audio_channels(SDR_1080) == "2.0"
        assert media_info.audio_channels({"audio_tracks": [{"channels": 8}]}) == "8.0"
        positioned = {"audio_tracks": [{"channels": 6, "channel_layout": "5.1(side)"}]}
        assert media_info.audio_channels(positioned) == "5.1"

    def test_writes_languages_the_way_radarr_does(self):
        # `[ES+EN+RU]`: capitals, distinct, `+` joined, brackets around them.
        probe = {
            "audio_tracks": [
                {"language": "spa"}, {"language": "eng"}, {"language": "rus"},
                {"language": "spa"},
            ]
        }
        assert media_info.audio_languages(probe) == "[ES+EN+RU]"
        assert media_info.subtitle_languages(REAL) == "[ES+EN]"

    def test_an_english_only_track_says_nothing(self):
        # GetLanguagesToken drops a lone EN, so Radarr's name has no segment.
        assert media_info.audio_languages({"audio_tracks": [{"language": "eng"}]}) == ""
        assert media_info.subtitle_languages({"subtitle_tracks": [{"language": "eng"}]}) == "[EN]"

    def test_composes_the_short_and_full_lines_radarr_writes(self):
        # `Simple` is codec plus audio codec and nothing else; `Full` glues the
        # audio languages to the codec with no space.
        assert media_info.simple(REAL) == "h265 DTS-HD MA"
        assert media_info.full(REAL) == "h265 DTS-HD MA[EN+ES] [ES+EN]"
        assert media_info.simple(SDR_1080) == "h264 EAC3"

    def test_a_probe_with_no_streams_yields_nothing_rather_than_a_guess(self):
        empty: dict = {}

        assert media_info.video_codec(empty) == ""
        assert media_info.audio_codec(empty) == ""
        assert media_info.audio_channels(empty) == ""
        assert media_info.simple(empty) == ""
        assert media_info.resolution(empty) == ""

    def test_resolution_detects_4k_with_cropped_black_bars(self):
        # 3840x1606 is 2.39:1 cinemascope with black bars cropped away.
        # Height alone was 1606 < 1700, which made it look like 1080p.
        cropped_4k = {
            "video_tracks": [
                {"codec": "hevc", "width": 3840, "height": 1606, "pix_fmt": "yuv420p10le"}
            ]
        }
        assert media_info.resolution(cropped_4k) == "2160"

    def test_resolution_detects_4k_pillarbox(self):
        # 4:3 Academy ratio in 4K (e.g. Snyder Cut): 2880x2160.
        pillar_4k = {
            "video_tracks": [
                {"codec": "hevc", "width": 2880, "height": 2160, "pix_fmt": "yuv420p10le"}
            ]
        }
        assert media_info.resolution(pillar_4k) == "2160"

    def test_resolution_detects_1080p_with_cropped_black_bars(self):
        # 1920x800 is 2.40:1 cinemascope with black bars cropped.
        cropped_1080 = {
            "video_tracks": [
                {"codec": "h264", "width": 1920, "height": 800, "pix_fmt": "yuv420p"}
            ]
        }
        assert media_info.resolution(cropped_1080) == "1080"


class TestGroup:
    def test_reads_the_group_the_name_ends_with(self):
        name = "The.Batman.2022.2160p.UHD.BluRay.REMUX.HDR.HEVC.DTS-HD.MA.5.1-FraMeSToR.mkv"

        assert media_info.release_group(name) == "FraMeSToR"

    def test_refuses_to_call_a_release_token_a_group(self):
        assert media_info.release_group("Film.2022.2160p.WEB-DL.DDP5.1.H.264-NTb.mkv") == "NTb"
        assert media_info.release_group("Film.2022.2160p.DTS-HD.MA.5.1.mkv") == ""
        assert media_info.release_group("Film.2022.2160p.REMUX.mkv") == ""

    def test_says_nothing_when_the_name_has_no_group(self):
        assert media_info.release_group("The Batman (2022) Bluray-2160p.mkv") == ""
        assert media_info.release_group("Film.2022.2160p.mkv") == ""


class TestQuality:
    def test_the_disk_decides_the_resolution(self):
        # What the instance showed: Radarr stores the 1080p file, so its quality
        # says 1080p even though the copy is a 2160p remux.
        assert (
            media_info.quality(
                "The.Batman.2022.2160p.REMUX.mkv", "", "Bluray-1080p", REAL
            )
            == "Remux-2160p"
        )

    def test_keeps_the_source_the_name_declares(self):
        assert (
            media_info.quality("Film.2022.WEB-DL.mkv", "WEBDL-1080p", "", SDR_1080)
            == "WEBDL-1080p"
        )

    def test_falls_back_to_radarrs_source_when_the_name_declares_none(self):
        assert media_info.quality("Film.2022.mkv", "", "Bluray-2160p", REAL) == "Bluray-2160p"

    def test_an_unreadable_file_leaves_the_declared_quality_alone(self):
        assert media_info.quality("Film.mkv", "WEBDL-1080p", "", {}) == "WEBDL-1080p"


class TestTheCopyDecidesItsResolution:
    """S3: the source is declared, the resolution is measured.

    Taken from the user's report: a 2160p remux was proposed as `Remux-1080p`
    because Radarr holds that movie's 1080p file, and the resolution was read
    off the declared quality instead of off the picture.
    """

    UHD = {"video_tracks": [{"codec": "hevc", "height": 2160}], "audio_tracks": [], "subtitle_tracks": []}
    FHD = {"video_tracks": [{"codec": "h264", "height": 1080}], "audio_tracks": [], "subtitle_tracks": []}

    def _quality(self, name, probe, declared="", fallback="Bluray-1080p"):
        return media_info.quality(name, declared, fallback, probe)

    def test_a_remux_from_radarr_s_1080p_movie_is_2160p(self):
        got = self._quality(
            "The.Batman.2022.2160p.UHD.BluRay.REMUX.HDR.HEVC-FraMeSToR.mkv", self.UHD
        )

        assert got == "Remux-2160p"

    def test_a_cropped_4k_remux_without_resolution_in_name_is_2160p(self):
        # The user's exact case: a 4K copy where black bars were cropped (3840x1606)
        # and the filename has no "2160p" token: the probe's width must prove 4K.
        cropped = {
            "video_tracks": [{"codec": "hevc", "width": 3840, "height": 1606}],
            "audio_tracks": [],
            "subtitle_tracks": [],
        }
        got = self._quality("The.Batman.2022.REMUX-FraMeSToR.mkv", cropped, fallback="Bluray-1080p")

        assert got == "Remux-2160p"

    def test_quality_resolves_from_facts_dict(self):
        cropped = {
            "video_tracks": [{"codec": "hevc", "width": 3840, "height": 1606}],
            "audio_tracks": [],
            "subtitle_tracks": [],
        }
        facts = media_info.from_probe(cropped, "The.Batman.2022.REMUX.mkv")
        got = self._quality("The.Batman.2022.REMUX.mkv", facts, fallback="Bluray-1080p")

        assert got == "Remux-2160p"

    def test_web_dl_keeps_its_dash_out_of_the_way(self):
        got = self._quality("Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1-NTb.mkv", self.UHD)

        assert got == "WEBDL-2160p", "Radarr spells it without the dash"

    def test_a_1080p_copy_in_a_4k_root_stays_1080p(self):
        got = self._quality("Alien.1979.BluRay.x264-AMIABLE.mkv", self.FHD)

        assert got == "Bluray-1080p"

    def test_the_declared_quality_answers_when_the_probe_cannot(self):
        got = self._quality("Alien.1979.1080p.BluRay.x264-AMIABLE.mkv", {}, declared="Bluray-1080p")

        assert got == "Bluray-1080p"
