"""El registro de renombrados (S2), que es lo único que distingue "se renombró"
de "nunca estuvo" — el candidato desaparece de la lista en cuanto cumple la
plantilla.

Como en el resto de este almacén, lo que se prueba no es "se escribió una fila"
sino lo que la pantalla necesita: el más reciente primero, de dónde a dónde, y
si el destino sigue en el disco.
"""

import os

import pytest

from infrastructure import sqlite_history as history


@pytest.fixture
def db(tmp_path):
    history.close()
    history.init_db(tmp_path / "history.db")
    yield

    history.close()


def test_an_empty_log_lists_nothing(db):
    assert history.recent_renames() == []


def test_a_rename_is_remembered_with_both_names(db, tmp_path):
    before = str(tmp_path / "Dune.2021.2160p.mkv")
    after = str(tmp_path / "Dune - Parte Dos (2024) [Bluray-2160p].mkv")
    (tmp_path / "Dune - Parte Dos (2024) [Bluray-2160p].mkv").write_text("x")

    history.record_rename(before, after, movie_id=7)

    (row,) = history.recent_renames()
    assert (row["src"], row["dst"], row["movie_id"]) == (before, after, 7)
    assert row["origin"] == "lote"


def test_a_hand_rename_says_so(db):
    history.record_rename("/a/heat.mkv", "/a/Heat (1995).mkv", origin="a mano")

    assert history.recent_renames()[0]["origin"] == "a mano"


def test_the_most_recent_rename_comes_first(db):
    history.record_rename("/a/1.mkv", "/a/uno.mkv")
    history.record_rename("/a/2.mkv", "/a/dos.mkv")

    assert [row["dst"] for row in history.recent_renames()] == ["/a/dos.mkv", "/a/uno.mkv"]


def test_a_destination_that_is_gone_is_reported_as_gone(db, tmp_path):
    # La vista no ofrece abrir una carpeta que ya no existe: lo dice (S7).
    gone = str(tmp_path / "se-fue.mkv")
    history.record_rename(str(tmp_path / "antes.mkv"), gone)

    assert history.recent_renames()[0]["exists"] is False

    open(gone, "w").close()
    assert history.recent_renames()[0]["exists"] is True


def test_the_log_survives_a_restart(db, tmp_path):
    history.record_rename("/a/viejo.mkv", "/a/nuevo.mkv")
    history.close()
    history.init_db(tmp_path / "history.db")

    assert [row["dst"] for row in history.recent_renames()] == ["/a/nuevo.mkv"]


def test_without_a_database_it_degrades_instead_of_raising(tmp_path):
    history.close()

    history.record_rename("/a/x.mkv", "/a/y.mkv")  # no lanza

    assert history.recent_renames() == []
    assert not os.path.exists(tmp_path / "nada")
