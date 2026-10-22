"""`arr_movie_lookup` — the lookup fields «Búsqueda en idioma» reads (T3/S4).

`originalTitle` and `alternateTitles` are the two Radarr lookup fields this
function used to THROW AWAY — exactly the titles the S4 chips need (Radarr
searches by id and never `alternateTitles`, so the UI must offer them to the
operator). The normalization contract:

- `original_title`: Radarr's `originalTitle`, `None` when the payload omits it;
- `alternate_titles`: `[{title, language}]` in RADARR ORDER, capped at 12
  (the S4 chip row must not flood), `language` is `None` when the entry has
  no language — the documented real payload shape in `tests_wanted_scan.py`
  («captured from a real Radarr /api/v3/movie/{id} response») carries `title`
  and no `language`, so a missing language is `None`, never a guessed code.

Only the HTTP transport is faked (`_StubSession`), so the real function body
runs. Written next to `tests_arr_client.py`, its lookup sibling.
"""

import asyncio

from infrastructure.arr_client import arr_movie_lookup
from tests._stubs import _StubSession

RADARR_URL = "http://radarr.test:7878"

#: The documented real shape (tests_wanted_scan.py): `title`, no `language`.
_DOCUMENTED_ENTRY = {
    "sourceType": "tmdb",
    "movieMetadataId": 1083,
    "title": "Ton Nom",
    "id": 12496,
}


def _service() -> dict:
    return {"key": "radarr", "kind": "arr", "url": RADARR_URL, "api_key": "test-key"}


def _lookup(payload) -> dict:
    session = _StubSession({f"{RADARR_URL}/api/v3/movie/lookup": (200, payload)})
    return asyncio.run(arr_movie_lookup(session, _service(), "Arthur and the Invisibles"))


def test_the_lookup_surfaces_original_and_alternate_titles():
    result = _lookup(
        [
            {
                "tmdbId": 550,
                "title": "Arthur and the Invisibles",
                "year": 2006,
                "originalTitle": "Arthur et les Minimoys",
                "alternateTitles": [
                    {"title": "Артур и минипуты", "language": "ru"},
                    _DOCUMENTED_ENTRY,
                ],
            }
        ]
    )

    assert result["original_title"] == "Arthur et les Minimoys"
    assert result["alternate_titles"] == [
        {"title": "Артур и минипуты", "language": "ru"},
        {"title": "Ton Nom", "language": None},
    ]


def test_entries_without_a_language_keep_null():
    """The real captured payload's entries have no `language` at all: the
    normalized answer is `None`, never an invented code."""
    result = _lookup([{"tmdbId": 1, "title": "X", "alternateTitles": [_DOCUMENTED_ENTRY]}])

    assert result["alternate_titles"] == [{"title": "Ton Nom", "language": None}]


def test_alternate_titles_keep_radarr_order_and_cap_at_twelve():
    entries = [{"title": f"Title {i:02d}", "language": None} for i in range(15)]

    result = _lookup([{"tmdbId": 1, "title": "X", "alternateTitles": entries}])

    assert [e["title"] for e in result["alternate_titles"]] == [
        f"Title {i:02d}" for i in range(12)
    ]


def test_missing_original_and_alternates_degrade_to_null_and_empty():
    result = _lookup([{"tmdbId": 550, "title": "Dune", "year": 2024}])

    assert result["original_title"] is None
    assert result["alternate_titles"] == []
