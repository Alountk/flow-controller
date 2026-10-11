"""`season_count` on the series listing rows (stitch-series-summary T3).

Sonarr reports ``statistics.seasonCount`` next to the episode counts the row
already shows, and the UI appends "· N temporadas" to its episodes line when
the payload carries it. The field is OPTIONAL end-to-end, so the mapper must:

- forward ``seasonCount`` as ``season_count`` when the payload carries it;
- OMIT the key entirely when it does not — not ``None``, not ``0``. An
  absent key keeps the frontend on the legacy line, while a made-up value
  would claim seasons Sonarr never reported (the row's "no invented
  numbers" rule).

The episode counts get their first mapper pin here too: nothing in
``backend/tests`` ever asserted them directly.

Only the HTTP transport is faked (``_StubSession``), so the real function
body runs.
"""

import asyncio

from infrastructure.arr_client import fetch_all_series_detailed
from tests._stubs import _StubSession

SONARR_URL = "http://sonarr.test:8989"


def _service() -> dict:
    return {"key": "sonarr", "kind": "arr", "url": SONARR_URL, "api_key": "test-key"}


def _series(statistics) -> dict:
    series = {"id": 3, "title": "Some Show", "path": "/series/Some Show", "monitored": True}
    if statistics is not None:
        series["statistics"] = statistics
    return series


def _item(statistics) -> dict:
    routes = {f"{SONARR_URL}/api/v3/series": (200, [_series(statistics)])}
    result = asyncio.run(fetch_all_series_detailed(_StubSession(routes), _service()))
    return result["items"][0]


def test_a_season_count_reported_by_sonarr_reaches_the_item():
    item = _item({"episodeCount": 10, "episodeFileCount": 4, "seasonCount": 3})

    assert item["season_count"] == 3


def test_a_payload_without_a_season_count_omits_the_key():
    """Absent, never ``None``/``0``: the UI must stay on the legacy line."""
    item = _item({"episodeCount": 10, "episodeFileCount": 4})

    assert "season_count" not in item


def test_a_payload_without_statistics_omits_the_key_too():
    item = _item(None)

    assert "season_count" not in item
    assert item["episode_count"] == 0
    assert item["episode_file_count"] == 0


def test_the_episode_counts_keep_their_existing_mapping():
    item = _item({"episodeCount": 10, "episodeFileCount": 4})

    assert item["episode_count"] == 10
    assert item["episode_file_count"] == 4
