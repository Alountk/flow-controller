"""The routing rule for `destination_for_quality`, on its own.

It used to be reachable only through `config`, where a test had to reach for
`monkeypatch.setattr(config, "PATH_4K", ...)` to say anything about it. Now the
rule takes its folders as arguments and these tests are about the rule.
"""

from __future__ import annotations

from domain.quality import destination_for_quality

FOUR_K = "/library/4k"
THREE_D = "/library/3d"


def test_a_3d_release_beats_the_resolution():
    """The whole point of the 3D folder: keep the collection together.

    Keyed off resolution instead, a 4K3D title would land in 4K and the 3D
    shelf would be scattered across two destinations by an encoding choice
    nobody made.
    """
    assert destination_for_quality(
        "Bluray-2160p", is3d=True, path_4k=FOUR_K, path_3d=THREE_D
    ) == THREE_D


def test_3d_wins_even_at_1080():
    assert (
        destination_for_quality("Bluray-1080p", is3d=True, path_4k=FOUR_K, path_3d=THREE_D)
        == THREE_D
    )


def test_the_resolution_match_is_on_the_suffix_not_the_container():
    """Radarr joins container and resolution into one token."""
    for quality in ("Bluray-2160p", "WEBDL-2160p", "HDTV-2160p", "Remux-2160p"):
        assert (
            destination_for_quality(quality, path_4k=FOUR_K, path_3d=THREE_D) == FOUR_K
        ), quality


def test_a_1080p_release_goes_to_the_library():
    assert (
        destination_for_quality("Bluray-1080p", path_4k=FOUR_K, path_3d=THREE_D) is None
    )


def test_a_quality_titled_2160p_somewhere_else_in_the_name_does_not_match():
    """The match is the suffix; a tag in the middle is a different claim."""
    assert (
        destination_for_quality("2160p-Sourced-1080p", path_4k=FOUR_K, path_3d=THREE_D)
        is None
    )


def test_an_unconfigured_folder_means_the_library():
    """Opting in is per folder, so a deployment without one sees no change."""
    assert destination_for_quality("Bluray-2160p", path_4k="", path_3d=THREE_D) is None
    assert destination_for_quality("Bluray-1080p", is3d=True, path_4k=FOUR_K) is None


def test_without_a_configured_3d_folder_the_resolution_rule_still_applies():
    """3D outranks the resolution, but only when 3D has somewhere to go.

    With no `path_3d` there is nothing to outrank with, so the release is
    routed like any other of its resolution. That is deliberate and it is the
    existing behaviour: a deployment that configures 4K and not 3D gets 4K for
    a 4K3D title rather than the library.
    """
    assert (
        destination_for_quality("Bluray-2160p", is3d=True, path_4k=FOUR_K, path_3d="")
        == FOUR_K
    )


def test_an_unknown_quality_goes_to_the_library():
    assert (
        destination_for_quality("Cinecam-R5", path_4k=FOUR_K, path_3d=THREE_D) is None
    )


def test_an_empty_quality_is_not_an_error():
    assert destination_for_quality("", path_4k=FOUR_K, path_3d=THREE_D) is None
    assert destination_for_quality(None, path_4k=FOUR_K, path_3d=THREE_D) is None
