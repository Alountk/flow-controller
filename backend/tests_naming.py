"""Tests for the pure part of naming a file Radarr cannot see itself.

No network: these build a value dict, evaluate a pattern, and assert. The
orchestration that fetches the pattern lives in `clients`/`copy_engine` and is
covered there; what is pinned here is the part that can silently write a wrong
name.
"""

from naming import build_values, clean_title, evaluate, reproduced_radarr


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
    """The whole point. `{Release Group}` of the file we are about to write is
    something we do not have, and guessing it would produce a name Radarr
    would never have written."""
    values = build_values(title="Película", year=2020, quality="Bluray-2160p")

    assert evaluate("{Movie Title} - {Release Group}", values) is None


def test_media_info_tokens_fail_closed():
    values = build_values(title="Película", year=2020, quality="Bluray-2160p")

    assert evaluate("{Movie Title}.{Movie Year}.{MEDIAINFO VIDEOCODEC}", values) is None


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
