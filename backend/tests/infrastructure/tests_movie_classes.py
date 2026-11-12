"""The movie ↔ class ↔ proving-file relation («release-chips» S4).

What the catalogue needs from this store: ONE batched read per page, a write
that replaces a movie's rows atomically, and «verificado sin clases» (the
sentinel row) distinguishable from «sin fila». Labels outside
`domain.library_class.RESOLUTIONS` are never persisted and never served.

Errors RAISE here — the route fails open around these helpers; a helper that
swallowed would make a dead store indistinguishable from "verified, nothing".
The one exception is the event seam (`invalidate_movie_classes_for`): a cache
invalidation must never fail the file operation that triggered it.
"""

import sqlite3

import pytest

from infrastructure import sqlite_history as history


@pytest.fixture
def db(tmp_path):
    """A fresh database per test, isolated from the real config volume."""
    history.close()
    history.init_db(tmp_path / "history.db")
    yield
    history.close()


def test_a_saved_mapping_round_trips(db):
    history.save_movie_classes(
        "/mnt/movies/Alien (1979)",
        {"4K": "/mnt/4k/Alien (1979) [4K]", "1080p": "/mnt/movies/Alien (1979)/Alien.mkv"},
        verified_at=100.0,
    )

    assert history.fetch_movie_classes(["/mnt/movies/Alien (1979)"]) == {
        "/mnt/movies/Alien (1979)": {
            "verified_at": 100.0,
            "files": {
                "4K": "/mnt/4k/Alien (1979) [4K]",
                "1080p": "/mnt/movies/Alien (1979)/Alien.mkv",
            },
        }
    }


def test_the_sentinel_row_is_verified_zero_classes_not_a_miss(db):
    history.save_movie_classes("/mnt/movies/Vacía (2020)", {}, verified_at=100.0)

    assert history.fetch_movie_classes(["/mnt/movies/Vacía (2020)"]) == {
        "/mnt/movies/Vacía (2020)": {"verified_at": 100.0, "files": {}}
    }


def test_a_path_without_rows_is_a_miss(db):
    assert history.fetch_movie_classes(["/mnt/movies/Nunca (1999)"]) == {}


def test_an_unknown_label_is_never_persisted(db):
    with pytest.raises(ValueError):
        history.save_movie_classes("/mnt/movies/A", {"8K": "/mnt/movies/A/8k.mkv"})

    assert history.fetch_movie_classes(["/mnt/movies/A"]) == {}


def test_the_sentinel_label_is_reserved_for_the_empty_mapping(db):
    with pytest.raises(ValueError):
        history.save_movie_classes("/mnt/movies/A", {"": "/mnt/movies/A/nada.mkv"})


def test_an_unknown_label_is_dropped_on_read(db, tmp_path):
    history.save_movie_classes(
        "/mnt/movies/A", {"1080p": "/mnt/movies/A/a.mkv"}, verified_at=100.0
    )
    conn = sqlite3.connect(tmp_path / "history.db")
    conn.execute(
        "INSERT INTO movie_classes VALUES ('/mnt/movies/A', '8K', '/mnt/movies/A/8k.mkv', 100.0)"
    )
    conn.commit()
    conn.close()

    got = history.fetch_movie_classes(["/mnt/movies/A"])

    assert got["/mnt/movies/A"]["files"] == {"1080p": "/mnt/movies/A/a.mkv"}


def test_a_save_replaces_the_movies_rows_and_a_stale_label_disappears(db):
    history.save_movie_classes(
        "/mnt/movies/A",
        {"4K": "/mnt/4k/A [4K]", "SD": "/mnt/movies/A/sd.mkv"},
        verified_at=100.0,
    )
    history.save_movie_classes(
        "/mnt/movies/A", {"1080p": "/mnt/movies/A/a.mkv"}, verified_at=200.0
    )

    assert history.fetch_movie_classes(["/mnt/movies/A"]) == {
        "/mnt/movies/A": {
            "verified_at": 200.0,
            "files": {"1080p": "/mnt/movies/A/a.mkv"},
        }
    }


def test_one_batch_answers_every_path_in_a_single_call(db):
    history.save_movie_classes(
        "/mnt/movies/A", {"1080p": "/mnt/movies/A/a.mkv"}, verified_at=1.0
    )
    history.save_movie_classes("/mnt/movies/B", {}, verified_at=2.0)

    got = history.fetch_movie_classes(["/mnt/movies/A", "/mnt/movies/B", "/mnt/movies/C"])

    assert set(got) == {"/mnt/movies/A", "/mnt/movies/B"}
    assert got["/mnt/movies/B"] == {"verified_at": 2.0, "files": {}}


def test_a_broken_store_raises_instead_of_answering(db, tmp_path):
    conn = sqlite3.connect(tmp_path / "history.db")
    conn.execute("DROP TABLE movie_classes")
    conn.commit()
    conn.close()

    with pytest.raises(sqlite3.Error):
        history.fetch_movie_classes(["/mnt/movies/A"])
    with pytest.raises(sqlite3.Error):
        history.save_movie_classes("/mnt/movies/A", {"1080p": "/mnt/movies/A/a.mkv"})


def test_helpers_raise_when_the_store_is_unavailable(tmp_path):
    history.close()

    with pytest.raises(sqlite3.Error):
        history.fetch_movie_classes(["/mnt/movies/A"])
    with pytest.raises(sqlite3.Error):
        history.save_movie_classes("/mnt/movies/A", {"1080p": "/mnt/movies/A/a.mkv"})


# ── T8: event invalidation (L7 «eventos») ───────────────────────────────────
#
# Whole movies only, never a single label row: a partial row would read later
# as «verified, that class is absent» and blank a chip.


def _movie_ab():
    history.save_movie_classes(
        "/m/A (2020)",
        {"1080p": "/m/A (2020)/a.mkv", "4K": "/4k/A (2020)"},
        verified_at=100.0,
    )
    history.save_movie_classes(
        "/m/B (2021)", {"1080p": "/m/B (2021)/b.mkv"}, verified_at=100.0
    )


_SURVIVOR = {"/m/B (2021)": {"verified_at": 100.0, "files": {"1080p": "/m/B (2021)/b.mkv"}}}


def test_touching_a_file_inside_the_movie_folder_drops_every_row_of_that_movie(db):
    _movie_ab()

    history.invalidate_movie_classes_for("/m/A (2020)/a.mkv")

    assert history.fetch_movie_classes(["/m/A (2020)", "/m/B (2021)"]) == _SURVIVOR


def test_touching_the_movie_folder_itself_drops_it(db):
    _movie_ab()

    history.invalidate_movie_classes_for("/m/A (2020)")

    assert history.fetch_movie_classes(["/m/A (2020)", "/m/B (2021)"]) == _SURVIVOR


def test_touching_a_file_under_a_cited_copy_drops_the_movie(db):
    _movie_ab()

    history.invalidate_movie_classes_for("/4k/A (2020)/x.mkv")

    assert history.fetch_movie_classes(["/m/A (2020)", "/m/B (2021)"]) == _SURVIVOR


def test_a_new_entry_named_after_the_folder_drops_the_movie(db):
    _movie_ab()

    history.invalidate_movie_classes_for("/4k/A (2020).mkv")

    assert history.fetch_movie_classes(["/m/A (2020)", "/m/B (2021)"]) == _SURVIVOR


def test_an_unrelated_path_drops_nothing(db):
    _movie_ab()

    history.invalidate_movie_classes_for("/m/C (1999)/c.mkv")

    assert history.fetch_movie_classes(["/m/A (2020)", "/m/B (2021)"]) == {
        "/m/A (2020)": {
            "verified_at": 100.0,
            "files": {"1080p": "/m/A (2020)/a.mkv", "4K": "/4k/A (2020)"},
        },
        **_SURVIVOR,
    }


def test_an_ancestor_touch_drops_every_movie_under_it(db):
    _movie_ab()

    history.invalidate_movie_classes_for("/m")

    assert history.fetch_movie_classes(["/m/A (2020)", "/m/B (2021)"]) == {}


def test_a_sentinel_only_movie_is_dropped_too(db):
    history.save_movie_classes("/m/V (2020)", {}, verified_at=100.0)
    history.save_movie_classes("/m/W (2019)", {}, verified_at=100.0)

    history.invalidate_movie_classes_for("/m/V (2020)/extra.mkv")
    history.invalidate_movie_classes_for("/4k/W (2019) [4K]")

    assert history.fetch_movie_classes(["/m/V (2020)", "/m/W (2019)"]) == {}


def test_the_event_helper_never_raises_when_the_store_is_closed(db):
    _movie_ab()
    history.close()

    assert history.invalidate_movie_classes_for("/m/A (2020)") is None


@pytest.mark.parametrize("boom", [sqlite3.Error, OSError])
def test_the_event_helper_never_raises_on_a_broken_store(db, monkeypatch, boom):
    _movie_ab()

    class _Broken:
        def execute(self, *args, **kwargs):
            raise boom("store rota")

    monkeypatch.setattr(history, "_conn", _Broken())

    assert history.invalidate_movie_classes_for("/m/A (2020)") is None


def test_the_invalidation_primitive_raises_when_the_store_is_unavailable(tmp_path):
    history.close()

    with pytest.raises(sqlite3.Error):
        history.invalidate_movie_classes("/m/A (2020)")
