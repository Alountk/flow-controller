"""`prowlarr_search` — the text search «Buscar y descargar alternativa» runs (S6/T2).

The frozen probe findings of 2026-10-21 against the real Prowlarr ARE the
contract encoded below:

- `GET {url}/api/v1/search` with `X-Api-Key: {key}` and params
  `query=<term>&type=search`. The query MUST travel as a params MAPPING so
  aiohttp percent-encodes it — raw UTF-8/Cyrillic spliced into the URL is an
  instant HTTP 400 on the real service.
- NO `categories` filter, ever: NoNaMe Club reports custom category ids
  (100091…) and classes movies under TV/Other, so `categories=2000,2010`
  answered 0 while the unfiltered query answered 31 Russian releases. No
  `indexerIds` either (a REPEATED parameter in v1; T2 does not need it).
- The answer is a JSON array of releases (`title`, `indexer`, `size`,
  `seeders`, `guid`, `magnetUrl`, `downloadUrl`, …) normalized to snake_case;
  the download urls are included ONLY when non-null.
- Relevance filter: a release survives only when its TITLE contains at least
  one QUERY token that is not purely numeric and is >= 3 chars
  (case-insensitive) — the rule that drops dmhy's dozens of year-only matches
  while keeping «Артур и минипуты» for the query «Артур и минимоны».

Only the HTTP transport is faked (`_StubSession`), so the real function body
runs — same style as its transport twin `tests_arr_client.py`.
"""

import asyncio
from unittest.mock import patch

import aiohttp
import pytest

import config
from infrastructure import prowlarr_client
from tests._stubs import _StubSession

PROWLARR_URL = "http://prowlarr.test:9696"


def _service() -> dict:
    return {
        "key": "prowlarr",
        "kind": "prowlarr",
        "url": PROWLARR_URL,
        "api_key": "test-key",
    }


class _RecordingSession(_StubSession):
    """`_StubSession` that also records the request kwargs.

    The transport contract lives IN the kwargs — the params mapping (the
    encoding seam) and the `X-Api-Key` header — and `_StubSession.calls` only
    records the URL.
    """

    def __init__(self, routes=None):
        super().__init__(routes)
        self.requests: list[tuple[str, dict]] = []

    def get(self, url, **kwargs):
        self.requests.append((str(url), kwargs))
        return super().get(url, **kwargs)


def _session(payload, status: int = 200) -> _RecordingSession:
    return _RecordingSession({f"{PROWLARR_URL}/api/v1/search": (status, payload)})


def _search(query, payload=(), session=None, status=200):
    session = session if session is not None else _session(payload, status)
    with patch("config.find_service", return_value=_service()):
        result = asyncio.run(prowlarr_client.prowlarr_search(query, session=session))
    return result, session


#: Junk the real service answers for Cyrillic queries: year-only matches with
#: no query token anywhere in the title (probe: dmhy).
_JUNK_YEAR_ONLY = {
    "title": "[rutor] Случайный.Фильм.2006.HDTVRip",
    "indexer": "dmhy",
    "size": 700_000_000,
    "seeders": 3,
    "guid": "junk-1",
}
_JUNK_YEAR_ONLY_2 = {
    "title": "[KinoZal] Ещё.Один.2006.BDRip",
    "indexer": "dmhy",
    "size": 1_400_000_000,
    "seeders": 1,
    "guid": "junk-2",
}
#: A real hit: shares the token «Артур» with the query «Артур и минимоны».
_REAL = {
    "title": "Артур и минипуты (2006) BDRip",
    "indexer": "NoNaMe Club",
    "size": 2_000_000_000,
    "seeders": 42,
    "guid": "real-1",
    "magnetUrl": "magnet:?xt=urn:btih:abc123",
}


class TestTheTransportContract:
    """What the 2026-10-21 probe pinned about the wire format."""

    def test_the_search_is_a_v1_search_with_query_and_type_search(self):
        _result, session = _search("Артур и минимоны", payload=[])

        url, kwargs = session.requests[0]
        assert url == f"{PROWLARR_URL}/api/v1/search"
        assert kwargs["params"] == {"query": "Артур и минимоны", "type": "search"}

    def test_the_query_travels_as_a_params_mapping_so_aiohttp_percent_encodes_it(self):
        """Raw UTF-8 in the URL is an instant HTTP 400 on the real Prowlarr."""
        _result, session = _search("Артур и минимоны", payload=[])

        url, kwargs = session.requests[0]
        assert "?" not in url, "la query jamás debe ir codificada a mano en la URL"
        # Unencoded in the mapping: the HTTP lib owns the percent-encoding.
        assert kwargs["params"]["query"] == "Артур и минимоны"

    def test_the_api_key_travels_in_the_x_api_key_header(self):
        _result, session = _search("Arthur", payload=[])

        _url, kwargs = session.requests[0]
        assert kwargs["headers"]["X-Api-Key"] == "test-key"

    def test_no_categories_or_indexer_filters_are_ever_sent(self):
        """`categories=2000,2010` answered 0 releases where the bare query
        answered 31: NoNaMe Club's custom category ids make every category
        filter a silent empty result."""
        _result, session = _search("Arthur", payload=[])

        _url, kwargs = session.requests[0]
        assert set(kwargs["params"]) == {"query", "type"}

    def test_the_search_timeout_scales_with_request_timeout(self):
        """`arr_fetch_releases` scales `REQUEST_TIMEOUT` in multiples; this is
        the same indexer fan-out and the real probe took 3–20 s, so ×12 —
        60 s at the 5 s default, three times the worst probe."""
        _result, session = _search("Arthur", payload=[])

        _url, kwargs = session.requests[0]
        assert kwargs["timeout"].total == config.REQUEST_TIMEOUT * 12


class TestTheRelevanceFilter:
    """(b) year-only junk dies here; real hits survive."""

    def test_a_title_is_kept_only_when_it_shares_a_qualifying_query_token(self):
        result, _session = _search(
            "Артур и минимоны", payload=[_JUNK_YEAR_ONLY, _REAL, _JUNK_YEAR_ONLY_2]
        )

        assert [r["guid"] for r in result] == ["real-1"]

    def test_matching_is_case_insensitive(self):
        result, _session = _search(
            "ARTHUR", payload=[{"title": "arthur.and.the.invisibles.2006", "guid": "g"}]
        )

        assert [r["guid"] for r in result] == ["g"]

    def test_a_query_token_matches_inside_a_longer_word(self):
        """Russian morphology: «Артур» must keep «Артура и минипуты»."""
        result, _session = _search(
            "Артур", payload=[{"title": "Артура и минипуты (2006)", "guid": "g"}]
        )

        assert [r["guid"] for r in result] == ["g"]

    def test_short_and_numeric_query_tokens_do_not_qualify(self):
        """«и» (1 char) and «2006» (numeric) can never make a title relevant —
        this is exactly the drop that keeps dmhy's year-only answers out."""
        result, _session = _search("и 2006", payload=[_REAL])

        assert result == []


class TestNormalization:
    """(a) snake_case, and download urls only when there is one."""

    def test_releases_are_normalized_to_snake_case(self):
        result, _session = _search("Артур", payload=[_REAL])

        assert result == [
            {
                "title": "Артур и минипуты (2006) BDRip",
                "indexer": "NoNaMe Club",
                "size": 2_000_000_000,
                "seeders": 42,
                "guid": "real-1",
                "magnet_url": "magnet:?xt=urn:btih:abc123",
            }
        ]

    def test_null_download_urls_are_not_included(self):
        release = dict(_REAL, magnetUrl=None, downloadUrl=None)

        result, _session = _search("Артур", payload=[release])

        assert "magnet_url" not in result[0]
        assert "download_url" not in result[0]

    def test_a_download_url_is_included_when_there_is_one(self):
        release = dict(_REAL, magnetUrl=None, downloadUrl="http://prowlarr.test:9696/getnzb/1")

        result, _session = _search("Артур", payload=[release])

        assert result[0]["download_url"] == "http://prowlarr.test:9696/getnzb/1"
        assert "magnet_url" not in result[0]


class TestFailureAndConfiguration:
    """Fail closed: no config, no silent empty answer."""

    def test_without_prowlarr_config_the_search_says_no_esta_configurado(self):
        with patch("config.find_service", return_value=None):
            with pytest.raises(RuntimeError, match="no está configurado"):
                asyncio.run(
                    prowlarr_client.prowlarr_search("Arthur", session=_session([]))
                )

    def test_a_non_200_answer_raises_a_client_error(self):
        session = _session([], status=503)
        with patch("config.find_service", return_value=_service()):
            with pytest.raises(aiohttp.ClientError, match="HTTP 503"):
                asyncio.run(prowlarr_client.prowlarr_search("Arthur", session=session))

    def test_without_an_injected_session_the_client_opens_its_own(self):
        session = _session([_REAL])
        with patch("config.find_service", return_value=_service()), patch.object(
            prowlarr_client, "http_session", return_value=session
        ):
            result = asyncio.run(prowlarr_client.prowlarr_search("Артур"))

        assert [r["guid"] for r in result] == ["real-1"]
