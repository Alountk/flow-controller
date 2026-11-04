"""`GET /api/movies/duplicates` («películas duplicadas» T3/S1/S2/S3/S6).

La ruta no decide la regla — eso es `domain/duplicates.py` — sino que la sirve:
el catálogo de Radarr entra, los grupos salen. Lo que aquí se fija es lo que
puede salir mal en la frontera: un arr sin configurar que parece «sin
duplicados», y una respuesta que se pueda pintar sin pedir nada más.
"""

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app import app
from interfaces.http.routes import wanted


def _movie(ident, tmdb_id, path, quality="Bluray-1080p"):
    return {
        "id": ident,
        "title": f"Pelicula {ident}",
        "titles": [f"Pelicula {ident}"],
        "tmdb_id": tmdb_id,
        "path": path,
        "quality": quality,
        "has_file": True,
        "size_on_disk": 1_000,
    }


@pytest.fixture
def client():
    return TestClient(app)


def _call(client, result):
    with patch.object(wanted, "find_service", return_value={"key": "radarr", "url": "http://x", "api_key": "k"}), \
         patch.object(wanted, "fetch_all_movies_detailed", new_callable=AsyncMock, return_value=result):
        return client.get("/api/movies/duplicates").json()


def test_two_copies_of_one_movie_come_back_as_a_group(client):
    body = _call(client, {"items": [
        _movie(1, 438631, "/media/a/Dune.mkv"),
        _movie(2, 438631, "/media/b/Dune.mkv"),
        _movie(3, 999, "/media/c/Otra.mkv"),
    ]})

    assert body["total"] == 1
    assert len(body["groups"][0]["files"]) == 2


def test_an_unconfigured_radarr_is_not_an_empty_library(client):
    with patch.object(wanted, "find_service", return_value=None):
        body = client.get("/api/movies/duplicates").json()

    assert body["error_kind"] == "unknown"
    assert "no configurado" in body["error"]


def test_a_failed_fetch_is_reported_not_swallowed(client):
    body = _call(client, {"items": [], "error": "radarr caído", "error_kind": "unreachable"})

    assert body["groups"] == []
    assert body["error_kind"] == "unreachable"
