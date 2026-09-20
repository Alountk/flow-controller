"""Tests para las funciones de media_mixer."""
import json
import os
import time
from pathlib import Path
from unittest.mock import MagicMock, patch, AsyncMock

import pytest

# Configurar env vars antes de importar
os.environ.setdefault("FOLDER_OUTPUT_MIXED", "/tmp/mixed-test")

from media_mixer import (
    parse_probe_data,
    select_best_video,
    check_compatibility,
    build_mux_command,
    _tasks,
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

    def test_first_track_wins_ties(self):
        tracks = [
            {"index": 0, "codec": "hevc", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 3000000, "selected": False},
            {"index": 1, "codec": "hevc", "width": 3840, "height": 2160, "fps": 23.976, "bitrate": 5000000, "selected": False},
        ]
        result = select_best_video(tracks)
        assert result[0]["selected"] is True
        assert result[1]["selected"] is False


# ── check_compatibility ─────────────────────────────────────────────────────

class TestCheckCompatibility:
    def test_compatible_files(self):
        a = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 7200}
        b = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 7190}
        result = check_compatibility(a, b)
        assert result["ok"] is True
        assert len(result["warnings"]) == 0

    def test_fps_mismatch(self):
        a = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 7200}
        b = {"video_tracks": [{"fps": 29.970, "width": 1920, "height": 1080}], "duration": 7200}
        result = check_compatibility(a, b)
        assert result["ok"] is True
        assert len(result["warnings"]) == 1
        assert result["warnings"][0]["type"] == "fps_mismatch"
        assert result["warnings"][0]["file_a_value"] == 23.976
        assert result["warnings"][0]["file_b_value"] == 29.970

    def test_resolution_mismatch(self):
        a = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 7200}
        b = {"video_tracks": [{"fps": 23.976, "width": 3840, "height": 2160}], "duration": 7200}
        result = check_compatibility(a, b)
        assert result["ok"] is True
        assert len(result["warnings"]) == 1
        assert result["warnings"][0]["type"] == "resolution_mismatch"

    def test_duration_mismatch_over_5_percent(self):
        a = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 7200}
        b = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 6800}
        result = check_compatibility(a, b)
        assert result["ok"] is True
        assert len(result["warnings"]) == 1
        assert result["warnings"][0]["type"] == "duration_mismatch"

    def test_duration_under_5_percent_ok(self):
        a = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 7200}
        b = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 7100}
        result = check_compatibility(a, b)
        assert result["ok"] is True
        assert len(result["warnings"]) == 0

    def test_all_mismatches(self):
        a = {"video_tracks": [{"fps": 23.976, "width": 1920, "height": 1080}], "duration": 7200}
        b = {"video_tracks": [{"fps": 29.970, "width": 3840, "height": 2160}], "duration": 6000}
        result = check_compatibility(a, b)
        assert result["ok"] is True
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
