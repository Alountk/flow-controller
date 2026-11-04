"""`tmdb_id` y los títulos en el ítem de película («películas duplicadas» T2/S1).

El buscador de duplicados agrupa por `tmdbId` y muestra los títulos en los
idiomas que Radarr tenga. El mapper no serializaba ninguno de los dos aunque el
dato ya está en `/api/v3/movie` y ya se usa en tres sitios del propio cliente:
esto es pasarlo por el ítem, no re-derivarlo.

Precedente `season_count` (PR #192): una clave que Radarr no manda se OMITE, no
se rellena con un placeholder — el frontend distingue «no lo sé» de «cero».
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


def test_the_tmdb_id_reaches_the_item():
    assert _item([_movie(tmdbId=693134)])["tmdb_id"] == 693134


def test_a_missing_tmdb_id_is_omitted_not_zero():
    """S7: un 0 en la clave agruparía películas distintas. Ausente es ausente."""
    assert "tmdb_id" not in _item([_movie()])


def test_the_alternate_titles_are_listed_without_duplicating_the_main_one():
    """Es/ru/en viven en `alternateTitles`, y el principal ya está en `title`."""
    item = _item([
        _movie(
            title="Dune: Part Two",
            alternateTitles=[
                {"sourceType": "tmdb", "title": "Dune: Parte dos"},
                {"sourceType": "tmdb", "title": "Дюна: Часть вторая"},
                {"sourceType": "tmdb", "title": "Dune: Part Two"},
            ],
        )
    ])

    assert item["titles"] == ["Dune: Part Two", "Dune: Parte dos", "Дюна: Часть вторая"]


def test_without_alternate_titles_the_main_one_alone_is_the_list():
    assert _item([_movie(title="Dune")])["titles"] == ["Dune"]
