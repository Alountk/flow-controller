"""`torznab_caps` / `torznab_search` — the direct Torznab client (S1/T2).

The contract encoded below comes from `odd/tasks/indexadores-directos.md` S1:

- Transport is the `prowlarr_client.py` mold: `url` and `api_key` arrive as
  ARGUMENTS (rows of the `indexers` table — no config lookup in this task),
  the `session` seam falls back to `state.http_session()`, the timeout scales
  `REQUEST_TIMEOUT × 12`, and `params=` is load-bearing: the query travels as
  a params MAPPING so aiohttp percent-encodes UTF-8 (raw Cyrillic spliced
  into the URL is an instant HTTP 400 — lesson #218).
- Failures raise `aiohttp.ClientError`: non-200 answers carry the body, and
  a body that is not XML is the same kind of failure.
- Parsing is RSS 2.0 with `ElementTree` (the `arr_client.py:1108-1130`
  precedent): `item/enclosure@url|@length`, `guid`, `title`, `pubDate`, and
  `torznab:attr` name/value pairs (`seeders`, `size`, `infohash`) in the
  `http://torznab.com/schemas/2015/feed` namespace. Rows are normalized to
  `{title, link, guid, size, seeders, infohash, published}` with ints and
  `None` for whatever is missing.
- NO fixed category ids ever (NoNaMe uses 100xxx): `cat=` travels ONLY when
  the caller explicitly passes `cats`.
- Query shaping mirrors `arr_client._search_query` byte-for-byte (the
  `arr_client.py:1028-1046` precedent) as a private helper.

Only the HTTP transport is faked (`_StubSession`), so the real function body
runs — same style as its transport twin `tests_prowlarr_client.py`. Never a
real network, never a real key.
"""

import asyncio

import aiohttp
import pytest

import config
from infrastructure import torznab_client
from infrastructure.torznab_client import _search_query, torznab_caps, torznab_search
from tests._stubs import _StubSession

TORZNAB_URL = "http://indexer.test/torznab/api"
API_KEY = "test-key"


class _RecordingSession(_StubSession):
    """`_StubSession` that also records the request kwargs.

    The transport contract lives IN the kwargs — the params mapping is the
    percent-encoding seam and the whole wire format — and `_StubSession.calls`
    only records the URL.
    """

    def __init__(self, routes=None):
        super().__init__(routes)
        self.requests: list[tuple[str, dict]] = []

    def get(self, url, **kwargs):
        self.requests.append((str(url), kwargs))
        return super().get(url, **kwargs)


def _session(payload: str, status: int = 200) -> _RecordingSession:
    return _RecordingSession({TORZNAB_URL: (status, payload)})


# ── Inline fixtures ───────────────────────────────────────────────────────────

#: `t=caps`: searches with their `supportedParams`, categories with subcats.
#: NoNaMe's custom 100xxx ids are exactly why nothing may hardcode categories.
CAPS_XML = """<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server version="1.1" title="Test Indexer" />
  <limits max="100" default="50" />
  <searching>
    <search available="yes" supportedParams="q" />
    <tv-search available="yes" supportedParams="q,season,ep" />
    <movie-search available="no" supportedParams="q" />
    <audio-search available="no" />
    <book-search available="no" />
  </searching>
  <categories>
    <category id="2000" name="Movies">
      <subcat id="2040" name="Movies/HD" />
      <subcat id="2050" name="Movies/BluRay" />
    </category>
    <category id="100101" name="NoNaMe/Películas" />
    <category id="5000" name="TV">
      <subcat id="5040" name="TV/HD" />
    </category>
  </categories>
</caps>"""

#: RSS 2.0 with `torznab:attr` — the real answer shape of a search.
RSS_XML = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>Test Indexer</title>
    <item>
      <title>Артур и минипуты (2006) BDRip</title>
      <guid isPermaLink="false">abc123</guid>
      <pubDate>Mon, 01 Jan 2024 12:00:00 +0000</pubDate>
      <enclosure url="http://indexer.test/getnzb/abc123" length="2000000000" type="application/x-bittorrent"/>
      <torznab:attr name="seeders" value="42"/>
      <torznab:attr name="size" value="2000000000"/>
      <torznab:attr name="infohash" value="ABCDEF0123456789ABCDEF0123456789ABCDEF01"/>
    </item>
    <item>
      <title>Attr.Only.Item</title>
      <guid>guid-2</guid>
      <torznab:attr name="size" value="13753"/>
      <torznab:attr name="seeders" value="0"/>
      <torznab:attr name="infohash" value="FFFF0123456789ABCDEF0123456789ABCDEF0123"/>
    </item>
    <item>
      <title>Magnet.Item</title>
      <guid>guid-3</guid>
      <enclosure url="magnet:?xt=urn:btih:cafe0123" type="application/x-bittorrent"/>
      <torznab:attr name="infohash" value="cafe0123"/>
    </item>
  </channel>
</rss>"""

RSS_EMPTY = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Indexer</title>
  </channel>
</rss>"""

CAPS_EMPTY = """<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server version="1.1" title="Test Indexer" />
</caps>"""


# ── t=caps ────────────────────────────────────────────────────────────────────


class TestCapsParsing:
    """Autodiscovery: what the indexers table must record per indexer."""

    def test_categories_include_subcats_as_plain_id_name_rows(self):
        caps = asyncio.run(torznab_caps(TORZNAB_URL, API_KEY, session=_session(CAPS_XML)))

        assert caps["categories"] == [
            {"id": 2000, "name": "Movies"},
            {"id": 2040, "name": "Movies/HD"},
            {"id": 2050, "name": "Movies/BluRay"},
            {"id": 100101, "name": "NoNaMe/Películas"},
            {"id": 5000, "name": "TV"},
            {"id": 5040, "name": "TV/HD"},
        ]

    def test_searches_report_availability_and_supported_params(self):
        caps = asyncio.run(torznab_caps(TORZNAB_URL, API_KEY, session=_session(CAPS_XML)))

        assert caps["searches"] == {
            "search": {"available": True, "supported_params": ["q"]},
            "tv-search": {"available": True, "supported_params": ["q", "season", "ep"]},
            "movie-search": {"available": False, "supported_params": ["q"]},
            "audio-search": {"available": False, "supported_params": []},
            "book-search": {"available": False, "supported_params": []},
        }

    def test_caps_without_searching_or_categories_answer_empty_shapes(self):
        caps = asyncio.run(torznab_caps(TORZNAB_URL, API_KEY, session=_session(CAPS_EMPTY)))

        assert caps == {"searches": {}, "categories": []}

    def test_the_caps_request_is_t_caps_with_the_apikey_as_query_param(self):
        session = _session(CAPS_XML)
        asyncio.run(torznab_caps(TORZNAB_URL, API_KEY, session=session))

        url, kwargs = session.requests[0]
        assert url == TORZNAB_URL
        assert kwargs["params"] == {"t": "caps", "apikey": API_KEY}


# ── t=search parsing ──────────────────────────────────────────────────────────


class TestSearchParsing:
    """RSS 2.0 items normalized to the row shape S4 consumes."""

    def _rows(self, payload=RSS_XML, **kwargs):
        session = _session(payload)
        kwargs.setdefault("query", "q")
        rows = asyncio.run(
            torznab_search(TORZNAB_URL, API_KEY, session=session, **kwargs)
        )
        return rows, session

    def test_enclosure_guid_title_and_pubdate_become_the_row(self):
        rows, _session_ = self._rows()

        assert rows[0] == {
            "title": "Артур и минипуты (2006) BDRip",
            "link": "http://indexer.test/getnzb/abc123",
            "guid": "abc123",
            "size": 2_000_000_000,
            "seeders": 42,
            "infohash": "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
            "published": "Mon, 01 Jan 2024 12:00:00 +0000",
        }

    def test_torznab_attrs_supply_size_and_seeders_as_ints(self):
        """No enclosure at all: `size`/`seeders` come from the attrs, ints."""
        rows, _session_ = self._rows()

        assert rows[1] == {
            "title": "Attr.Only.Item",
            "link": None,
            "guid": "guid-2",
            "size": 13_753,
            "seeders": 0,
            "infohash": "FFFF0123456789ABCDEF0123456789ABCDEF0123",
            "published": None,
        }

    def test_missing_values_are_none_and_the_row_shape_never_changes(self):
        rows, _session_ = self._rows()

        assert all(set(row) == {"title", "link", "guid", "size", "seeders", "infohash", "published"} for row in rows)

    def test_a_literal_magnet_link_passes_through_and_nothing_is_expanded(self):
        """Download/infohash templates are never expanded: the only magnet is
        the one already literal in the feed."""
        rows, _session_ = self._rows()

        assert rows[2]["link"] == "magnet:?xt=urn:btih:cafe0123"
        assert rows[2]["size"] is None
        assert rows[0]["link"] == "http://indexer.test/getnzb/abc123", (
            "el infohash jamás se convierte en magnet"
        )

    def test_an_empty_feed_is_an_empty_list(self):
        rows, _session_ = self._rows(RSS_EMPTY)

        assert rows == []


# ── transport contract ────────────────────────────────────────────────────────


class TestTheTransportContract:
    """The `prowlarr_client.py` mold, with `url`/`api_key` as arguments."""

    def test_the_query_travels_as_a_params_mapping_so_aiohttp_percent_encodes_it(self):
        session = _session(RSS_EMPTY)
        asyncio.run(
            torznab_search(TORZNAB_URL, API_KEY, query="Артур и минимоны", session=session)
        )

        url, kwargs = session.requests[0]
        assert "?" not in url, "la query jamás debe ir codificada a mano en la URL"
        # Unencoded in the mapping: the HTTP lib owns the percent-encoding.
        assert kwargs["params"]["q"] == "Артур и минимоны"

    def test_the_request_is_t_search_with_q_and_apikey(self):
        session = _session(RSS_EMPTY)
        asyncio.run(torznab_search(TORZNAB_URL, API_KEY, query="Arthur", session=session))

        _url, kwargs = session.requests[0]
        assert kwargs["params"] == {"t": "search", "q": "Arthur", "apikey": API_KEY}

    def test_the_t_parameter_reaches_the_wire_verbatim(self):
        session = _session(RSS_EMPTY)
        asyncio.run(
            torznab_search(
                TORZNAB_URL, API_KEY, query="Arthur", t="tvsearch", session=session
            )
        )

        _url, kwargs = session.requests[0]
        assert kwargs["params"]["t"] == "tvsearch"

    def test_no_cat_parameter_ever_travels_unless_the_caller_passes_cats(self):
        """NoNaMe's custom 100xxx ids: a hardcoded category filter answers 0
        releases on real indexers (the frozen probe of `prowlarr_client`)."""
        session = _session(RSS_EMPTY)
        asyncio.run(torznab_search(TORZNAB_URL, API_KEY, query="Arthur", session=session))

        _url, kwargs = session.requests[0]
        assert "cat" not in kwargs["params"]

    def test_cats_travel_as_a_comma_joined_cat_parameter_when_explicitly_passed(self):
        session = _session(RSS_EMPTY)
        asyncio.run(
            torznab_search(
                TORZNAB_URL, API_KEY, query="Arthur", cats=[2000, 2040], session=session
            )
        )

        _url, kwargs = session.requests[0]
        assert kwargs["params"]["cat"] == "2000,2040"

    def test_the_search_timeout_scales_with_request_timeout(self):
        """Same indexer fan-out as `arr_fetch_releases`/`prowlarr_search`: ×12."""
        session = _session(RSS_EMPTY)
        asyncio.run(torznab_search(TORZNAB_URL, API_KEY, query="Arthur", session=session))

        _url, kwargs = session.requests[0]
        assert kwargs["timeout"].total == config.REQUEST_TIMEOUT * 12

    def test_without_an_injected_session_the_client_opens_its_own(self):
        from unittest.mock import patch

        session = _session(RSS_XML)
        with patch.object(torznab_client, "http_session", return_value=session):
            rows = asyncio.run(torznab_search(TORZNAB_URL, API_KEY, query="Артур"))

        assert [r["guid"] for r in rows] == ["abc123", "guid-2", "guid-3"]


# ── failures ──────────────────────────────────────────────────────────────────


class TestFailures:
    """No silent empty answers: transport/parse failures raise."""

    def test_a_non_200_search_answer_raises_a_client_error_with_the_body(self):
        session = _session("indexer exploded", status=503)
        with pytest.raises(aiohttp.ClientError, match="HTTP 503") as excinfo:
            asyncio.run(torznab_search(TORZNAB_URL, API_KEY, query="q", session=session))

        assert "indexer exploded" in str(excinfo.value)

    def test_a_non_200_caps_answer_raises_a_client_error_with_the_body(self):
        session = _session("indexer exploded", status=502)
        with pytest.raises(aiohttp.ClientError, match="HTTP 502") as excinfo:
            asyncio.run(torznab_caps(TORZNAB_URL, API_KEY, session=session))

        assert "indexer exploded" in str(excinfo.value)

    def test_a_search_body_that_is_not_xml_raises_a_client_error(self):
        session = _session("<html>login required</html> not xml")
        with pytest.raises(aiohttp.ClientError, match="invalid XML"):
            asyncio.run(torznab_search(TORZNAB_URL, API_KEY, query="q", session=session))

    def test_a_caps_body_that_is_not_xml_raises_a_client_error(self):
        session = _session("this is not XML at all")
        with pytest.raises(aiohttp.ClientError, match="invalid XML"):
            asyncio.run(torznab_caps(TORZNAB_URL, API_KEY, session=session))


# ── query shaping ─────────────────────────────────────────────────────────────


class TestSearchQueryShaping:
    """Mirror of `arr_client._search_query` (`arr_client.py:1028-1046`)."""

    def test_the_query_is_short_enough_for_the_network_to_answer(self):
        assert _search_query(
            "Spider-Man.Brand.New.Day.(2026).(Spanish.English.Subs).Micro4K.2160p."
            "HDR10.DV.x265.10Bits-AC3.by.lagartish.(hispashare.org).mkv"
        ) == "Spider-Man Brand New Day 2026"

    def test_the_query_cuts_the_quality_tail_and_keeps_the_year(self):
        assert _search_query("Movie.2021.1080p.BluRay.x264-GRP.mkv") == "Movie 2021"
        assert _search_query("Some Indie Film Sequel") == "Some Indie Film Sequel"

    def test_the_token_cap_keeps_eight_tokens_including_the_year(self):
        assert _search_query("One Two Three Four Five Six Seven (2020)") == (
            "One Two Three Four Five Six Seven 2020"
        )
        assert _search_query("One Two Three Four Five Six Seven Eight Nine") == (
            "One Two Three Four Five Six Seven Eight"
        )
        # Mirror quirk kept byte-for-byte: the appended year sits AFTER the
        # head tokens, so a head that already fills the cap slices it away.
        assert _search_query("One Two Three Four Five Six Seven Eight (2020)") == (
            "One Two Three Four Five Six Seven Eight"
        )
