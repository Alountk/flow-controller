"""Direct-to-client downloads: identity, category and the add.

Option B of the routed-grab work: a release whose destination sits outside
every arr root goes STRAIGHT to aMuTorrent under this app's own category, so
the arr never tracks it and cannot import it over what the library already
holds (the 4K-replaces-1080p incident). These tests pin the link identity,
the category and the add itself, with only the HTTP transport faked.
"""

import asyncio
import logging

import config
from infrastructure import arr_client
from infrastructure.arr_client import (
    DIRECT_DOWNLOAD_CATEGORY,
    amutorrent_add_download,
    direct_link_identity,
)
from tests._stubs import _StubSession

AMUTORRENT_URL = arr_client.AMUTORRENT_URL

ED2K_LINK = (
    "ed2k://|file Your.Name.2016.1080p.BluRay.x264-GRP.mkv"
    "|8589934592|ABCDEF0123456789ABCDEF0123456789|/"
)

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


class _KwargSession(_StubSession):
    """Stub that also records the kwargs each POST was made with.

    ``_StubSession.calls`` keeps only the URL, and the request timeout is a
    kwarg — a budget regression would be invisible without recording it.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.post_kwargs: list[tuple[str, dict]] = []

    def post(self, url, **kwargs):
        self.post_kwargs.append((str(url), kwargs))
        return super().post(url, **kwargs)


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


def test_the_add_waits_long_enough_for_the_throttled_ed2k_network():
    # The add POST is where the client starts its server-side ED2K work —
    # the same measured ~30 s the search docstring budgets for with ×12.
    # At ×2 (10 s) the POST reached the client (download started) while our
    # side already gave up with a bare "TimeoutError: ".
    session = _KwargSession({
        f"{AMUTORRENT_URL}/api/v2/torrents/categories": (200, {DIRECT_DOWNLOAD_CATEGORY: {}}),
        f"{AMUTORRENT_URL}/api/v2/torrents/add": (200, {}),
    })

    asyncio.run(amutorrent_add_download(session, ED2K_LINK))

    add_calls = [(u, kw) for u, kw in session.post_kwargs if "torrents/add" in u]
    assert add_calls, "the add request went out"
    assert add_calls[0][1]["timeout"].total == config.REQUEST_TIMEOUT * 12


def test_a_timed_out_add_says_how_long_it_waited():
    # str(TimeoutError()) is empty, so a bare f"{type}: {exc}" produced the
    # user-facing detail `TimeoutError: ` — an empty tail that says nothing.
    session = _StubSession({
        f"{AMUTORRENT_URL}/api/v2/torrents/categories": (200, {DIRECT_DOWNLOAD_CATEGORY: {}}),
        f"{AMUTORRENT_URL}/api/v2/torrents/add": (0, asyncio.TimeoutError()),
    })

    result = asyncio.run(amutorrent_add_download(session, ED2K_LINK))

    assert result["ok"] is False
    assert "sin respuesta tras" in result["detail"]
    assert f"{int(config.REQUEST_TIMEOUT * 12)}s" in result["detail"]


def test_an_add_error_with_a_message_keeps_that_message():
    session = _StubSession({
        f"{AMUTORRENT_URL}/api/v2/torrents/categories": (200, {DIRECT_DOWNLOAD_CATEGORY: {}}),
        f"{AMUTORRENT_URL}/api/v2/torrents/add": (0, asyncio.TimeoutError("went away")),
    })

    result = asyncio.run(amutorrent_add_download(session, ED2K_LINK))

    assert result["detail"] == "TimeoutError: went away"


def test_the_add_logs_the_category_and_link_it_is_about_to_post(caplog):
    session = _StubSession({
        f"{AMUTORRENT_URL}/api/v2/torrents/categories": (200, {DIRECT_DOWNLOAD_CATEGORY: {}}),
        f"{AMUTORRENT_URL}/api/v2/torrents/add": (200, {}),
    })

    # The add logs at INFO and the suite's effective capture floor is
    # WARNING (pytest's handler preempts app.py's basicConfig), so the
    # level must be lifted here or the record never reaches caplog.
    with caplog.at_level(logging.INFO, logger="flow-controller"):
        asyncio.run(amutorrent_add_download(session, ED2K_LINK))

    assert "amutorrent_add_download" in caplog.text
    assert DIRECT_DOWNLOAD_CATEGORY in caplog.text
    assert ED2K_LINK[:48] in caplog.text


def test_direct_add_is_the_category_the_arr_never_polls():
    # The whole point of B: not `radarr`, not `tv-sonarr`.
    assert DIRECT_DOWNLOAD_CATEGORY == "flow"
