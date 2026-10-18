"""Tests para las funciones de media_mixer."""
import os
import types

# Configurar env vars antes de importar
os.environ.setdefault("FOLDER_OUTPUT_MIXED", "/tmp/mixed-test")

import media_mixer
from media_mixer import (
    parse_probe_data,
    select_best_video,
    select_best_video_pair,
    check_compatibility,
    build_mux_command,
    _cleanup_partial,
    CODEC_PRIORITY,
)


# ── parse_probe_data ────────────────────────────────────────────────────────

class TestParseProbeData:
    def test_parse_single_video_single_audio(self):
        data = {
            "format": {
                "format_name": "matroska,webm",
                "duration": "7200.0",
                "size": "10737418240",
            },
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "hevc",
                    "width": 1920,
                    "height": 1080,
                    "r_frame_rate": "24000/1001",
                    "bit_rate": "5000000",
                },
                {
                    "index": 1,
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "channels": 6,
                    "bit_rate": "192000",
                    "tags": {"language": "eng"},
                    "disposition": {"default": 1},
                },
            ],
        }
        result = parse_probe_data(data, "/mnt/storage/movies/movie.mkv")

        assert result["filename"] == "movie.mkv"
        assert result["path"] == "/mnt/storage/movies/movie.mkv"
        assert result["format"] == "matroska,webm"
        assert result["duration"] == 7200.0
        assert result["size_bytes"] == 10737418240
        assert len(result["video_tracks"]) == 1
        assert len(result["audio_tracks"]) == 1

        v = result["video_tracks"][0]
        assert v["index"] == 0
        assert v["codec"] == "hevc"
        assert v["width"] == 1920
        assert v["height"] == 1080
        assert abs(v["fps"] - 23.976) < 0.01
        assert v["bitrate"] == 5000000
        assert v["selected"] is False

        a = result["audio_tracks"][0]
        assert a["index"] == 1
        assert a["codec"] == "aac"
        assert a["language"] == "eng"
        assert a["channels"] == 6
        assert a["bitrate"] == 192000
        assert a["default"] is True

    def test_parse_no_audio(self):
        data = {
            "format": {"format_name": "mp4", "duration": "120.0", "size": "1000000"},
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264",
                 "width": 1280, "height": 720, "r_frame_rate": "30/1", "bit_rate": "2000000"},
            ],
        }
        result = parse_probe_data(data, "/mnt/storage/video.mp4")

        assert len(result["video_tracks"]) == 1
        assert len(result["audio_tracks"]) == 0
        assert result["video_tracks"][0]["codec"] == "h264"

    def test_parse_multiple_audio_tracks(self):
        data = {
            "format": {"format_name": "matroska", "duration": "3600.0", "size": "5000000"},
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264",
                 "width": 1920, "height": 1080, "r_frame_rate": "24000/1001", "bit_rate": "3000000"},
                {"index": 1, "codec_type": "audio", "codec_name": "aac",
                 "channels": 2, "bit_rate": "128000", "tags": {"language": "eng"},
                 "disposition": {"default": 1}},
                {"index": 2, "codec_type": "audio", "codec_name": "ac3",
                 "channels": 6, "bit_rate": "448000", "tags": {"language": "spa"},
                 "disposition": {"default": 0}},
                {"index": 3, "codec_type": "audio", "codec_name": "dts",
                 "channels": 6, "bit_rate": "768000", "tags": {"language": "jpn"},
                 "disposition": {"default": 0}},
            ],
        }
        result = parse_probe_data(data, "/mnt/storage/anime.mkv")

        assert len(result["audio_tracks"]) == 3
        assert result["audio_tracks"][0]["language"] == "eng"
        assert result["audio_tracks"][1]["language"] == "spa"
        assert result["audio_tracks"][2]["language"] == "jpn"

    def test_parse_fps_fraction(self):
        data = {
            "format": {"format_name": "mp4", "duration": "100.0", "size": "100000"},
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264",
                 "width": 1280, "height": 720, "r_frame_rate": "60000/1001", "bit_rate": "1000000"},
            ],
        }
        result = parse_probe_data(data, "/tmp/test.mp4")
        assert abs(result["video_tracks"][0]["fps"] - 59.94) < 0.01

    def test_parse_missing_optional_fields(self):
        data = {
            "format": {},
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "vp9",
                 "width": 1920, "height": 1080, "r_frame_rate": "30/1"},
                {"index": 1, "codec_type": "audio", "codec_name": "opus", "channels": 2, "tags": {}},
            ],
        }
        result = parse_probe_data(data, "/tmp/test.webm")

        assert result["format"] == "unknown"
        assert result["duration"] == 0.0
        assert result["size_bytes"] == 0
        assert result["video_tracks"][0]["bitrate"] == 0
        assert result["audio_tracks"][0]["bitrate"] == 0
        assert result["audio_tracks"][0]["language"] == "und"
        assert result["audio_tracks"][0]["default"] is False


# ── select_best_video ───────────────────────────────────────────────────────

class TestSelectBestVideo:
    def test_hevc_wins_over_h264(self):
        tracks = [
            {"index": 0, "codec": "h264", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 3000000, "selected": False},
            {"index": 1, "codec": "hevc", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 2000000, "selected": False},
        ]
        result = select_best_video(tracks)
        assert result[0]["selected"] is False
        assert result[1]["selected"] is True

    def test_h264_wins_over_other(self):
        tracks = [
            {"index": 0, "codec": "mpeg4", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 3000000, "selected": False},
            {"index": 1, "codec": "h264", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 2000000, "selected": False},
        ]
        result = select_best_video(tracks)
        assert result[0]["selected"] is False
        assert result[1]["selected"] is True

    def test_single_track_selected(self):
        tracks = [
            {"index": 0, "codec": "h264", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 3000000, "selected": False},
        ]
        result = select_best_video(tracks)
        assert result[0]["selected"] is True

    def test_empty_tracks(self):
        result = select_best_video([])
        assert result == []

    def test_h265_alias(self):
        tracks = [
            {"index": 0, "codec": "h264", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 3000000, "selected": False},
            {"index": 1, "codec": "h265", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 2000000, "selected": False},
        ]
        result = select_best_video(tracks)
        assert result[0]["selected"] is False
        assert result[1]["selected"] is True

    def test_avc_alias(self):
        tracks = [
            {"index": 0, "codec": "mpeg2", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 3000000, "selected": False},
            {"index": 1, "codec": "avc", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 2000000, "selected": False},
        ]
        result = select_best_video(tracks)
        assert result[0]["selected"] is False
        assert result[1]["selected"] is True

    def test_first_track_wins_true_tie(self):
        # Same resolution, codec and bitrate: first track wins deterministically.
        tracks = [
            {"index": 0, "codec": "hevc", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 3000000, "selected": False},
            {"index": 1, "codec": "hevc", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 3000000, "selected": False},
        ]
        result = select_best_video(tracks)
        assert result[0]["selected"] is True
        assert result[1]["selected"] is False

    def test_higher_resolution_wins_same_codec(self):
        # S4 «mejor calidad»: pixels first, even when the 4K track is second.
        tracks = [
            {"index": 0, "codec": "hevc", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 3000000, "selected": False},
            {"index": 1, "codec": "hevc", "width": 3840, "height": 2160, "fps": 23.976, "bitrate": 5000000, "selected": False},
        ]
        result = select_best_video(tracks)
        assert result[0]["selected"] is False
        assert result[1]["selected"] is True

    def test_higher_bitrate_wins_same_codec_and_resolution(self):
        # Same area + codec: higher bitrate = fewer compression artifacts.
        tracks = [
            {"index": 0, "codec": "hevc", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 3000000, "selected": False},
            {"index": 1, "codec": "hevc", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 8000000, "selected": False},
        ]
        result = select_best_video(tracks)
        assert result[0]["selected"] is False
        assert result[1]["selected"] is True


# ── select_best_video_pair ──────────────────────────────────────────────

class TestSelectBestVideoPair:
    def _probe(self, path, tracks):
        return {"path": path, "filename": path.rsplit("/", 1)[-1],
                "video_tracks": tracks, "audio_tracks": [], "duration": 7200}

    def test_b_file_wins_when_better(self):
        a = self._probe("/mnt/storage/a.mkv", [
            {"index": 0, "codec": "h264", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 12400000, "selected": False},
        ])
        b = self._probe("/mnt/storage/b.mkv", [
            {"index": 0, "codec": "hevc", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 5800000, "selected": False},
        ])
        best = select_best_video_pair(a, b)
        assert best["file"] == "b"
        assert best["path"] == "/mnt/storage/b.mkv"
        assert best["track_index"] == 0
        assert best["codec"] == "hevc"

    def test_second_track_of_b_wins(self):
        a = self._probe("/mnt/storage/a.mkv", [
            {"index": 0, "codec": "h264", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 12400000, "selected": False},
        ])
        b = self._probe("/mnt/storage/b.mkv", [
            {"index": 2, "codec": "h264", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 4000000, "selected": False},
            {"index": 3, "codec": "hevc", "width": 3840, "height": 2160, "fps": 23.976, "bitrate": 5800000, "selected": False},
        ])
        best = select_best_video_pair(a, b)
        assert best["file"] == "b"
        # track_index is the video-stream ordinal used by ffmpeg -map v:N.
        assert best["track_index"] == 1
        assert best["width"] == 3840

    def test_a_wins_full_tie(self):
        track = {"index": 0, "codec": "hevc", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 5000000, "selected": False}
        a = self._probe("/mnt/storage/a.mkv", [dict(track)])
        b = self._probe("/mnt/storage/b.mkv", [dict(track)])
        best = select_best_video_pair(a, b)
        assert best["file"] == "a"

    def test_none_when_neither_has_video(self):
        a = self._probe("/mnt/storage/a.mkv", [])
        b = self._probe("/mnt/storage/b.mkv", [])
        assert select_best_video_pair(a, b) is None


# ── check_compatibility ─────────────────────────────────────────────────────

class TestCheckCompatibility:
    def test_compatible_files(self):
        a = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 7200}
        b = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 7190}
        result = check_compatibility(a, b)
        assert result["ok"] is True
        assert result["reasons"] == []
        assert len(result["warnings"]) == 0

    def test_fps_mismatch(self):
        a = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 7200}
        b = {"video_tracks": [{"fps": 29.970, "width": 1920, "height": 1080}], "duration": 7200}
        result = check_compatibility(a, b)
        assert result["ok"] is False
        assert result["reasons"] == ["fps_mismatch"]
        assert len(result["warnings"]) == 1
        assert result["warnings"][0]["type"] == "fps_mismatch"
        assert result["warnings"][0]["file_a_value"] == 23.976
        assert result["warnings"][0]["file_b_value"] == 29.970

    def test_resolution_mismatch(self):
        a = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 7200}
        b = {"video_tracks": [{"fps": 23.976, "width": 3840, "height": 2160}], "duration": 7200}
        result = check_compatibility(a, b)
        # Resolution never blocks (S3 blocks only on fps/duration): warning only.
        assert result["ok"] is True
        assert result["reasons"] == []
        assert len(result["warnings"]) == 1
        assert result["warnings"][0]["type"] == "resolution_mismatch"

    def test_duration_mismatch_over_2_percent(self):
        a = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 7200}
        b = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 6800}
        result = check_compatibility(a, b)
        assert result["ok"] is False
        assert result["reasons"] == ["duration_mismatch"]
        assert len(result["warnings"]) == 1
        assert result["warnings"][0]["type"] == "duration_mismatch"

    def test_duration_between_2_and_5_percent_blocks(self):
        # Old spec (>5%): only a warning. New spec (S3, >2%): blocks the mux.
        a = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 7200}
        b = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 6900}
        result = check_compatibility(a, b)
        assert result["ok"] is False
        assert result["reasons"] == ["duration_mismatch"]
        assert len(result["warnings"]) == 1

    def test_duration_under_2_percent_ok(self):
        a = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 7200}
        b = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 7060}
        result = check_compatibility(a, b)
        assert result["ok"] is True
        assert result["reasons"] == []
        assert len(result["warnings"]) == 0

    def test_all_mismatches(self):
        a = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 7200}
        b = {"video_tracks": [{"fps": 29.970, "width": 3840, "height": 2160}], "duration": 6000}
        result = check_compatibility(a, b)
        assert result["ok"] is False
        # Resolution stays a warning; only fps + duration are blockers.
        assert set(result["reasons"]) == {"fps_mismatch", "duration_mismatch"}
        assert len(result["warnings"]) == 3
        types = {w["type"] for w in result["warnings"]}
        assert types == {"fps_mismatch", "resolution_mismatch", "duration_mismatch"}

    def test_no_video_tracks(self):
        a = {"video_tracks": [], "duration": 7200}
        b = {"video_tracks": [], "duration": 7200}
        result = check_compatibility(a, b)
        assert result["ok"] is True
        assert len(result["warnings"]) == 0

    def test_fps_within_threshold(self):
        a = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 7200}
        b = {"video_tracks": [{"fps": 23.9765, "width": 1920, "height": 1080}], "duration": 7200}
        result = check_compatibility(a, b)
        assert result["ok"] is True
        assert len(result["warnings"]) == 0


# ── build_mux_command ───────────────────────────────────────────────────────

class TestBuildMuxCommand:
    def test_single_video_single_audio(self):
        video = {"path": "/mnt/storage/movie.mkv", "track_index": 0}
        audio = [{"path": "/mnt/storage/movie.mkv", "track_index": 1}]
        cmd = build_mux_command(video, audio, "/tmp/output.mkv")

        assert cmd[0] == "ffmpeg"
        assert cmd[1] == "-y"
        assert cmd[2:4] == ["-i", "/mnt/storage/movie.mkv"]
        assert "-map" in cmd
        assert "0:v:0" in cmd
        assert "0:a:1" in cmd
        assert "-c" in cmd
        assert "copy" in cmd
        assert "-progress" in cmd
        assert "pipe:1" in cmd
        assert cmd[-1] == "/tmp/output.mkv"

    def test_video_from_a_audio_from_b(self):
        video = {"path": "/mnt/storage/fileA.mkv", "track_index": 0}
        audio = [{"path": "/mnt/storage/fileB.mkv", "track_index": 2}]
        cmd = build_mux_command(video, audio, "/tmp/output.mkv")

        assert "-i" in cmd
        idx_a = cmd.index("-i")
        idx_b = cmd.index("-i", idx_a + 2)
        assert cmd[idx_a + 1] == "/mnt/storage/fileA.mkv"
        assert cmd[idx_b + 1] == "/mnt/storage/fileB.mkv"

    def test_multiple_audio_tracks(self):
        video = {"path": "/mnt/storage/fileA.mkv", "track_index": 0}
        audio = [
            {"path": "/mnt/storage/fileA.mkv", "track_index": 1},
            {"path": "/mnt/storage/fileB.mkv", "track_index": 2},
        ]
        cmd = build_mux_command(video, audio, "/tmp/output.mkv")

        audio_maps = [cmd[i + 1] for i in range(len(cmd) - 1) if cmd[i] == "-map" and "a:" in cmd[i + 1]]
        assert len(audio_maps) == 2

    def test_deduplicates_input_files(self):
        video = {"path": "/mnt/storage/movie.mkv", "track_index": 0}
        audio = [{"path": "/mnt/storage/movie.mkv", "track_index": 1}]
        cmd = build_mux_command(video, audio, "/tmp/output.mkv")

        input_count = sum(1 for i in range(len(cmd) - 1) if cmd[i] == "-i")
        assert input_count == 1

    def test_stream_copy_flag(self):
        video = {"path": "/mnt/storage/movie.mkv", "track_index": 0}
        audio = [{"path": "/mnt/storage/movie.mkv", "track_index": 1}]
        cmd = build_mux_command(video, audio, "/tmp/output.mkv")

        assert "-c" in cmd
        c_idx = cmd.index("-c")
        assert cmd[c_idx + 1] == "copy"


# ── _cleanup_partial ────────────────────────────────────────────────────────

class TestCleanupPartial:
    def test_deletes_existing_file(self, tmp_path):
        partial = tmp_path / "partial.mkv"
        partial.write_bytes(b"partial data")
        _cleanup_partial(str(partial))
        assert not partial.exists()

    def test_no_error_on_nonexistent(self):
        _cleanup_partial("/nonexistent/path/file.mkv")


# ── CODEC_PRIORITY ──────────────────────────────────────────────────────────

class TestCodecPriority:
    def test_hevc_highest_priority(self):
        assert CODEC_PRIORITY["hevc"] == 0
        assert CODEC_PRIORITY["h265"] == 0

    def test_h264_second_priority(self):
        assert CODEC_PRIORITY["h264"] == 1
        assert CODEC_PRIORITY["avc"] == 1

    def test_hevc_before_h264(self):
        assert CODEC_PRIORITY["hevc"] < CODEC_PRIORITY["h264"]


# ── normalize_language / ORDERED_AUDIO_LANGUAGES (S2) ──────────────────────

class TestNormalizeLanguage:
    def test_iso_639_2_codes_are_already_canonical(self):
        assert media_mixer.normalize_language("spa") == "spa"
        assert media_mixer.normalize_language("eng") == "eng"
        assert media_mixer.normalize_language("rus") == "rus"
        assert media_mixer.normalize_language("cat") == "cat"

    def test_iso_639_1_short_codes_map_to_canonical(self):
        assert media_mixer.normalize_language("es") == "spa"
        assert media_mixer.normalize_language("en") == "eng"
        assert media_mixer.normalize_language("ru") == "rus"
        assert media_mixer.normalize_language("ca") == "cat"

    def test_case_and_whitespace_are_normalized(self):
        assert media_mixer.normalize_language("SPA") == "spa"
        assert media_mixer.normalize_language("  Es ") == "spa"

    def test_unknown_tags_pass_through_lowercased(self):
        # Only the four ordered languages get a canonical mapping.
        assert media_mixer.normalize_language("fra") == "fra"
        assert media_mixer.normalize_language("fr") == "fr"
        assert media_mixer.normalize_language("und") == "und"


class TestOrderedAudioLanguages:
    def test_the_display_order_is_ca_en_ru_cat(self):
        # S2: castellano, inglés, ruso, catalán — fixed, not configurable.
        assert media_mixer.ORDERED_AUDIO_LANGUAGES == ("spa", "eng", "rus", "cat")


def _audio_track(language, bitrate, index=0):
    """Minimal parse_probe_data() audio track."""
    return {
        "index": index, "codec": "ac3", "language": language,
        "channels": 6, "bitrate": bitrate, "default": False,
    }


def _audio_probe(*tracks):
    return {"video_tracks": [], "audio_tracks": list(tracks), "duration": 7200}


# ── order_and_mark_audio (S2/S5) ──────────────────────────────────────────

class TestOrderAndMarkAudio:
    def test_mixed_a_b_order_labels_ordinals_and_selection(self):
        a = _audio_probe(
            _audio_track("spa", 8_000_000, 1),
            _audio_track("spa", 3_000_000, 2),
            _audio_track("fra", 500_000, 3),
        )
        b = _audio_probe(
            _audio_track("eng", 2_000_000, 1),
            _audio_track("rus", 1_000_000, 2),
            _audio_track("cat", 500_000, 3),
        )
        ordered = media_mixer.order_and_mark_audio(a, b)

        assert [(t["language_code"], t["file"], t["bitrate"]) for t in ordered] == [
            ("spa", "a", 8_000_000),
            ("spa", "a", 3_000_000),
            ("eng", "b", 2_000_000),
            ("rus", "b", 1_000_000),
            ("cat", "b", 500_000),
            ("fra", "a", 500_000),
        ]
        # track_index = 0-based audio ordinal inside its own file.
        assert [t["track_index"] for t in ordered] == [0, 1, 0, 1, 2, 2]
        # L6 «4 automáticas, resto a elegir»: one per ordered language present.
        assert [t["selected"] for t in ordered] == [True, False, True, True, True, False]
        # Original track fields survive the merge.
        assert ordered[0]["codec"] == "ac3"
        assert ordered[0]["index"] == 1

    def test_language_rank_beats_file_rank(self):
        # eng from B sorts BEFORE cat from A: S2 language order dominates.
        a = _audio_probe(_audio_track("cat", 9_000_000, 1))
        b = _audio_probe(_audio_track("eng", 1_000_000, 1))
        ordered = media_mixer.order_and_mark_audio(a, b)
        assert [t["language_code"] for t in ordered] == ["eng", "cat"]
        assert [t["file"] for t in ordered] == ["b", "a"]

    def test_absent_ordered_language_selects_only_the_present_ones(self):
        # No cat anywhere: marking is independent of the required check.
        a = _audio_probe(_audio_track("spa", 8_000_000, 1), _audio_track("eng", 2_000_000, 2))
        b = _audio_probe(_audio_track("rus", 1_000_000, 1))
        ordered = media_mixer.order_and_mark_audio(a, b)
        assert [t["language_code"] for t in ordered] == ["spa", "eng", "rus"]
        assert [t["selected"] for t in ordered] == [True, True, True]
        assert not any(t["language_code"] == "cat" for t in ordered)

    def test_file_a_precedes_file_b_before_bitrate(self):
        # L12: within a language, A first, then bitrate descending.
        a = _audio_probe(_audio_track("spa", 1_000_000, 1))
        b = _audio_probe(_audio_track("spa", 5_000_000, 1))
        ordered = media_mixer.order_and_mark_audio(a, b)
        assert [(t["file"], t["bitrate"]) for t in ordered] == [("a", 1_000_000), ("b", 5_000_000)]
        assert [t["selected"] for t in ordered] == [True, False]

    def test_unknown_languages_sort_last_alphabetically(self):
        a = _audio_probe(_audio_track("fra", 1_000_000, 1), _audio_track("und", 2_000_000, 2))
        b = _audio_probe(_audio_track("deu", 3_000_000, 1))
        ordered = media_mixer.order_and_mark_audio(a, b)
        assert [t["language_code"] for t in ordered] == ["deu", "fra", "und"]
        assert [t["selected"] for t in ordered] == [False, False, False]


# ── check_required_languages (S2/L3/L14) ──────────────────────────────────

class TestRequiredLanguages:
    def test_spa_in_both_files_is_ok(self):
        result = media_mixer.check_required_languages(
            _audio_probe(_audio_track("spa", 1_000_000, 1)),
            _audio_probe(_audio_track("spa", 1_000_000, 1)),
            ["spa"],
        )
        assert result == {"ok": True, "missing": [], "required": ["spa"]}

    def test_spa_nowhere_blocks(self):
        result = media_mixer.check_required_languages(
            _audio_probe(_audio_track("eng", 1_000_000, 1)),
            _audio_probe(),
            ["spa"],
        )
        assert result == {"ok": False, "missing": ["spa"], "required": ["spa"]}

    def test_missing_only_the_absent_required_language(self):
        result = media_mixer.check_required_languages(
            _audio_probe(_audio_track("spa", 1_000_000, 1)),
            _audio_probe(),
            ["spa", "cat"],
        )
        assert result == {"ok": False, "missing": ["cat"], "required": ["spa", "cat"]}

    def test_short_codes_satisfy_canonical_requirements(self):
        result = media_mixer.check_required_languages(
            _audio_probe(_audio_track("es", 1_000_000, 1)),
            _audio_probe(_audio_track("ca", 1_000_000, 1)),
            ["spa", "cat"],
        )
        assert result == {"ok": True, "missing": [], "required": ["spa", "cat"]}

    def test_one_of_the_two_files_is_enough(self):
        # L3: «solo hace falta que uno de los dos archivos lo tenga».
        result = media_mixer.check_required_languages(
            _audio_probe(),
            _audio_probe(_audio_track("spa", 1_000_000, 1)),
            ["spa"],
        )
        assert result["ok"] is True
        assert result["missing"] == []


def test_the_mux_creation_site_tags_the_mixer_channel(tmp_path, monkeypatch):
    """T2(a): a mux job carries `channel="mixer"` from creation, so its
    terminal event lands on ['mixer-tasks'] and nowhere else."""
    import asyncio

    import event_bus
    import media_mixer

    async def _noop(*args, **kwargs):
        return None

    # The worker must never run ffmpeg in a unit test — the coroutine it
    # would execute is swapped for an empty one.
    monkeypatch.setattr(media_mixer, "_run_mux_background", lambda *a, **k: _noop())

    async def scenario():
        queue = event_bus.subscribe()  # must be subscribed FROM a loop
        try:
            task_id = media_mixer.start_mux(
                {"path": "/downloads/in/video.mkv", "track_index": 0},
                [],
                str(tmp_path / "out"),
            )
            task = media_mixer.mux_tasks.get(task_id)
            await asyncio.sleep(0)
            return task
        finally:
            event_bus.unsubscribe(queue)

    task = asyncio.run(scenario())
    assert task is not None and task["channel"] == "mixer"


# ── subtitle stream parsing (S6) ───────────────────────────────────────────

class TestParseSubtitleTracks:
    def _mkv_with_subs(self):
        # video(0) + audio(1,2) + subtitles(3 subrip spa, 4 hdmv_pgs eng).
        return {
            "format": {
                "format_name": "matroska,webm",
                "duration": "7200.0",
                "size": "10737418240",
            },
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "hevc",
                 "width": 1920, "height": 1080, "r_frame_rate": "24000/1001",
                 "bit_rate": "5000000"},
                {"index": 1, "codec_type": "audio", "codec_name": "aac",
                 "channels": 6, "bit_rate": "192000",
                 "tags": {"language": "spa"}, "disposition": {"default": 1}},
                {"index": 2, "codec_type": "audio", "codec_name": "ac3",
                 "channels": 6, "bit_rate": "448000",
                 "tags": {"language": "eng"}, "disposition": {"default": 0}},
                {"index": 3, "codec_type": "subtitle", "codec_name": "subrip",
                 "tags": {"language": "spa", "title": "Forzados"},
                 "disposition": {"forced": 1, "default": 0}},
                {"index": 4, "codec_type": "subtitle", "codec_name": "hdmv_pgs_subtitle",
                 "tags": {"language": "eng"},
                 "disposition": {"forced": 0, "default": 1}},
            ],
        }

    def test_subtitle_streams_are_parsed_with_kind_and_extractable(self):
        result = parse_probe_data(self._mkv_with_subs(), "/mnt/storage/movies/Mixer_x.mkv")

        subs = result["subtitle_tracks"]
        assert len(subs) == 2

        s0 = subs[0]
        assert s0["index"] == 3            # absolute ffprobe index, untouched
        assert s0["track_index"] == 0      # ordinal for -map 0:s:N (L18)
        assert s0["codec"] == "subrip"
        assert s0["language"] == "spa"     # raw tag
        assert s0["language_code"] == "spa"
        assert s0["title"] == "Forzados"
        assert s0["forced"] is True
        assert s0["default"] is False
        assert s0["kind"] == "text"
        assert s0["extractable"] is True

        s1 = subs[1]
        assert s1["index"] == 4
        assert s1["track_index"] == 1
        assert s1["codec"] == "hdmv_pgs_subtitle"
        assert s1["language"] == "eng"
        assert s1["language_code"] == "eng"
        assert s1["title"] == ""
        assert s1["forced"] is False
        assert s1["default"] is True
        assert s1["kind"] == "bitmap"
        assert s1["extractable"] is False

    def test_video_and_audio_carry_the_track_index_ordinal(self):
        # L18: MuxRequest.track_index = ordinal within its codec_type.
        result = parse_probe_data(self._mkv_with_subs(), "/mnt/storage/movies/Mixer_x.mkv")
        assert [t["track_index"] for t in result["video_tracks"]] == [0]
        assert [t["track_index"] for t in result["audio_tracks"]] == [0, 1]
        # The absolute index is still there and untouched.
        assert [t["index"] for t in result["audio_tracks"]] == [1, 2]

    def test_text_and_bitmap_codec_families(self):
        data = {
            "format": {"format_name": "matroska"},
            "streams": [
                {"index": 0, "codec_type": "subtitle", "codec_name": "mov_text",
                 "tags": {"language": "fra"}, "disposition": {}},
                {"index": 1, "codec_type": "subtitle", "codec_name": "ass",
                 "tags": {"language": "deu"}, "disposition": {}},
                {"index": 2, "codec_type": "subtitle", "codec_name": "dvb_subtitle",
                 "tags": {"language": "ita"}, "disposition": {}},
            ],
        }
        subs = parse_probe_data(data, "/tmp/x.mkv")["subtitle_tracks"]
        assert [(s["kind"], s["extractable"]) for s in subs] == [
            ("text", True), ("text", True), ("bitmap", False),
        ]
        assert subs[0]["language_code"] == "fra"  # passthrough lowercased

    def test_unknown_subtitle_codec_is_never_promised_as_srt(self):
        data = {
            "format": {"format_name": "matroska"},
            "streams": [
                {"index": 0, "codec_type": "subtitle", "codec_name": "eia_608",
                 "tags": {"language": "spa"}, "disposition": {}},
            ],
        }
        s0 = parse_probe_data(data, "/tmp/x.mkv")["subtitle_tracks"][0]
        assert s0["kind"] == "unknown"
        assert s0["extractable"] is False

    def test_file_without_subtitles_gets_empty_list(self):
        data = {
            "format": {"format_name": "mp4"},
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264",
                 "width": 1280, "height": 720, "r_frame_rate": "30/1"},
            ],
        }
        result = parse_probe_data(data, "/tmp/v.mp4")
        assert result["subtitle_tracks"] == []


# ── build_subtitle_extract_command / subtitle_sidecar_path (S6/S8) ────────

class TestBuildSubtitleExtractCommand:
    def test_exact_argv(self):
        cmd = media_mixer.build_subtitle_extract_command(
            "/mnt/storage/in/a.mkv", 1, "/mnt/storage/out/Mixer_x.es.srt",
        )
        assert cmd == [
            "ffmpeg", "-y", "-i", "/mnt/storage/in/a.mkv",
            "-map", "0:s:1", "-c:s", "srt",
            "/mnt/storage/out/Mixer_x.es.srt",
        ]


class TestSubtitleSidecarPath:
    def test_ordered_languages_use_the_short_suffix(self):
        # S6/L12: …_mixed.es.srt — short suffix for the four ordered codes.
        assert media_mixer.subtitle_sidecar_path(
            "/mnt/storage/out/Mixer_x.mkv", "spa",
        ) == "/mnt/storage/out/Mixer_x.es.srt"
        assert media_mixer.subtitle_sidecar_path(
            "/mnt/storage/out/M_x.mkv", "eng",
        ) == "/mnt/storage/out/M_x.en.srt"
        assert media_mixer.subtitle_sidecar_path(
            "/mnt/storage/out/M_x.mkv", "rus",
        ) == "/mnt/storage/out/M_x.ru.srt"
        assert media_mixer.subtitle_sidecar_path(
            "/mnt/storage/out/M_x.mkv", "cat",
        ) == "/mnt/storage/out/M_x.ca.srt"

    def test_other_languages_use_the_normalized_code(self):
        assert media_mixer.subtitle_sidecar_path(
            "/mnt/storage/out/M_x.mkv", "fra",
        ) == "/mnt/storage/out/M_x.fra.srt"


# ── extraction lifecycle inside start_mux (S6/S8) ──────────────────────────

class _FakeProc:
    """Stands in for the ffmpeg Popen handle (mux + subtitle extraction)."""

    def __init__(self, returncode, stderr_bytes):
        self.returncode = returncode
        self.stderr = [b"Duration: 00:02:00.00, start: 0.0\n", b"progress=end\n"]
        self._err = stderr_bytes
        self.terminated = False

    def wait(self):
        return self.returncode

    def communicate(self):
        return (b"", self._err)

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.terminated = True


def _fake_subprocess(script):
    """Fake media_mixer.subprocess; script = [(rc, stderr_bytes), ...] per call.

    Returns (namespace, calls) where `calls` records every argv.
    """
    calls = []
    remaining = list(script)

    def _popen(cmd, stdout=None, stderr=None):
        calls.append([str(part) for part in cmd])
        rc, err = remaining.pop(0) if remaining else (0, b"")
        return _FakeProc(rc, err)

    return types.SimpleNamespace(Popen=_popen, PIPE=-1), calls


def _plan_entry(language_code, suffix, path=None, track_index=None,
                codec=None, extractable=False):
    """subtitle_plan entry as the /mux route builds it (status starts pending)."""
    return {
        "language_code": language_code,
        "language": suffix,
        "path": path,
        "track_index": track_index,
        "codec": codec,
        "extractable": extractable,
        "status": "pending",
        "detail": "",
        "sidecar": None,
    }


def _drive_mux(tmp_path, plan, cancel_during_mux=False):
    """Run a real start_mux + background coroutine to completion."""
    import asyncio

    async def scenario():
        task_id = media_mixer.start_mux(
            {"path": "/in/a.mkv", "track_index": 0},
            [{"path": "/in/a.mkv", "track_index": 0}],
            str(tmp_path / "out"),
            subtitle_plan=plan,
        )
        if cancel_during_mux:
            media_mixer.cancel_task(task_id)
        for _ in range(500):
            task = media_mixer.mux_tasks.get(task_id)
            if task["status"] in ("done", "error", "cancelled"):
                break
            await asyncio.sleep(0.01)
        return media_mixer.mux_tasks.get(task_id)

    return asyncio.run(scenario())


class TestSubtitleSidecarExtraction:
    def test_mux_success_extracts_the_planned_sidecar(self, tmp_path, monkeypatch):
        fake, calls = _fake_subprocess([(0, b""), (0, b"")])
        monkeypatch.setattr(media_mixer, "subprocess", fake)
        plan = [_plan_entry("spa", "es", "/in/a.mkv", 0, "subrip", True)]

        task = _drive_mux(tmp_path, plan)

        assert task["status"] == "done"
        subs = task["subtitles"]
        assert [s["status"] for s in subs] == ["extracted"]
        sidecar = media_mixer.subtitle_sidecar_path(task["output_path"], "spa")
        assert subs[0]["sidecar"] == sidecar
        # S8: the mux maps video+audio only — never an embedded subtitle.
        assert all(":s:" not in part for part in calls[0])
        assert calls[1] == [
            "ffmpeg", "-y", "-i", "/in/a.mkv",
            "-map", "0:s:0", "-c:s", "srt", sidecar,
        ]

    def test_extraction_failure_marks_failed_with_stderr_detail(self, tmp_path, monkeypatch):
        fake, calls = _fake_subprocess([
            (0, b""),
            (1, b"Error opening output file Mixer_x.es.srt: Invalid argument\n"),
        ])
        monkeypatch.setattr(media_mixer, "subprocess", fake)
        plan = [_plan_entry("spa", "es", "/in/a.mkv", 0, "subrip", True)]

        task = _drive_mux(tmp_path, plan)

        assert task["status"] == "done"  # the mux itself succeeded
        entry = task["subtitles"][0]
        assert entry["status"] == "failed"
        assert "Error opening output file" in entry["detail"]
        assert entry["sidecar"] is None
        assert len(calls) == 2

    def test_bitmap_and_trackless_entries_resolve_without_extraction(self, tmp_path, monkeypatch):
        fake, calls = _fake_subprocess([(0, b"")])
        monkeypatch.setattr(media_mixer, "subprocess", fake)
        plan = [
            _plan_entry("spa", "es", "/in/a.mkv", 0, "subrip", True),
            _plan_entry("eng", "en", "/in/b.mkv", 1, "hdmv_pgs_subtitle", False),
            _plan_entry("rus", "ru"),  # no subtitle track anywhere (T6 fills it)
        ]

        task = _drive_mux(tmp_path, plan)

        subs = task["subtitles"]
        assert [s["status"] for s in subs] == ["extracted", "not_extractable", "missing"]
        assert subs[1]["detail"] == "bitmap: hdmv_pgs_subtitle"
        assert subs[2]["sidecar"] is None
        # Only the extractable entry spawned an ffmpeg extraction.
        assert len(calls) == 2

    def test_cancelled_during_mux_skips_extraction_and_marks_skipped(self, tmp_path, monkeypatch):
        fake, calls = _fake_subprocess([(0, b"")])
        monkeypatch.setattr(media_mixer, "subprocess", fake)
        plan = [
            _plan_entry("spa", "es", "/in/a.mkv", 0, "subrip", True),
            _plan_entry("eng", "en", "/in/b.mkv", 1, "hdmv_pgs_subtitle", False),
        ]

        task = _drive_mux(tmp_path, plan, cancel_during_mux=True)

        assert task["status"] == "cancelled"
        # No extraction: the only Popen call is the mux itself.
        assert len(calls) == 1
        # Nothing ran, so every entry is still pending -> all `skipped`.
        assert [s["status"] for s in task["subtitles"]] == ["skipped", "skipped"]

    def test_task_reports_subtitles_from_creation(self, tmp_path, monkeypatch):
        fake, _calls = _fake_subprocess([(0, b""), (0, b"")])
        monkeypatch.setattr(media_mixer, "subprocess", fake)
        plan = [_plan_entry("spa", "es", "/in/a.mkv", 0, "subrip", True)]
        seen = {}
        import asyncio

        async def scenario():
            task_id = media_mixer.start_mux(
                {"path": "/in/a.mkv", "track_index": 0},
                [{"path": "/in/a.mkv", "track_index": 0}],
                str(tmp_path / "out"),
                subtitle_plan=plan,
            )
            created = media_mixer.get_task(task_id)
            seen["created"] = [dict(e) for e in created["subtitles"]]  # snapshot
            for _ in range(500):
                if media_mixer.mux_tasks.get(task_id)["status"] == "done":
                    break
                await asyncio.sleep(0.01)
            return media_mixer.get_task(task_id)

        final = asyncio.run(scenario())
        # GET /api/mixer/tasks/:id exposes subtitles from task creation on.
        assert [s["status"] for s in seen["created"]] == ["pending"]
        assert final["subtitles"][0]["status"] == "extracted"
