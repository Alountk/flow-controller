"""`POST /api/indexers/search` — the unified parallel search («indexadores-directos» T4/S4).

One query fans out over the three sources AT ONCE — the enabled Torznab rows
of the `indexers` table, `prowlarr_search` and `gateways.amule_search` — and
merges them into one normalized shape. What these pin down:

* `{"query", "sources?"}`: empty/whitespace query is 400 like the
  language-search request models; an unknown source is 400 (a typo must never
  silently widen or narrow the search); `sources` absent, null or EMPTY is the
  documented default of all three;
* one source's failure or absence NEVER discards another's results: the answer
  is `{"ok", "results", "skipped"}` and the failing source is named in
  `skipped` with an honest Spanish reason — «sin indexadores habilitados»,
  the shared `service_unavailable_reason`, or the exception's short
  `Tipo: mensaje` text. Never a raw traceback, never an api_key (the probe's
  `_redact` rule reaches the search too);
* every selected source failing is `ok:false` + a `detail` summary — HTTP 200
  like every other honest refusal in this repo (S3: «200 con ok:false en
  fallo»), never a silent `[]` dressed up as «sin resultados»;
* disabled rows are never queried and, alone, answer «sin indexadores
  habilitados» — never an empty success; an undecryptable api_key (`None`,
  a rotated `FC_SECRET`) is skipped by name and NEVER sent;
* the frozen #218 relevance rule is mirrored byte-identically from
  `prowlarr_client._query_tokens`/`_is_relevant` (interfaces may not import
  infrastructure): a row survives only when its name contains at least one
  QUERY token that is not purely numeric and is >= 3 chars, case-insensitive;
* aMule's `sources` count is NEVER aliased into `seeders` — different
  magnitudes, and this repo does not lie about data.

No real network (the Torznab adapter seam, the gateways seams and the HTTP
session are all stubbed), no real keys: `FAKE_KEY` is obviously fake and the
tests assert it never leaks into a response.
"""

import asyncio
from contextlib import asynccontextmanager, contextmanager
from unittest.mock import patch

import aiohttp
import pytest
from fastapi.testclient import TestClient

from app import app
from application import gateways
from infrastructure import sqlite_history as history
from infrastructure.amule_ec_client import SearchResult
from interfaces.http.routes import indexers as indexers_routes

client = TestClient(app, raise_server_exceptions=False)

FAKE_KEY = "FAKE-KEY-do-not-use-9876"
URL_A = "http://indexer-a.test/torznab/api"
URL_B = "http://indexer-b.test/torznab/api"

_PROWLARR_SERVICE = {
    "key": "prowlarr",
    "kind": "prowlarr",
    "url": "http://prowlarr.test:9696",
    "api_key": "test-key",
}

#: The shared «no está configurado» reasons the seams raise as `RuntimeError`.
PROWLARR_REASON = "prowlarr no está configurado (faltan la URL o la API key)"
AMULE_REASON = "amule no está configurado (faltan la URL o la API key)"

TITLE = "Артур и минипуты (2006) BDRip"
HASH32 = "0123456789abcdef0123456789abcdef"


@pytest.fixture
def store(tmp_path):
    """A fresh history database, isolated from the real config volume."""
    history.close()
    history.init_db(tmp_path / "history.db")
    yield history
    history.close()


# ── seams ────────────────────────────────────────────────────────────────────


class _TorznabStub:
    """The injected adapter's search seam — records calls, never networks.

    `answers` maps url -> normalized T2 rows; `errors` maps url -> the
    exception that indexer answers with.
    """

    def __init__(self, answers=None, errors=None):
        self.answers = answers or {}
        self.errors = errors or {}
        self.calls = []

    async def torznab_search(
        self, url, api_key, *, query, cats=None, t="search", session=None
    ):
        self.calls.append({"url": url, "api_key": api_key, "query": query})
        if url in self.errors:
            raise self.errors[url]
        return self.answers.get(url, [])


@contextmanager
def _torznab(stub):
    with patch.object(indexers_routes, "torznab", stub):
        yield stub


@asynccontextmanager
async def _fake_http_session(*args, **kwargs):
    yield object()


@contextmanager
def _prowlarr(answer=None, error=None, configured=True):
    """The `gateways.prowlarr_search` seam plus the service gate."""
    calls = []

    async def search(query, session=None):
        calls.append(query)
        if error is not None:
            raise error
        return list(answer or [])

    with (
        patch.object(
            indexers_routes,
            "find_service",
            return_value=_PROWLARR_SERVICE if configured else None,
        ),
        patch.object(indexers_routes, "http_session", _fake_http_session),
        patch.object(gateways, "prowlarr_search", search),
    ):
        yield calls


@contextmanager
def _amule(answer=None, error=None):
    """The `gateways.amule_search` seam — sync, the route must thread it."""
    calls = []

    def search(query):
        calls.append(query)
        if error is not None:
            raise error
        return list(answer or [])

    with patch.object(gateways, "amule_search", search):
        yield calls


# ── row builders ─────────────────────────────────────────────────────────────


def _torznab_raw(title=TITLE, **extra):
    row = {
        "title": title,
        "link": None,
        "guid": None,
        "size": None,
        "seeders": None,
        "infohash": None,
        "published": None,
    }
    row.update(extra)
    return row


def _prowlarr_raw(title=TITLE, **extra):
    row = {
        "title": title,
        "indexer": "NoNaMe Club",
        "size": 2_000_000_000,
        "seeders": 42,
        "guid": "pr-1",
    }
    row.update(extra)
    return row


def _amule_raw(name=TITLE, **extra):
    row = {
        "name": name,
        "size": 2_000_000_000,
        "file_hash": HASH32,
        "sources": 7,
    }
    row.update(extra)
    return _search_result(row)


def _search_result(values: dict) -> SearchResult:
    """A real `SearchResult` record (the adapter's contract, not a copy)."""
    return SearchResult(
        name=values["name"],
        size=values["size"],
        file_hash=values["file_hash"],
        sources=values["sources"],
        sources_xfer=values.get("sources_xfer", 2),
        status=values.get("status", 0),
    )


def _seed(name, url, api_key=FAKE_KEY, **extra):
    return history.indexer_create(name, url, api_key, **extra)


def _search(body):
    return client.post("/api/indexers/search", json=body)


# ── the contract's guards ────────────────────────────────────────────────────


class TestValidation:
    """(a) the body contract: 400s are the caller's, in the repo's shape."""

    def test_missing_query_is_400(self, store):
        resp = _search({"sources": ["torznab"]})

        assert resp.status_code == 400
        assert resp.json() == {"detail": "query is required"}

    def test_blank_query_is_400(self, store):
        resp = _search({"query": "   "})

        assert resp.status_code == 400
        assert resp.json() == {"detail": "query is required"}

    def test_an_unknown_source_is_400_naming_it(self, store):
        resp = _search({"query": "Артур", "sources": ["torznab", "gnutella"]})

        assert resp.status_code == 400
        assert "gnutella" in resp.json()["detail"]

    def test_sources_must_be_a_list(self, store):
        resp = _search({"query": "Артур", "sources": "torznab"})

        assert resp.status_code == 400

    def test_a_blank_sources_list_is_the_default_of_all_three(self, store):
        """Pinned decision: absent, null and `[]` all mean «no filter» —
        a zero-source search is a mode the contract does not define."""
        _seed("Indexador A", URL_A)
        stub = _TorznabStub(
            answers={URL_A: [_torznab_raw(title="Arthur 2006", guid="t-1", size=1)]},
        )
        with (
            _torznab(stub),
            _prowlarr(answer=[_prowlarr_raw(guid="p-1", size=2, title="Arthur 2006")]),
            _amule(answer=[_amule_raw(name="Arthur 2006")]),
        ):
            for body in ({"query": "Arthur"}, {"query": "Arthur", "sources": []}):
                resp = _search(body)

                assert resp.status_code == 200, resp.text
                assert [row["source"] for row in resp.json()["results"]] == [
                    "torznab",
                    "amule",
                    "prowlarr",
                ]

    def test_the_search_is_behind_the_api_key(self, store):
        with patch("infrastructure.settings_store.auth_required", return_value=True):
            resp = _search({"query": "Артур"})

        assert resp.status_code == 401


# ── merged parallel happy path ───────────────────────────────────────────────


class TestTheMergedSearch:
    """(b) one round, three sources, one normalized shape."""

    def test_the_happy_path_merges_every_source_in_canonical_order(self, store):
        _seed("Indexador A", URL_A)
        stub = _TorznabStub(
            answers={
                URL_A: [
                    _torznab_raw(
                        guid="abc123",
                        link="http://indexer-a.test/get/1.torrent",
                        size=2_000_000_000,
                        seeders=42,
                        infohash="ffff",
                        published="Mon, 01 Jan 2026",
                    )
                ]
            }
        )
        amule_answer = [_amule_raw()]
        prowlarr_answer = [
            _prowlarr_raw(magnet_url="magnet:?xt=urn:btih:abc123"),
        ]
        with (
            _torznab(stub),
            _amule(answer=amule_answer),
            _prowlarr(answer=prowlarr_answer),
        ):
            resp = _search({"query": "Артур и минимоны"})

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert set(body) == {"ok", "results", "skipped"}
        assert body["ok"] is True
        assert body["skipped"] == []
        assert body["results"] == [
            {
                "source": "torznab",
                "indexer": "Indexador A",
                "name": TITLE,
                "size": 2_000_000_000,
                "seeders": 42,
                "infohash": "ffff",
                "link": "http://indexer-a.test/get/1.torrent",
                "guid": "abc123",
            },
            {
                "source": "amule",
                "name": TITLE,
                "size": 2_000_000_000,
                "sources": 7,
                "guid": HASH32,
                "link": f"ed2k://|file|{TITLE}|2000000000|{HASH32}|/",
            },
            {
                "source": "prowlarr",
                "indexer": "NoNaMe Club",
                "name": TITLE,
                "size": 2_000_000_000,
                "seeders": 42,
                "guid": "pr-1",
                "link": "magnet:?xt=urn:btih:abc123",
            },
        ]
        # Every source really got the query, in parallel, and Torznab got the
        # row's raw key (the call path) without it ever reaching the answer.
        assert stub.calls == [
            {"url": URL_A, "api_key": FAKE_KEY, "query": "Артур и минимоны"}
        ]
        assert FAKE_KEY not in resp.text

    def test_a_source_subset_only_touches_the_selected_sources(self, store):
        _seed("Indexador A", URL_A)
        stub = _TorznabStub(answers={URL_A: [_torznab_raw(guid="t-1", size=1)]})
        with (
            _torznab(stub),
            _amule(answer=[_amule_raw()]) as amule_calls,
            _prowlarr(answer=[_prowlarr_raw()]) as prowlarr_calls,
        ):
            resp = _search({"query": "Артур", "sources": ["torznab"]})

        body = resp.json()
        assert [row["source"] for row in body["results"]] == ["torznab"]
        assert amule_calls == []
        assert prowlarr_calls == []
        assert [call["url"] for call in stub.calls] == [URL_A]


class TestRowShapes:
    """The exact per-source shapes the frontend task consumes."""

    def test_a_torznab_row_omits_whatever_the_adapter_did_not_report(self, store):
        _seed("Indexador A", URL_A)
        stub = _TorznabStub(
            answers={URL_A: [_torznab_raw(title="Arthur 2006", size=None)]}
        )
        with _torznab(stub), _amule(), _prowlarr():
            resp = _search({"query": "Arthur"})

        assert resp.json()["results"] == [
            {"source": "torznab", "indexer": "Indexador A", "name": "Arthur 2006", "size": None}
        ]

    def test_a_prowlarr_row_prefers_the_magnet_as_its_link(self, store):
        both = _prowlarr_raw(
            title="Arthur 2006",
            magnet_url="magnet:?xt=urn:btih:abc123",
            download_url="http://prowlarr.test:9696/getnzb/1",
        )
        only_download = _prowlarr_raw(
            title="Arthur and the Invisibles 2006",
            guid="pr-2",
            magnet_url=None,
            download_url="http://prowlarr.test:9696/getnzb/2",
        )
        with _prowlarr(answer=[both, only_download]), _amule(), _torznab(_TorznabStub()):
            resp = _search({"query": "Arthur"})

        assert resp.json()["results"] == [
            {
                "source": "prowlarr",
                "indexer": "NoNaMe Club",
                "name": "Arthur 2006",
                "size": 2_000_000_000,
                "seeders": 42,
                "guid": "pr-1",
                "link": "magnet:?xt=urn:btih:abc123",
            },
            {
                "source": "prowlarr",
                "indexer": "NoNaMe Club",
                "name": "Arthur and the Invisibles 2006",
                "size": 2_000_000_000,
                "seeders": 42,
                "guid": "pr-2",
                "link": "http://prowlarr.test:9696/getnzb/2",
            },
        ]

    def test_an_amule_row_never_calls_its_source_count_seeders(self, store):
        """Honesty rule: `sources` (a count of ED2K sources) is not `seeders`."""
        with _amule(answer=[_amule_raw()]), _torznab(_TorznabStub()), _prowlarr():
            resp = _search({"query": "Артур"})

        row = resp.json()["results"][0]
        assert row["sources"] == 7
        assert "seeders" not in row
        assert row["guid"] == HASH32
        assert row["link"] == f"ed2k://|file|{TITLE}|2000000000|{HASH32}|/"


# ── failure isolation and skipped ────────────────────────────────────────────


class TestFailureIsolation:
    """(c) one source's failure never discards another's results."""

    def test_one_failing_source_leaves_the_others_intact(self, store):
        _seed("Indexador A", URL_A)
        stub = _TorznabStub(
            answers={URL_A: [_torznab_raw(guid="t-1", size=1, title="Arthur 2006")]}
        )
        with (
            _torznab(stub),
            _amule(answer=[_amule_raw(name="Arthur 2006")]),
            _prowlarr(error=aiohttp.ClientError("connection refused")),
        ):
            resp = _search({"query": "Arthur"})

        body = resp.json()
        assert body["ok"] is True
        assert [row["source"] for row in body["results"]] == ["torznab", "amule"]
        assert body["skipped"] == [
            {"source": "prowlarr", "reason": "ClientError: connection refused"}
        ]

    def test_a_failing_indexer_only_skips_its_own_rows(self, store):
        _seed("Indexador A", URL_A)
        _seed("Indexador B", URL_B)
        stub = _TorznabStub(
            answers={URL_A: [_torznab_raw(guid="t-1", size=1, title="Arthur 2006")]},
            errors={URL_B: asyncio.TimeoutError()},
        )
        with _torznab(stub), _amule(), _prowlarr():
            resp = _search({"query": "Arthur"})

        body = resp.json()
        assert body["ok"] is True
        assert [row["guid"] for row in body["results"]] == ["t-1"]
        assert body["skipped"] == [
            {"source": "torznab", "reason": "indexador «Indexador B»: TimeoutError"}
        ]

    def test_a_skipped_reason_never_carries_the_api_key(self, store):
        """The probe's `_redact` rule reaches the search too (S7: no secrets)."""
        _seed("Indexador A", URL_A)
        boom = aiohttp.ClientError(f"HTTP 500: rechazada apikey={FAKE_KEY} ({FAKE_KEY})")
        stub = _TorznabStub(errors={URL_A: boom})
        with _torznab(stub), _amule(), _prowlarr():
            resp = _search({"query": "Arthur"})

        assert resp.status_code == 200
        assert "HTTP 500" in resp.json()["skipped"][0]["reason"]
        assert FAKE_KEY not in resp.text


class TestSkippedReasons:
    """(d) every absence has its own honest Spanish reason — never silence."""

    def test_unconfigured_prowlarr_is_skipped_with_the_shared_reason(self, store):
        _seed("Indexador A", URL_A)
        stub = _TorznabStub(
            answers={URL_A: [_torznab_raw(guid="t-1", size=1, title="Arthur 2006")]}
        )
        with (
            _torznab(stub),
            _amule(answer=[_amule_raw(name="Arthur 2006")]),
            _prowlarr(configured=False) as prowlarr_calls,
        ):
            resp = _search({"query": "Arthur"})

        body = resp.json()
        assert body["ok"] is True
        assert body["skipped"] == [{"source": "prowlarr", "reason": PROWLARR_REASON}]
        assert prowlarr_calls == [], "sin servicio configurado jamás se sale a la red"

    def test_unconfigured_amule_is_skipped_with_the_shared_reason(self, store):
        _seed("Indexador A", URL_A)
        stub = _TorznabStub(
            answers={URL_A: [_torznab_raw(guid="t-1", size=1, title="Arthur 2006")]}
        )
        with (
            _torznab(stub),
            _amule(error=RuntimeError(AMULE_REASON)),
            _prowlarr(answer=[_prowlarr_raw(title="Arthur 2006")]),
        ):
            resp = _search({"query": "Arthur"})

        body = resp.json()
        assert body["ok"] is True
        # The seam's designed refusal travels VERBATIM (the shared reason), not
        # dressed up as an accident with a `RuntimeError:` prefix.
        assert body["skipped"] == [{"source": "amule", "reason": AMULE_REASON}]

    def test_no_enabled_indexers_is_skipped_and_never_queried(self, store):
        _seed("Pausada", URL_A, enabled=0)
        stub = _TorznabStub(answers={URL_A: [_torznab_raw()]})
        with _torznab(stub), _amule(), _prowlarr():
            resp = _search({"query": "Arthur", "sources": ["torznab"]})

        body = resp.json()
        assert stub.calls == []
        assert body["skipped"] == [
            {"source": "torznab", "reason": "sin indexadores habilitados"}
        ]

    def test_disabling_a_row_keeps_it_out_of_the_fan_out(self, store):
        _seed("Indexador A", URL_A)
        _seed("Pausada", URL_B, enabled=0)
        stub = _TorznabStub(
            answers={URL_A: [_torznab_raw(guid="t-1", size=1, title="Arthur 2006")]}
        )
        with _torznab(stub), _amule(), _prowlarr():
            resp = _search({"query": "Arthur", "sources": ["torznab"]})

        body = resp.json()
        assert [call["url"] for call in stub.calls] == [URL_A]
        assert [row["indexer"] for row in body["results"]] == ["Indexador A"]
        assert body["skipped"] == []

    def test_an_undecryptable_row_is_skipped_by_name_and_never_sent(
        self, store, monkeypatch
    ):
        """A rotated `FC_SECRET` answers `api_key=None` — never a wrong key."""
        monkeypatch.setenv("FC_SECRET", "first-secret")
        _seed("Rota", URL_A)
        monkeypatch.setenv("FC_SECRET", "second-secret")
        _seed("Sana", URL_B)
        stub = _TorznabStub(
            answers={URL_B: [_torznab_raw(guid="t-2", size=1, title="Arthur 2006")]}
        )
        with _torznab(stub), _amule(), _prowlarr():
            resp = _search({"query": "Arthur", "sources": ["torznab"]})

        body = resp.json()
        assert body["ok"] is True
        assert [row["indexer"] for row in body["results"]] == ["Sana"]
        assert body["skipped"] == [
            {
                "source": "torznab",
                "reason": (
                    "indexador «Rota»: no se pudo descifrar la api_key guardada "
                    "(¿cambió FC_SECRET?)"
                ),
            }
        ]
        assert [call["url"] for call in stub.calls] == [URL_B]


# ── every source failing ─────────────────────────────────────────────────────


class TestEverySourceFailing:
    """(e) `ok:false` + a summary — never a silent `[]` (S4)."""

    def test_every_source_failing_is_200_with_ok_false_and_a_summary(self, store):
        """HTTP 200 like every honest refusal here (S3): one merged envelope
        must carry per-source truth, and `ok:false` + `detail` IS the signal."""
        stub = _TorznabStub()
        with (
            _torznab(stub),
            _amule(error=RuntimeError(AMULE_REASON)),
            _prowlarr(configured=False),
        ):
            resp = _search({"query": "Arthur"})

        assert resp.status_code == 200
        body = resp.json()
        assert set(body) == {"ok", "results", "skipped", "detail"}
        assert body["ok"] is False
        assert body["results"] == []
        assert body["skipped"] == [
            {"source": "torznab", "reason": "sin indexadores habilitados"},
            {"source": "amule", "reason": AMULE_REASON},
            {"source": "prowlarr", "reason": PROWLARR_REASON},
        ]
        assert body["detail"] == (
            "todas las fuentes seleccionadas fallaron — "
            "torznab: sin indexadores habilitados; "
            f"amule: {AMULE_REASON}; "
            f"prowlarr: {PROWLARR_REASON}"
        )
        assert stub.calls == []

    def test_a_disabled_only_registry_is_never_an_empty_success(self, store):
        _seed("Pausada", URL_A, enabled=0)
        stub = _TorznabStub()
        with _torznab(stub), _amule(), _prowlarr():
            resp = _search({"query": "Arthur", "sources": ["torznab"]})

        body = resp.json()
        assert body["ok"] is False
        assert body["skipped"] == [
            {"source": "torznab", "reason": "sin indexadores habilitados"}
        ]
        assert "detail" in body

    def test_an_undecryptable_only_registry_is_never_an_empty_success(
        self, store, monkeypatch
    ):
        monkeypatch.setenv("FC_SECRET", "first-secret")
        _seed("Rota", URL_A)
        monkeypatch.setenv("FC_SECRET", "second-secret")
        stub = _TorznabStub()
        with _torznab(stub), _amule(), _prowlarr():
            resp = _search({"query": "Arthur", "sources": ["torznab"]})

        body = resp.json()
        assert body["ok"] is False
        assert body["results"] == []
        assert stub.calls == []
        assert "Rota" in body["skipped"][0]["reason"]
        assert "detail" in body

    def test_a_filter_that_drops_everything_is_still_an_honest_empty(self, store):
        """The sources ANSWERED — the filter found nothing relevant, which is
        «Sin resultados», not a failure."""
        _seed("Indexador A", URL_A)
        stub = _TorznabStub(answers={URL_A: [_torznab_raw(guid="t-1", size=1)]})
        with _torznab(stub), _amule(), _prowlarr():
            resp = _search({"query": "Arthur", "sources": ["torznab"]})

        assert resp.status_code == 200
        assert resp.json() == {"ok": True, "results": [], "skipped": []}


# ── the frozen #218 relevance rule ───────────────────────────────────────────


class TestTheRelevanceFilter:
    """Mirrored byte-identically from `prowlarr_client` (rule #218): a row
    survives only when its NAME contains at least one QUERY token that is not
    purely numeric and is >= 3 chars — case-insensitively."""

    def test_a_row_is_kept_only_when_it_shares_a_qualifying_query_token(self, store):
        rows = [
            _torznab_raw(title="Артур и минипуты (2006) BDRip", guid="real", size=1),
            _torznab_raw(title="[rutor] Случайный.Фильм.2006.HDTVRip", guid="junk", size=1),
        ]
        _seed("Indexador A", URL_A)
        stub = _TorznabStub(answers={URL_A: rows})
        with _torznab(stub), _amule(), _prowlarr():
            resp = _search({"query": "Артур и минимоны", "sources": ["torznab"]})

        assert [row["guid"] for row in resp.json()["results"]] == ["real"]

    def test_matching_is_case_insensitive(self, store):
        rows = [_torznab_raw(title="arthur.and.the.invisibles.2006", guid="g", size=1)]
        _seed("Indexador A", URL_A)
        stub = _TorznabStub(answers={URL_A: rows})
        with _torznab(stub), _amule(), _prowlarr():
            resp = _search({"query": "ARTHUR", "sources": ["torznab"]})

        assert [row["guid"] for row in resp.json()["results"]] == ["g"]

    def test_a_query_token_matches_inside_a_longer_word(self, store):
        rows = [_torznab_raw(title="Артура и минипуты (2006)", guid="g", size=1)]
        _seed("Indexador A", URL_A)
        stub = _TorznabStub(answers={URL_A: rows})
        with _torznab(stub), _amule(), _prowlarr():
            resp = _search({"query": "Артур", "sources": ["torznab"]})

        assert [row["guid"] for row in resp.json()["results"]] == ["g"]

    def test_short_and_numeric_query_tokens_qualify_nothing(self, store):
        """«и» (1 char) and «2006» (numeric) can never make a row relevant —
        the exact drop that keeps dmhy's year-only answers out (#218)."""
        rows = [_torznab_raw(title="Артур и минипуты (2006)", guid="g", size=1)]
        _seed("Indexador A", URL_A)
        stub = _TorznabStub(answers={URL_A: rows})
        with _torznab(stub), _amule(), _prowlarr():
            resp = _search({"query": "и 2006", "sources": ["torznab"]})

        assert resp.json()["results"] == []


# ── unicode end to end ───────────────────────────────────────────────────────


class TestUnicode:
    def test_a_cyrillic_query_flows_through_every_source(self, store):
        _seed("Indexador A", URL_A)
        stub = _TorznabStub(answers={URL_A: [_torznab_raw(guid="t-1", size=1)]})
        with (
            _torznab(stub),
            _amule(answer=[_amule_raw(name="Артур и минипуты (2006)")]),
            _prowlarr(answer=[_prowlarr_raw(title="Артур и минипуты (2006)")]),
        ):
            resp = _search({"query": "Артур и минимоны"})

        body = resp.json()
        assert body["ok"] is True
        assert [row["source"] for row in body["results"]] == [
            "torznab",
            "amule",
            "prowlarr",
        ]
        assert stub.calls[0]["query"] == "Артур и минимоны"

    def test_accented_spanish_names_survive_the_round_trip(self, store):
        rows = [_torznab_raw(title="El.Niño.2024.1080p", guid="g", size=1)]
        _seed("Indexador A", URL_A)
        stub = _TorznabStub(answers={URL_A: rows})
        with _torznab(stub), _amule(), _prowlarr():
            resp = _search({"query": "el niño", "sources": ["torznab"]})

        assert [row["name"] for row in resp.json()["results"]] == ["El.Niño.2024.1080p"]
