"""`GET /api/movies/duplicates` («películas duplicadas» T3/S1).

La ruta no decide la regla — eso es `domain/duplicates_folders.py` — sino que la
sirve: recorre las raíces permitidas en un hilo y le pasa lo que Radarr conoce
para marcar cuál es el fichero que no se debe borrar. Lo que aquí se fija es la
frontera: un disco real de verdad, un arr que no responde y no rompe nada, y una
respuesta que se pueda pintar sin pedir nada más.
"""

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

import config
from app import app
from interfaces.http.routes import wanted

FOLDER = "Now You See Me (2013)"
WEBRIP = "Now You See Me (2013) WEBRip-1080p - h265 DTS - [ES+EN].mkv"
WEBDL = "Now You See Me (2013) WEBDL-1080p - h265 TrueHD Atmos - [EN+ES].mkv"


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def library(tmp_path, monkeypatch):
    """Una biblioteca de verdad en `tmp_path`, con el caso literal del usuario."""
    folder = tmp_path / "movies" / "es" / FOLDER
    folder.mkdir(parents=True)
    (folder / WEBRIP).write_bytes(b"x" * 100)
    (folder / WEBDL).write_bytes(b"x" * 250)
    monkeypatch.setattr(config, "ALLOWED_ROOTS", [str(tmp_path)], raising=False)
    return folder


def _movie(path):
    return {
        "id": 1,
        "title": "Now You See Me",
        "titles": ["Now You See Me"],
        "tmdb_id": 75656,
        "path": path,
        "file_name": WEBRIP,
        "quality": "WEBRip-1080p",
        "has_file": True,
        "size_on_disk": 100,
    }


def _call(client, *, movies):
    with patch.object(wanted, "find_service", return_value={"key": "radarr", "url": "http://x", "api_key": "k"}), \
         patch.object(wanted, "fetch_all_movies_detailed", new_callable=AsyncMock,
                      return_value={"items": movies, "total": len(movies)}):
        return client.get("/api/movies/duplicates").json()


def test_two_files_of_the_same_class_come_back_as_one_group(client, library):
    body = _call(client, movies=[_movie(str(library))])

    assert body["total"] == 1
    group = body["groups"][0]
    assert group["title"] == "Now You See Me"
    assert group["classes"] == ["1080"]
    assert [f["class"] for f in group["files"]] == ["1080", "1080"]
    assert len(group["files"]) == 2


def test_the_file_radarr_knows_is_flagged(client, library):
    body = _call(client, movies=[_movie(str(library))])

    files = body["groups"][0]["files"]
    known = [f for f in files if f["known"]]
    assert [f["name"] for f in known] == [WEBRIP]
    # Lo que Radarr no conoce es lo único reclamable.
    assert body["groups"][0]["reclaimable"] == 250


def test_without_radarr_the_walk_still_finds_the_files(client, library):
    """Un arr caído no puede esconder dos ficheros que están en la misma carpeta."""
    with patch.object(wanted, "find_service", return_value=None):
        body = client.get("/api/movies/duplicates").json()

    assert body["total"] == 1
    assert body["radarr"] is False
    # Sin el arr no se puede decir cuál sobra: se marcan como desconocidos.
    assert all(f["known"] is None for f in body["groups"][0]["files"])


def test_a_radarr_that_raises_does_not_break_the_scan(client, library):
    with patch.object(wanted, "find_service", return_value={"key": "radarr", "url": "http://x"}), \
         patch.object(wanted, "fetch_all_movies_detailed", new_callable=AsyncMock,
                      side_effect=RuntimeError("radarr caído")):
        body = client.get("/api/movies/duplicates").json()

    assert body["total"] == 1


def test_an_empty_root_is_not_an_error(client, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "ALLOWED_ROOTS", [str(tmp_path / "vacio")], raising=False)

    body = _call(client, movies=[])

    assert body == {
        "groups": [],
        "total": 0,
        "folders": 0,
        "roots": [str(tmp_path / "vacio")],
        "scope": "",
        "radarr": False,
    }


def test_one_movie_with_two_repeated_classes_is_one_group(client, library):
    # La pantalla pregunta «qué película tiene copias de más». Dos clases
    # repetidas en la misma carpeta son una película, no dos.
    (library / "Now You See Me (2013) 2160p WEBDL.mkv").write_bytes(b"x" * 10)
    (library / "Now You See Me (2013) 2160p WEBRip.mkv").write_bytes(b"x" * 20)

    body = _call(client, movies=[_movie(str(library))])

    assert body["total"] == 1
    group = body["groups"][0]
    assert sorted(group["classes"]) == ["1080", "4K"]
    assert len(group["files"]) == 4
    # El que sobra primero, también dentro del grupo (4K antes que 1080).
    assert [f["class"] for f in group["files"]] == ["4K", "4K", "1080", "1080"]


def test_the_scope_walks_only_the_folder_it_names(client, library, tmp_path):
    fuera = tmp_path / "movies" / "fuera"
    fuera.mkdir(parents=True)
    (fuera / "Otra (2020) a.mkv").write_bytes(b"x")
    (fuera / "Otra (2020) b.mkv").write_bytes(b"x")

    with patch.object(wanted, "find_service", return_value={"key": "radarr", "url": "http://x", "api_key": "k"}), \
         patch.object(wanted, "fetch_all_movies_detailed", new_callable=AsyncMock,
                      return_value={"items": [_movie(str(library))], "total": 1}):
        body = client.get("/api/movies/duplicates", params={"path": str(library)}).json()

    assert body["scope"] == str(library)
    assert [g["title"] for g in body["groups"]] == ["Now You See Me"]


def test_a_scope_outside_the_allowed_roots_is_refused(client, library, tmp_path):
    response = client.get("/api/movies/duplicates", params={"path": str(tmp_path / ".." / "etc")})

    assert response.status_code == 403
    assert "no permitida" in response.json()["detail"]


def test_deleting_refuses_a_path_outside_the_library_with_its_reason(client, tmp_path):
    outside = tmp_path / "fuera.mkv"
    outside.write_bytes(b"x")

    response = client.post("/api/movies/duplicates/delete", json={"path": str(outside)})

    assert response.status_code == 400
    assert "permitid" in response.json()["detail"].lower()
    assert outside.exists()


def test_deleting_without_a_path_is_a_400_not_a_500(client):
    assert client.post("/api/movies/duplicates/delete", json={}).status_code == 400
