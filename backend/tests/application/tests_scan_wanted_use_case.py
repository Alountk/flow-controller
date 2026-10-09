"""`scan_wanted_files` — the O(videos x titles) scoring, behind an injected walk.

The route used to call `os.walk` and `SequenceMatcher` itself, so proving the
scoring ran off the event loop meant patching route-module internals. With the
walk injected, these tests script the tree — no filesystem, no HTTP — and pin
the match payload the endpoint has always returned.
"""

from __future__ import annotations

from application.use_cases.scan_wanted import normalize_title, scan_wanted_files


def _walk(*entries):
    """A walk function yielding pre-arranged (root, dirs, files) triples."""
    def walk(_target):
        for root, dirs, files in entries:
            yield root, dirs, files
    return walk


def _title_map(*titles):
    return {
        title: {
            "movie_id": 813,
            "movie_title": title,
            "movie_year": 2016,
            "movie_path": f"/data/movies/{title}",
            "title_used": title,
        }
        for title in titles
    }


def test_only_video_files_are_scored_and_counted():
    walk = _walk(("/x", [], ["Whatever.2016.mkv", "notes.txt"]))

    matches, scanned = scan_wanted_files("/x", _title_map("Ton Nom"), walk=walk)

    assert scanned == 1, "a non-video file must not be counted as scanned"
    assert matches == []


def test_a_close_enough_title_scores_the_full_match_payload():
    walk = _walk(("/x", [], ["Ton Nom (2016) 1080p.mkv"]))

    matches, scanned = scan_wanted_files("/x", _title_map("Ton Nom"), walk=walk)

    assert scanned == 1
    assert matches == [
        {
            "file_path": "/x/Ton Nom (2016) 1080p.mkv",
            "file_name": "Ton Nom (2016) 1080p.mkv",
            "movie_id": 813,
            "movie_title": "Ton Nom",
            "movie_year": 2016,
            "target_path": "/data/movies/Ton Nom",
            "score": 1.0,
            "matched_title": "Ton Nom",
        }
    ]


def test_an_unrelated_file_scores_nothing():
    walk = _walk(("/x", [], ["Completely Different (1999).mkv"]))

    matches, scanned = scan_wanted_files("/x", _title_map("Ton Nom"), walk=walk)

    assert matches == []
    assert scanned == 1


def test_matches_come_back_best_score_first():
    walk = _walk(
        ("/a", [], ["Ton Nom Extra (2016).mkv"]),
        ("/b", [], ["Ton Nom (2016).mkv"]),
    )

    matches, _scanned = scan_wanted_files("/x", _title_map("Ton Nom"), walk=walk)

    assert [m["score"] for m in matches] == [1.0, 0.85], (
        "the best candidate must lead, or the UI shows the weaker grab first"
    )


def test_normalize_title_strips_extension_quality_and_year():
    assert normalize_title("Ton Nom (2016) 1080p BluRay.mkv") == "ton nom"
    assert normalize_title("Your.Name.2016.1080p.WEB-DL.mkv") == "your name"
