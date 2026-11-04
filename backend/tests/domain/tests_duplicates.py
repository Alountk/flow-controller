"""Qué es un duplicado (S1/S2/S3/S7), decidido sin disco ni red.

La pantalla enseña pares y ofrece borrar, así que la parte que puede mentir es
justo esta: dos entradas con títulos distintos que son la misma película, o una
misma película en dos calidades que **no** es un duplicado. Eso se fija aquí.
"""

from domain.duplicates import duplicate_groups


def _movie(**overrides):
    movie = {
        "tmdb_id": 438631,
        "title": "Dune",
        "path": "/media/peliculas/Dune (2021)/Dune.2021.1080p.mkv",
        "quality": "Bluray-1080p",
        "has_file": True,
        "size_on_disk": 3_100_000_000,
    }
    movie.update(overrides)
    return movie


def test_two_files_of_the_same_tmdb_and_class_are_a_duplicate():
    groups = duplicate_groups([
        _movie(path="/media/a/Dune.2021.1080p.mkv"),
        _movie(path="/media/b/Dune.2021.1080p.mkv"),
    ])

    assert len(groups) == 1
    assert groups[0]["tmdb_id"] == 438631
    assert groups[0]["class"] == "1080"
    assert len(groups[0]["files"]) == 2


def test_the_same_pelicula_in_4k_and_1080_is_not_a_duplicate():
    """Decisión del usuario (L2): conviven a propósito."""
    groups = duplicate_groups([
        _movie(path="/media/peliculas/Dune.2021.1080p.mkv", quality="Bluray-1080p"),
        _movie(path="/media/peliculas4k/Dune.2021.2160p.mkv", quality="Remux-2160p"),
    ], path_3d="/media/peliculas3d")

    assert groups == []


def test_two_4k_files_of_the_same_pelicula_are_a_duplicate():
    groups = duplicate_groups([
        _movie(path="/media/4k/Dune.2021.2160p.mkv", quality="Remux-2160p"),
        _movie(path="/media/4k-otra/Dune.2021.2160p.mkv", quality="WEBDL-2160p"),
    ])

    assert len(groups) == 1 and groups[0]["class"] == "4K"


def test_the_size_never_decides():
    """S3: el tamaño se muestra para elegir, no se compara."""
    groups = duplicate_groups([
        _movie(path="/media/a/Dune.2021.1080p.mkv", size_on_disk=3_100_000_000),
        _movie(path="/media/b/Dune.2021.1080p.mkv", size_on_disk=900_000_000),
    ])

    assert len(groups) == 1
    assert [f["size"] for f in groups[0]["files"]] == [3_100_000_000, 900_000_000]


def test_different_tmdb_ids_are_different_peliculas_even_with_one_title():
    groups = duplicate_groups([
        _movie(tmdb_id=1, path="/media/a/Uno.mkv"),
        _movie(tmdb_id=2, path="/media/b/Uno.mkv"),
    ])

    assert groups == []


def test_a_missing_tmdb_id_is_not_a_match():
    """S7: ausente (0 o None) no es una coincidencia, es «no lo sé»."""
    for missing in (0, None, ""):
        groups = duplicate_groups([
            _movie(tmdb_id=missing, path="/media/a/Uno.mkv"),
            _movie(tmdb_id=missing, path="/media/b/Uno.mkv"),
        ])
        assert groups == [], f"tmdb_id={missing!r} no puede agrupar"


def test_a_movie_without_file_is_not_a_duplicate():
    groups = duplicate_groups([
        _movie(has_file=False, path="/media/a/Dune (2021)"),
        _movie(has_file=False, path="/media/b/Dune (2021)"),
    ])

    assert groups == []


def test_an_entry_without_path_cannot_be_deleted_so_it_is_not_listed():
    groups = duplicate_groups([
        _movie(path=""),
        _movie(path="/media/b/Dune.2021.1080p.mkv"),
    ])

    assert groups == []


def test_the_titles_are_the_ones_that_arrive_without_inventing_any():
    groups = duplicate_groups([
        _movie(path="/media/a/Dune.2021.1080p.mkv", titles=["Dune", "Дюна"]),
        _movie(path="/media/b/Dune.2021.1080p.mkv", titles=["Dune", "Dune: Part One"]),
    ])

    assert groups[0]["titles"] == ["Dune", "Дюна", "Dune: Part One"]


def test_a_group_survives_three_copies():
    groups = duplicate_groups([
        _movie(path="/media/a/x.mkv"),
        _movie(path="/media/b/x.mkv"),
        _movie(path="/media/c/x.mkv"),
    ])

    assert len(groups) == 1 and len(groups[0]["files"]) == 3


def test_nothing_to_say_is_an_empty_list():
    assert duplicate_groups([]) == []
    assert duplicate_groups([_movie()]) == []
