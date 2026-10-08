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
    _search_query,
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

# ── Link resolution ───────────────────────────────────────────────────────────

GUID_OK = "cb5e7b266fc735a77132e8cd4f7fbc19"

RSS = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>aMule Torznab</title>
    <item>
      <title>Spider-Man Brand New Day.(2026).Micro.4K.2160p.HDR10.DV.Dual.AC3.x.lagartish.mkv</title>
      <guid isPermaLink="false">{GUID_OK}</guid>
      <enclosure url="ed2k://|file Plain.Version.mkv|8219420878|ABCDEF0123456789ABCDEF0123456789|/" length="8219420878" type="application/x-bittorrent"/>
    </item>
    <item>
      <title>Spider-Man.Brand.New.Day.(2026).(Spanish.English.Subs).Micro4K.2160p.mkv</title>
      <guid isPermaLink="false">{GUID_OK}-c9ff6af3</guid>
      <enclosure url="ed2k://|file User.Version.mkv|8219420878|11112222333344445555666677778888|/" length="8219420878" type="application/x-bittorrent"/>
    </item>
  </channel>
</rss>"""

# Two DB rows sharing one guid (duplicate hashes happen): only the size the
# arr recorded can tell the release from the noise.
RSS_DUPLICATE_GUID = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>aMule Torznab</title>
    <item>
      <guid isPermaLink="false">{GUID_OK}</guid>
      <enclosure url="ed2k://|file Big.Version.mkv|8219420878|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA|/" length="8219420878" type="application/x-bittorrent"/>
    </item>
    <item>
      <guid isPermaLink="false">{GUID_OK}</guid>
      <enclosure url="ed2k://|file Small.Version.mkv|13753|BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB|/" length="13753" type="application/x-bittorrent"/>
    </item>
  </channel>
</rss>"""


def _search(status: int = 200, payload: str = RSS, query: str = "q") -> _StubSession:
    return _StubSession({f"{AMUTORRENT_URL}/indexer/amule/api": (status, payload)})


def _link(title="Spider-Man.Brand.New.Day.(2026).(Spanish.English.Subs).Micro4K.2160p.mkv",
          guid=GUID_OK, size=0):
    return asyncio.run(amutorrent_search_link(_search(), title, guid=guid, size=size))


def test_the_query_is_short_enough_for_the_ed2k_network_to_answer():
    # Measured against the live indexer: the full name times out (>40 s),
    # "Name Year" answers in ~30 s. The query must be the second one.
    assert _search_query(
        "Spider-Man.Brand.New.Day.(2026).(Spanish.English.Subs).Micro4K.2160p.HDR10.DV.x265.10Bits-AC3.by.lagartish.(hispashare.org).mkv"
    ) == "Spider-Man Brand New Day 2026"


def test_the_query_cuts_the_quality_tail_and_keeps_the_year():
    assert _search_query("Movie.2021.1080p.BluRay.x264-GRP.mkv") == "Movie 2021"
    assert _search_query("Some Indie Film Sequel") == "Some Indie Film Sequel"


def test_the_release_guid_finds_its_own_link():
    result = _link()

    assert result["ok"] is True
    assert "Plain.Version.mkv" in result["link"]


def test_a_suffixed_guid_matches_its_own_item():
    # Radarr hands out `<base>-<suffix>` ids; the suffixed item IS the release
    # it saw, and the exact guid picks it without any title in the picture.
    result = _link(guid=f"{GUID_OK}-c9ff6af3", size=8219420878)

    assert result["ok"] is True
    assert "User.Version.mkv" in result["link"]


def test_duplicate_guids_are_told_apart_by_the_size_the_arr_recorded():
    session = _StubSession({
        f"{AMUTORRENT_URL}/indexer/amule/api": (200, RSS_DUPLICATE_GUID),
    })
    result = asyncio.run(
        amutorrent_search_link(session, "Any.Title.2026.2160p", guid=GUID_OK, size=13753)
    )

    assert result["ok"] is True
    assert "Small.Version.mkv" in result["link"]


def test_a_guid_absent_from_the_results_is_an_honest_refusal():
    result = _link(guid="ffffffffffffffffffffffffffffffff")

    assert result["ok"] is False
    assert "No encontré" in result["detail"]
    assert "Biblioteca" in result["detail"]


def test_an_ed2k_guid_is_already_the_link_and_never_searches():
    session = _search()
    result = asyncio.run(
        amutorrent_search_link(session, "Any.Title", guid="ed2k://|file X.mkv|1|AA|/")
    )

    assert result == {"ok": True, "link": "ed2k://|file X.mkv|1|AA|/", "detail": "link del propio guid"}
    assert session.calls == [], "no network for a guid that IS the link"


def test_a_magnet_guid_is_already_the_link_too():
    magnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"
    result = asyncio.run(amutorrent_search_link(_search(), "Any.Title", guid=magnet))

    assert result == {"ok": True, "link": magnet, "detail": "link del propio guid"}


def test_a_web_guid_belongs_to_another_indexer_and_says_so():
    result = _link(guid="https://knaben.xyz/thepiratebay/description.php?id=84035091")

    assert result["ok"] is False
    assert "otro indexador" in result["detail"]
    assert "Biblioteca" in result["detail"]


def test_a_timeout_is_distinguished_from_no_results():
    session = _StubSession({
        f"{AMUTORRENT_URL}/indexer/amule/api": (0, asyncio.TimeoutError()),
    })
    result = asyncio.run(amutorrent_search_link(session, "Any.Title.2024.1080p", guid="abc"))

    assert result["ok"] is False
    assert "no respondió" in result["detail"]


def test_an_http_error_is_distinguished_from_no_results():
    result = _search(status=500)
    answer = asyncio.run(amutorrent_search_link(result, "Any.Title.2024", guid="abc"))

    assert answer["ok"] is False
    assert "HTTP 500" in answer["detail"]


def test_a_non_xml_answer_is_a_refusal():
    answer = asyncio.run(
        amutorrent_search_link(
            _search(payload="<html><body>rate limited"), "Any.Title", guid="abc"
        )
    )

    assert answer["ok"] is False
    assert "XML" in answer["detail"]


def test_an_unconfigured_client_is_a_refusal(monkeypatch):
    monkeypatch.setattr(arr_client, "AMUTORRENT_URL", "")

    answer = asyncio.run(amutorrent_search_link(_search(), "Any.Title", guid="abc"))

    assert answer["ok"] is False
    assert "configurado" in answer["detail"]


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
