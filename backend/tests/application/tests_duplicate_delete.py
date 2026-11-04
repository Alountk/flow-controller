"""Borrar el duplicado que sobra («películas duplicadas» T5/S5).

Es irreversible, así que lo único que importa aquí es lo que NO se borra: fuera
de raíz, un directorio, algo que ya no existe, o una ruta que no es la que el
arr dijo. Un test con ficheros de verdad, porque el `realpath` y el `isfile` son
justo la parte que se puede creer sin comprobar.
"""

import os

import pytest

import config
from application.use_cases.duplicate_delete import DuplicateDeleteError, delete_duplicate


@pytest.fixture
def library(tmp_path, monkeypatch):
    root = tmp_path / "media"
    root.mkdir()
    monkeypatch.setattr(config, "ALLOWED_ROOTS", [str(root)], raising=False)
    monkeypatch.setattr(config, "host_path", lambda p: p.replace("/data", str(root)), raising=False)
    return root


def _file(root, rel="Peliculas/Dune/Dune.mkv", data=b"x" * 10):
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return str(target)


def test_deletes_a_file_inside_the_library(library):
    path = _file(library)

    result = delete_duplicate(path)

    assert result["deleted"] == path
    assert not os.path.exists(path)


def test_refuses_a_path_outside_the_allowed_roots(library, tmp_path):
    outside = tmp_path / "fuera.mkv"
    outside.write_bytes(b"x")

    with pytest.raises(DuplicateDeleteError) as caught:
        delete_duplicate(str(outside))

    assert "permitid" in str(caught.value).lower()
    assert outside.exists(), "lo de fuera no se toca"


def test_refuses_a_directory(library):
    folder = library / "Peliculas" / "Dune"
    folder.mkdir(parents=True)

    with pytest.raises(DuplicateDeleteError) as caught:
        delete_duplicate(str(folder))

    assert "fichero" in str(caught.value).lower()
    assert folder.is_dir(), "nunca se borra una carpeta entera"


def test_a_file_that_vanished_is_an_error_not_a_silent_success(library):
    """Decisión del usuario: rechazar y decírtelo, no fingir que se borró."""
    path = _file(library)
    os.remove(path)

    with pytest.raises(DuplicateDeleteError) as caught:
        delete_duplicate(path)

    assert "existe" in str(caught.value).lower()


def test_a_relative_path_is_refused(library):
    with pytest.raises(DuplicateDeleteError):
        delete_duplicate("Peliculas/Dune/Dune.mkv")


def test_the_arrs_own_view_of_the_path_is_translated_first(library):
    """Radarr enseña `/data/...`; el disco vive donde este host lo monta."""
    path = _file(library, "Peliculas/Dune/Dune.mkv")

    result = delete_duplicate(path.replace(str(library), "/data"))

    assert result["deleted"] == path
    assert not os.path.exists(path)


def test_a_symlink_pointing_outside_cannot_smuggle_a_delete(library, tmp_path):
    outside = tmp_path / "secreto.mkv"
    outside.write_bytes(b"x")
    link = library / "enlace.mkv"
    link.symlink_to(outside)

    with pytest.raises(DuplicateDeleteError):
        delete_duplicate(str(link))

    assert outside.exists()
