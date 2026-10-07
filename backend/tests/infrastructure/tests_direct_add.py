"""Direct-to-client downloads: link resolution, identity, and the add itself.

Option B of the routed-grab work: a release whose destination sits outside
every arr root goes STRAIGHT to aMuTorrent under this app's own category, so
the arr never tracks it and cannot import it over what the library already
holds (the 4K-replaces-1080p incident). These tests pin the three pieces that
make that possible, with only the HTTP transport faked.

Shape of the Torznab answer: standard RSS2 `<item>` with `<title>`, `<guid>`
and `<enclosure url>` — the documented contract of aMuTorrent's indexer
(INTEGRATIONS.MD: "Sonarr/Radarr sends the ED2K link to our
qBittorrent-compatible API" — we make both halves of that flow ourselves).
"""

import asyncio

from infrastructure import arr_client
from infrastructure.arr_client import (
    DIRECT_DOWNLOAD_CATEGORY,
    amutorrent_add_download,
    amutorrent_search_link,
    direct_link_identity,
)
from tests._stubs import _StubSession

AMUTORRENT_URL = arr_client.AMUTORRENT_URL

ED2K_LINK = (
    "ed2k://|file Your.Name.2016.1080p.BluRay.x264-GRP.mkv"
    "|8589934592|ABCDEF0123456789ABCDEF0123456789|/"
)

RSS = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>aMule Torznab</title>
    <item>
      <title>Your.Name.2016.1080p.BluRay.x264-GRP</title>
      <guid isPermaLink="false">torznab-your-name-1080p-bluray</guid>
      <enclosure url="{ED2K_LINK}" length="8589934592" type="application/x-bittorrent"/>
    </item>
    <item>
      <title>Other.Movie.2020.1080p.WEB.h264-GRP</title>
      <guid isPermaLink="false">torznab-other-movie</guid>
      <enclosure url="ed2k://|file Other.Movie.2020.1080p.WEB.h264-GRP.mkv|1000|00112233445566778899AABBCCDDEEFF|/" length="1000" type="application/x-bittorrent"/>
    </item>
  </channel>
</rss>"""


def _search(status: int = 200, payload: str = RSS) -> _StubSession:
    return _StubSession({f"{AMUTORRENT_URL}/indexer/amule/api": (status, payload)})


# ── Link resolution ───────────────────────────────────────────────────────


def test_the_release_title_finds_its_own_link():
    link = asyncio.run(amutorrent_search_link(_search(), "Your.Name.2016.1080p.BluRay.x264-GRP"))

    assert link == ED2K_LINK


def test_the_match_is_case_insensitive_but_never_fuzzy():
    link = asyncio.run(amutorrent_search_link(_search(), "your.name.2016.1080p.bluray.x264-grp"))

    assert link == ED2K_LINK
    # Close is not the item: a missing letter must not download something else.
    assert asyncio.run(amutorrent_search_link(_search(), "Your.Name.2016.1080p.BluRay.x264")) is None


def test_an_item_matched_by_guid_when_the_title_differs():
    session = _search(payload=RSS.replace(
        "<title>Your.Name.2016.1080p.BluRay.x264-GRP</title>",
        "<title>Release Renamed Upstream</title>",
    ))

    link = asyncio.run(amutorrent_search_link(session, "torznab-your-name-1080p-bluray"))

    assert link == ED2K_LINK


def test_no_matching_item_is_none_not_a_guess():
    assert asyncio.run(amutorrent_search_link(_search(), "Never.Seen.2024.2160p")) is None


def test_a_non_xml_answer_is_none():
    assert asyncio.run(amutorrent_search_link(_search(payload="<html>rate limited</html>"), "Any.Title")) is None


def test_an_http_error_is_none():
    assert asyncio.run(amutorrent_search_link(_search(status=500), "Any.Title")) is None


def test_an_unconfigured_client_is_none(monkeypatch):
    monkeypatch.setattr(arr_client, "AMUTORRENT_URL", "")

    assert asyncio.run(amutorrent_search_link(_search(), "Any.Title")) is None


# ── Identity of the link we are about to add ──────────────────────────────


def test_an_ed2k_link_carries_its_name_and_no_invented_hash():
    name, client_hash = direct_link_identity(ED2K_LINK, "fallback")

    assert name == "Your.Name.2016.1080p.BluRay.x264-GRP.mkv"
    # The link's hash is ED2K's, not the client's infohash — never store it.
    assert client_hash is None


def test_a_magnet_carries_dn_and_a_hex_btih():
    name, client_hash = direct_link_identity(
        "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Some+Movie+2024",
        "fallback",
    )

    assert name == "Some Movie 2024"
    assert client_hash == "0123456789abcdef0123456789abcdef01234567"


def test_a_magnet_without_dn_falls_back_to_the_release_title():
    name, _ = direct_link_identity(
        "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
        "Fallback.Title.2024",
    )

    assert name == "Fallback.Title.2024"


def test_an_unknown_scheme_keeps_the_title_and_no_hash():
    assert direct_link_identity("https://example.com/file.torrent", "Some.Title") == ("Some.Title", None)


# ── The add ───────────────────────────────────────────────────────────────


def test_a_successful_add_uses_our_category_and_creates_it_when_missing():
    session = _StubSession({
        f"{AMUTORRENT_URL}/api/v2/torrents/categories": (200, {}),
        f"{AMUTORRENT_URL}/api/v2/torrents/createCategories": (200, {}),
        f"{AMUTORRENT_URL}/api/v2/torrents/add": (200, {}),
    })

    result = asyncio.run(amutorrent_add_download(session, ED2K_LINK))

    assert result == {
        "ok": True,
        "detail": f"Descarga añadida (categoría {DIRECT_DOWNLOAD_CATEGORY})",
        "category": DIRECT_DOWNLOAD_CATEGORY,
    }
    urls = [u for u, _ in session.calls]
    assert any("torrents/createCategories" in u for u in urls)
    assert any("torrents/add" in u for u in urls)


def test_an_existing_category_is_not_created_again():
    session = _StubSession({
        f"{AMUTORRENT_URL}/api/v2/torrents/categories": (200, {DIRECT_DOWNLOAD_CATEGORY: {}}),
        f"{AMUTORRENT_URL}/api/v2/torrents/add": (200, {}),
    })

    asyncio.run(amutorrent_add_download(session, ED2K_LINK))

    assert not any("createCategories" in u for u, _ in session.calls)


def test_the_add_failure_is_returned_verbatim():
    session = _StubSession({
        f"{AMUTORRENT_URL}/api/v2/torrents/categories": (200, {}),
        f"{AMUTORRENT_URL}/api/v2/torrents/add": (400, "magnet no soportado"),
    })

    result = asyncio.run(amutorrent_add_download(session, "magnet:?xt=urn:btih:zz"))

    assert result["ok"] is False
    assert "HTTP 400" in result["detail"]


def test_direct_add_is_the_category_the_arr_never_polls():
    # The whole point of B: not `radarr`, not `tv-sonarr`.
    assert DIRECT_DOWNLOAD_CATEGORY == "flow"
