"""The title-token derivations `_release_row` adds, on their own.

Pure: a release title in, Radarr-shaped facts out. No request, no service —
that is what keeps the honest-absence rule (no token → no key) testable here.
"""

from __future__ import annotations

from domain.release_tokens import languages_from_title, quality_from_title


# ── quality_from_title ──────────────────────────────────────────────────────


def test_bluray_1080p_from_a_scene_title():
    assert quality_from_title("Everything.2022.1080p.BluRay.x264-GRP") == "Bluray-1080p"


def test_webdl_2160p_from_the_hyphenated_variant():
    assert quality_from_title("Dune.2021.2160p.WEB-DL.DDP5.1.HDR.x265-GRP") == "WEBDL-2160p"


def test_webdl_2160p_from_the_joined_variant():
    assert quality_from_title("Dune.2021.2160p.WEBDL.DDP5.1.x265-GRP") == "WEBDL-2160p"


def test_hdtv_720p():
    assert quality_from_title("Show.S01E01.720p.HDTV.x264-GRP") == "HDTV-720p"


def test_webrip_1080p():
    assert quality_from_title("Show.S01E01.1080p.WEBRip.x264-GRP") == "WEBRip-1080p"


def test_webrip_1080p_from_the_hyphenated_variant():
    assert quality_from_title("Show.S01E01.1080p.WEB-Rip.x264-GRP") == "WEBRip-1080p"


def test_remux_still_reads_as_bluray():
    assert quality_from_title("Movie.2020.2160p.UHD.BluRay.REMUX.HDR.x265-GRP") == "Bluray-2160p"


def test_bdremux_variant_maps_to_bluray():
    assert quality_from_title("Movie.2020.1080p.BDRemux.x264-GRP") == "Bluray-1080p"


def test_bdrip_variant_maps_to_bluray():
    assert quality_from_title("Movie.2020.1080p.BDRip.x264-GRP") == "Bluray-1080p"


def test_hyphenated_blu_ray_variant_maps_to_bluray():
    assert quality_from_title("Some.Film.1080p.Blu-ray.x264") == "Bluray-1080p"


def test_webdl_576p_keeps_the_low_resolution():
    assert quality_from_title("Show.S01E01.576p.WEB-DL.x264-GRP") == "WEBDL-576p"


def test_container_without_resolution_is_not_a_quality():
    assert quality_from_title("Some Movie BluRay") is None


def test_resolution_without_container_is_not_a_quality():
    assert quality_from_title("Some Movie 1080p") is None


def test_plain_title_carries_no_quality():
    assert quality_from_title("Some Movie") is None


def test_hdr_is_not_a_container_so_hdrip_yields_nothing():
    # Boundary rule: `hd`/`rip` fragments must never hit a container token.
    assert quality_from_title("Some.Movie.1080p.HDRip.x264-GRP") is None


# ── languages_from_title ────────────────────────────────────────────────────


def test_spanish_uppercase_word():
    assert languages_from_title("Movie.2020.SPANISH.1080p.WEB-DL.x264") == ["Spanish"]


def test_spanish_lowercase_word():
    assert languages_from_title("Movie.2020.spanish.1080p.WEB-DL.x264") == ["Spanish"]


def test_espanol_maps_to_spanish():
    assert languages_from_title("Pelicula.2020.ESPAÑOL.1080p.WEB-DL") == ["Spanish"]


def test_dual_contributes_nothing():
    # Which pair DUAL carries is a guess; guessing is invention.
    assert languages_from_title("Movie.2020.DUAL.1080p.BluRay") == []


def test_dualaudio_contributes_nothing():
    assert languages_from_title("Movie.2020.DUALAUDIO.1080p.BluRay") == []


def test_standalone_uppercase_short_codes_match():
    assert languages_from_title("Movie.2020.ENG.1080p.BluRay") == ["English"]
    assert languages_from_title("Movie.2020.RUS.1080p.BluRay") == ["Russian"]
    assert languages_from_title("Movie.2020.ESP.1080p.BluRay") == ["Spanish"]


def test_title_case_letters_are_not_short_codes():
    assert languages_from_title("Cast.Away.2000.1080p.BluRay") == []


def test_short_code_inside_a_word_is_not_a_code():
    assert languages_from_title("Something.ESPecial.2020.1080p") == []


def test_multiple_languages_keep_the_canonical_order():
    assert languages_from_title("Movie.GERMAN.FRENCH.2020.1080p") == ["French", "German"]
    assert languages_from_title("Movie.ENGLISH.SPANISH.2020.1080p") == ["Spanish", "English"]


def test_repeated_language_appears_once():
    assert languages_from_title("Movie.SPANISH.ESP.2020.1080p") == ["Spanish"]


def test_plain_title_carries_no_languages():
    assert languages_from_title("Everything.2022.1080p.BluRay.x264-GRP") == []
