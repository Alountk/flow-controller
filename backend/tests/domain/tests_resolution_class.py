"""Resolution class from a measured probe («umbral-calidad» T1/S1).

The rule: the class comes from the WIDTH. A 1080p transfer whose black bars
were cropped measures 1920×800 and is still a 1080p file — reading the bare
height would flag every widescreen movie as «baja calidad».
"""

import pytest

from domain.quality import class_rank, is_below_threshold, resolution_class


@pytest.mark.parametrize(
    ("width", "height", "expected"),
    [
        # The case the operator reported: cropped 1080p is NOT a downgrade.
        (1920, 800, "1080p"),
        (1920, 816, "1080p"),
        (1920, 872, "1080p"),
        (1920, 1080, "1080p"),
        # Same crop at 4K.
        (3840, 1600, "4k"),
        (3840, 2160, "4k"),
        # Real lower classes.
        (1280, 536, "720p"),
        (1280, 720, "720p"),
        (720, 576, "sd"),
        (1024, 576, "sd"),
    ],
)
def test_the_class_comes_from_the_width_never_the_bare_height(width, height, expected):
    assert resolution_class(width, height) == expected


@pytest.mark.parametrize(
    ("width", "expected"),
    [
        (1099, "sd"),
        (1100, "720p"),
        (1699, "720p"),
        (1700, "1080p"),
        (2999, "1080p"),
        (3000, "4k"),
    ],
)
def test_the_class_boundaries_are_pinned(width, expected):
    assert resolution_class(width, 0) == expected


@pytest.mark.parametrize("width", [0, -1, None])
def test_no_measured_width_is_unknown_never_a_class(width):
    assert resolution_class(width, 800) == "desconocido"


def test_ranks_order_the_classes_and_unknown_sinks():
    assert class_rank("sd") < class_rank("720p") < class_rank("1080p") < class_rank("4k")
    # Unknown must never outrank or equal a real class: it is "not measured".
    assert class_rank("desconocido") < class_rank("sd")
    assert class_rank("nonsense") == class_rank("desconocido")


def test_cropped_1080p_is_not_below_the_default_threshold():
    # S1 + S3: the bug that motivated this feature.
    assert is_below_threshold(1920, 800, min_class="1080p", min_width=0) is False


def test_a_720p_file_is_below_a_1080p_threshold():
    assert is_below_threshold(1280, 536, min_class="1080p", min_width=0) is True


def test_the_manual_width_overrides_the_class_comparison():
    # 1920 clears the class threshold, but the operator asked for 2000.
    assert is_below_threshold(1920, 800, min_class="1080p", min_width=2000) is True
    assert is_below_threshold(2560, 1440, min_class="1080p", min_width=2000) is False


def test_an_unmeasured_file_is_never_below_the_threshold():
    # Unknown is not "low quality": it is "not analyzed yet" (S4/L4).
    assert is_below_threshold(0, 0, min_class="1080p", min_width=2000) is False
