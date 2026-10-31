"""The «below threshold» quality report («umbral-calidad» T2/S4).

Built from persisted probes only: a movie whose file was never analyzed is
counted apart, never listed as low quality.
"""

import os
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import app
from application.use_cases import quality_report

client = TestClient(app, raise_server_exceptions=False)


def _probe(path, width, height):
    return {
        "filename": os.path.basename(path),
        "path": path,
        "format": "matroska,webm",
        "duration": 3600.0,
        "size_bytes": 1_000_000,
        "video_tracks": [{
            "index": 0, "track_index": 0, "codec": "h264", "width": width,
            "height": height, "fps": 23.976, "bitrate": 1_000_000,
            "profile": "High", "level": 40, "color_transfer": "bt709",
            "color_primaries": "bt709", "pix_fmt": "yuv420p", "selected": True,
        }],
        "audio_tracks": [],
        "subtitle_tracks": [],
    }


def _report(files, probes, min_class="1080p", min_width=0):
    return quality_report.build(
        files,
        cache_get=probes.get,
        min_class=min_class,
        min_width=min_width,
    )


def test_only_files_below_the_threshold_are_listed():
    files = ["/m/Low (2001)/Low.mkv", "/m/Good (2002)/Good.mkv", "/m/4K (2003)/4K.mkv"]
    probes = {
        files[0]: _probe(files[0], 1280, 536),
        files[1]: _probe(files[1], 1920, 800),   # cropped 1080p: NOT low
        files[2]: _probe(files[2], 3840, 1600),
    }

    report = _report(files, probes)

    assert [item["path"] for item in report["items"]] == [files[0]]
    assert report["items"][0]["class"] == "720p"
    assert report["items"][0]["width"] == 1280
    assert report["analyzed"] == 3
    assert report["unanalyzed"] == 0


def test_unanalyzed_files_are_counted_apart_and_never_listed():
    files = ["/m/A (2001)/A.mkv", "/m/B (2002)/B.mkv"]

    report = _report(files, {files[0]: _probe(files[0], 1280, 536)})

    assert [item["path"] for item in report["items"]] == [files[0]]
    assert report["analyzed"] == 1
    assert report["unanalyzed"] == 1


def test_the_manual_width_overrides_the_class():
    files = ["/m/A (2001)/A.mkv"]
    probes = {files[0]: _probe(files[0], 1920, 800)}

    assert _report(files, probes)["items"] == []
    assert [i["path"] for i in _report(files, probes, min_width=2000)["items"]] == files


def test_threshold_changes_move_the_list():
    files = ["/m/A (2001)/A.mkv"]
    probes = {files[0]: _probe(files[0], 1280, 536)}

    assert _report(files, probes, min_class="720p")["items"] == []
    assert len(_report(files, probes, min_class="1080p")["items"]) == 1


def test_the_route_serves_the_report_with_the_saved_threshold():
    files = ["/m/A (2001)/A.mkv"]
    topics = {
        "universe": files,
        "min_class": "1080p",
        "min_width": 0,
    }

    async def universe():
        return files

    def setting(section, key, default=None):
        assert section == "quality"
        return topics[key] if key in topics else default

    with patch("interfaces.http.routes_mixer.probe_library.collect_universe", universe), \
         patch("interfaces.http.routes_mixer.history.get_probe_result",
               lambda p: _probe(p, 1280, 536)), \
         patch("interfaces.http.routes_mixer.get_setting", setting):
        resp = client.get("/api/mixer/quality/below")

    assert resp.status_code == 200
    body = resp.json()
    assert body["threshold"] == {"min_class": "1080p", "min_width": 0}
    assert len(body["items"]) == 1
    assert body["items"][0]["class"] == "720p"
