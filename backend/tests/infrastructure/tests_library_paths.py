"""The library listing asks the HOST about paths the arr reported (B-08).

``path_exists`` ran ``os.path.isdir`` on the path exactly as Radarr/Sonarr
report it. Radarr sees ``/data/...``; this host sees ``/mnt/storage/...``
(``_VOLUME_MAP``), so a perfectly healthy movie or series folder read as
missing and the row said «✗ Ruta no encontrada» — the latent half of B-01(b),
registered in the backlog and left unfixed until now. The translation
``copy_engine`` already applies (``host_path``) is the same one needed here.

Contract pinned here:

- the DISK checks (``isdir``, ``_folder_has_video``) run against the host path;
- the ``path`` exposed to the UI stays **the arr's own** — the Calidad view
  matches ``path_4k``/``path_3d`` membership off that field;
- a path the map does not touch (already a host path) behaves exactly as before.

Only the HTTP transport is faked (``_StubSession``), so the real function
bodies run.
"""

import asyncio

import config
from infrastructure.arr_client import fetch_all_movies_detailed, fetch_all_series_detailed
from tests._stubs import _StubSession

RADARR_URL = "http://radarr.test:7878"
SONARR_URL = "http://sonarr.test:8989"


def _service(key: str, url: str) -> dict:
    return {"key": key, "kind": "arr", "url": url, "api_key": "test-key"}


def _movie(path: str, has_file: bool = False) -> dict:
    return {
        "id": 1,
        "title": "Película",
        "year": 2021,
        "hasFile": has_file,
        "path": path,
        "monitored": True,
    }


def _series(path: str) -> dict:
    return {
        "id": 1,
        "title": "Serie",
        "path": path,
        "monitored": True,
        "statistics": {"episodeCount": 10, "episodeFileCount": 0},
    }


def _item(payload, service, listing_fn, route):
    session = _StubSession({route: (200, payload)})
    result = asyncio.run(listing_fn(session, service))
    return result["items"][0]


def test_a_movie_folder_in_arr_view_is_checked_at_the_host_path(tmp_path, monkeypatch):
    """The B-08 case: Radarr says /data/..., the bytes live under the mount."""
    real = tmp_path / "Movies" / "Película (2021)"
    real.mkdir(parents=True)
    (real / "Película (2021).mkv").write_bytes(b"x")
    monkeypatch.setattr(config, "_VOLUME_MAP", [("/data/", str(tmp_path) + "/")])

    arr_path = "/data/Movies/Película (2021)"
    item = _item(
        [_movie(arr_path)],
        _service("radarr", RADARR_URL),
        fetch_all_movies_detailed,
        f"{RADARR_URL}/api/v3/movie",
    )

    assert item["path_exists"] is True
    assert item["has_unimported_file"] is True
    # The arr's own path is what the UI receives: Calidad matches path_4k/
    # path_3d membership off it, and translating it would break that match.
    assert item["path"] == arr_path


def test_a_series_folder_in_arr_view_is_checked_at_the_host_path(tmp_path, monkeypatch):
    real = tmp_path / "TV" / "Serie (2020)"
    real.mkdir(parents=True)
    monkeypatch.setattr(config, "_VOLUME_MAP", [("/data/", str(tmp_path) + "/")])

    arr_path = "/data/TV/Serie (2020)"
    item = _item(
        [_series(arr_path)],
        _service("sonarr", SONARR_URL),
        fetch_all_series_detailed,
        f"{SONARR_URL}/api/v3/series",
    )

    assert item["path_exists"] is True
    assert item["path"] == arr_path


def test_a_missing_folder_still_reads_as_missing_after_translation(tmp_path, monkeypatch):
    """The map must not turn a genuinely absent folder into a found one."""
    monkeypatch.setattr(config, "_VOLUME_MAP", [("/data/", str(tmp_path) + "/")])

    item = _item(
        [_movie("/data/Movies/NoExiste (1999)")],
        _service("radarr", RADARR_URL),
        fetch_all_movies_detailed,
        f"{RADARR_URL}/api/v3/movie",
    )

    assert item["path_exists"] is False
    assert item["has_unimported_file"] is False


def test_an_unmapped_path_is_still_checked_directly(tmp_path):
    """A payload that already carries a host path needs no rewrite (no-op)."""
    real = tmp_path / "Película (2021)"
    real.mkdir()
    (real / "Película (2021).mkv").write_bytes(b"x")

    item = _item(
        [_movie(str(real))],
        _service("radarr", RADARR_URL),
        fetch_all_movies_detailed,
        f"{RADARR_URL}/api/v3/movie",
    )

    assert item["path_exists"] is True
    assert item["has_unimported_file"] is True
