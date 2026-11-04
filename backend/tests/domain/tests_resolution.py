"""La regla de resolución, y la tabla que la ata al frontend.

`s6`: `contracts/resolution-cases.json` lo leen las dos suites. Un caso que aquí
pasa y allí no es una deriva, y ese test falla en el lado que se movió.
"""

from __future__ import annotations

import json

import pytest

from domain import resolution
from domain.library_class import library_class
from tests import BACKEND_ROOT

CASES = json.loads(
    (BACKEND_ROOT.parent / "contracts" / "resolution-cases.json").read_text("utf-8")
)["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"][:40] for c in CASES])
def test_the_shared_table(case):
    measured = resolution.from_dimensions(case["width"], case["height"])
    resolved = resolution.best(measured, case["name"])

    assert resolved == case["resolved"], case["why"]
    assert library_class(
        has_file=True, quality=case["name"], resolution=measured
    ) == case["bucket"], case["why"]


class TestDimensions:
    def test_a_zero_side_is_ignored_never_a_downgrade(self):
        # ffprobe reports only one side on some files; a 0 must not win.
        assert resolution.from_dimensions(1920, 0) == "1080"
        assert resolution.from_dimensions(0, 800) == "720"

    def test_nothing_measured_proves_nothing(self):
        assert resolution.from_dimensions(0, 0) == ""

    def test_radarr_reports_the_frame_as_width_x_height(self):
        assert resolution.parse_dimensions("1920x800") == (1920, 800)
        assert resolution.parse_dimensions("") == (0, 0)
        assert resolution.parse_dimensions("vga") == (0, 0)
        assert resolution.parse_dimensions("1920") == (0, 0)


class TestNames:
    @pytest.mark.parametrize(
        "name,expected",
        [
            ("Bluray-2160p", "2160"),
            ("Alien [4K]", "2160"),
            ("WEBDL-1080p", "1080"),
            ("Bluray-1080i", "1080"),
            ("HDTV-720p", "720"),
            ("Bluray-576p", "576"),
            ("WEBDL-480p", "480"),
            ("DVD", "480"),
            ("Sin resolucion", ""),
        ],
    )
    def test_a_name_declares_a_class_or_nothing(self, name, expected):
        assert resolution.from_name(name) == expected

    def test_a_measurement_wins_over_the_name(self):
        assert resolution.best("1080", "HDTV-720p") == "1080"
        assert resolution.best("", "HDTV-720p") == "720"
        assert resolution.best("", "") == ""
