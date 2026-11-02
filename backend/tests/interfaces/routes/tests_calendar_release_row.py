"""`_release_row`: the shape the modal renders, built from what the source said.

The never-lie rule of this module is narrow and absolute: a torrent's `seeders`
and aMule's `sources` are different magnitudes, and the row carries each under
its own name. Neither is ever converted into the other, and a source that
stated neither leaves both keys absent so the table paints «—» instead of a
zero nobody declared.
"""

from __future__ import annotations

from interfaces.http.routes import calendar as calendar_routes


def test_a_torrent_row_keeps_seeders_and_carries_no_sources():
    row = calendar_routes._release_row(
        {
            "source": "torznab",
            "name": "Alien.1979.1080p.BluRay.x264-GRP",
            "guid": "abc",
            "link": "magnet:?xt=urn:btih:abc",
            "size": 1024,
            "seeders": 42,
        }
    )

    assert row["seeders"] == 42
    assert "sources" not in row


def test_an_amule_row_carries_its_sources_and_never_becomes_seeders():
    row = calendar_routes._release_row(
        {
            "source": "amule",
            "name": "Alien.1979.1080p.BluRay.mkv",
            "guid": "f" * 32,
            "link": "ed2k://|file|Alien.1979.1080p.BluRay.mkv|1024|" + "f" * 32 + "|/",
            "size": 1024,
            "sources": 17,
        }
    )

    assert row["sources"] == 17
    assert "seeders" not in row


def test_a_row_that_declared_neither_keeps_both_keys_absent():
    row = calendar_routes._release_row(
        {"source": "torznab", "name": "Alien.1979.1080p.BluRay-GRP", "guid": "abc"}
    )

    assert "seeders" not in row
    assert "sources" not in row
