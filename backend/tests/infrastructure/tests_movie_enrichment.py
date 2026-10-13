"""Design-03 enrichment of the all-movies mapper: ``imdb_id``, ``runtime``,
``size_on_disk`` and ``directors``.

The Películas port (Stitch screen 03) shows the runtime next to the year, a
mono IMDb chip, the on-disk size on the card and a ``Dir: …`` line. Radarr's
``/api/v3/movie`` carries all four; the mapper never serialized them.

Precedent: ``season_count`` (PR #192) — a key Radarr does not send is OMITTED
entirely, never ``None``, never a placeholder: the frontend type is optional
and an absent key means "unknown", so no stub written before this field
existed can break.
"""

import asyncio

from infrastructure.arr_client import fetch_all_movies_detailed
from tests._stubs import CONFIGURED_RADARR_URL, _StubSession

RADARR_URL = CONFIGURED_RADARR_URL


def _movie(**extra) -> dict:
    base = {
        "id": 1,
        "title": "Dune: Part Two",
        "year": 2024,
        "hasFile": True,
        "path": "/media/peliculas/Dune Part Two (2024)",
        "monitored": True,
    }
    base.update(extra)
    return base


def _service() -> dict:
    return {"key": "radarr", "kind": "arr", "url": RADARR_URL, "api_key": "test-key"}


def _item(payload: list[dict]) -> dict:
    session = _StubSession({f"{RADARR_URL}/api/v3/movie": (200, payload)})
    result = asyncio.run(fetch_all_movies_detailed(session, _service()))
    return result["items"][0]


# ── when Radarr sends the fields, the mapper passes them through ─────────────


def test_enriches_the_movie_with_the_four_design_fields():
    item = _item(
        [
            _movie(
                imdbId="tt15239678",
                runtime=166,
                sizeOnDisk=51_753_517_056,
                directors=["Denis Villeneuve"],
            )
        ]
    )

    assert item["imdb_id"] == "tt15239678"
    assert item["runtime"] == 166
    assert item["size_on_disk"] == 51_753_517_056
    assert item["directors"] == ["Denis Villeneuve"]


# ── when Radarr sends nothing, the keys are absent (season_count precedent) ──


def test_every_enrichment_key_is_omitted_when_radarr_sends_none():
    item = _item([_movie()])

    assert "imdb_id" not in item
    assert "runtime" not in item
    assert "size_on_disk" not in item
    assert "directors" not in item


def test_an_empty_imdb_string_reads_as_unknown_not_as_a_chip():
    item = _item([_movie(imdbId="")])

    assert "imdb_id" not in item


def test_directors_never_become_placeholder_entries():
    """A missing/odd ``directors`` never renders ``Dir: `` on screen."""
    for value in ([], "", None, [""], "Denis Villeneuve"):
        item = _item([_movie(directors=value)])
        assert "directors" not in item, value


def test_a_zero_size_is_radars_own_answer_and_passes_through():
    """``sizeOnDisk: 0`` for a title without file is real data; the card
    decides not to render a size, the mapper does not lie about it."""
    item = _item([_movie(hasFile=False, sizeOnDisk=0)])

    assert item["size_on_disk"] == 0


def test_a_non_numeric_runtime_is_dropped_rather_than_shown():
    item = _item([_movie(runtime="166 min")])

    assert "runtime" not in item
