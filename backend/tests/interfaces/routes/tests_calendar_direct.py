"""Where a grabbed release is SENT: straight to a client, by shape (T2/S2-S4).

This file used to pin the routed-grab gate: a destination outside every arr
root went to the client under our own category while everything else rode
`arr_grab_release`, and the batch REFUSED a foreign destination outright.
calendario-directo S2-S4 replaces that premise wholesale — the grab never
passes through the arr anymore, the shape dispatch (`dispatch_direct`,
injected by the route) sends the row's OWN link to the client, and the only
gate left is `path_is_allowed`. What these tests pin now:

- a library grab goes to the client under the arr's WATCHED category (`radarr`
  / `tv-sonarr`, S3) and asks the arr NOTHING — no roots, no grab (S2);
- an explicit destination goes under `flow` with the honesty suffix (S3), and
  the own-grab row carries the client identity taken from the row's own link;
- a target the dispatch cannot recognise sends nothing anywhere and records
  nothing — the `_BAD_SCHEME`-style refusal of `POST /api/indexers/download`;
- the batch with a destination outside the arr roots but allowed by
  `path_is_allowed` dispatches ROW BY ROW with `links` aligned to `guids`
  (S4: «la negativa actual del lote… ya no aplica»).

async-grab: the single grab is a job, so `_post` goes through
`post_grab_and_settle` (POST + worker settle on one loop) and the worker's
collaborators are patched where the route injects them —
`interfaces.http.routes.calendar.dispatch_direct` serves BOTH the worker (the
route passes it in) and the synchronous batch. Only the collaborators each
side reads are patched, so the real route and worker bodies run.

RETIRED with this rewrite (their premise is what S2-S4 removed):
`test_a_destination_inside_an_arr_root_stays_on_the_arr`,
`test_unreadable_roots_fail_closed_to_the_arr` (S2/S3: nothing rides the arr,
so `arr_root_folders` no longer routes or gates anything),
`test_a_foreign_grab_without_a_title_fails_before_any_call` (S2: «no se
re-busca el enlace» — the row already carries `link`/`guid`, so a title is no
longer required),
`test_the_batch_refuses_a_foreign_destination_upfront` (S4 verbatim: the
refusal is gone — its successor is
`test_the_batch_dispatches_row_by_row_with_links_aligned_to_guids`).
"""

from unittest.mock import AsyncMock, MagicMock, patch

from application import gateways
from tests._stubs import client, post_grab_and_settle

ED2K_LINK = (
    "ed2k://|file Your.Name.2016.1080p.BluRay.x264-GRP.mkv"
    "|8589934592|ABCDEF0123456789ABCDEF0123456789|/"
)

FOREIGN = "/mnt/storage-6tb/Movies4K"

#: Where the route injects the shape dispatch (worker + batch, T2/S2).
DISPATCH = "interfaces.http.routes.calendar.dispatch_direct"
#: Where the background worker records its own-grab row (async-grab).
WORKER = "application.use_cases.grab_release"
BATCH = "interfaces.http.routes.calendar"

ROOTS = f"{WORKER}.arr_root_folders"
ARR = f"{WORKER}.arr_grab_release"
RECORD = f"{WORKER}.record_own_grab"
BATCH_RECORD = f"{BATCH}.record_own_grab"

#: The refusal of a target the dispatch cannot recognise — pinned verbatim
#: (the `_BAD_SCHEME` of `POST /api/indexers/download`).
BAD_SCHEME = (
    "link no válido: se espera ed2k://, magnet:, http(s) o un hash de aMule (32 hex)"
)


def _post(**body):
    payload = {"source": "radarr", "guid": "g1", "movieId": 855}
    payload.update(body)
    return post_grab_and_settle(payload)


def test_a_library_grab_never_asks_the_arr_anything():
    # A library grab takes the arr's watched category straight to the client:
    # not one root-folder round trip, and never `arr_grab_release` (S2).
    with patch(DISPATCH, new=AsyncMock(return_value={"ok": True, "detail": "encolado"})) as dispatch, \
            patch(ROOTS, new=AsyncMock(return_value=["/mnt/storage/movies"]), create=True) as roots, \
            patch(ARR, new=AsyncMock(), create=True) as arr, \
            patch(RECORD, new=MagicMock()) as record:
        body = _post()

    assert body["ok"] is True
    dispatch.assert_awaited_once_with("g1", "radarr")
    roots.assert_not_awaited()
    arr.assert_not_awaited()
    assert record.call_args.kwargs["direct"] is True, "S2: el add es propio"


def test_an_explicit_destination_goes_straight_to_the_client_under_the_direct_category():
    with patch(DISPATCH, new=AsyncMock(return_value={"ok": True, "detail": "Descarga añadida (categoría flow)"})) as dispatch, \
            patch(ARR, new=AsyncMock(), create=True) as arr, \
            patch(RECORD, new=MagicMock()) as record:
        body = _post(destination=FOREIGN, link=ED2K_LINK, title="Your.Name.2016.1080p.BluRay.x264-GRP")

    dispatch.assert_awaited_once_with(ED2K_LINK, "flow")
    arr.assert_not_awaited()  # the arr must never be told about this download
    assert body["ok"] is True and body["direct"] is True
    assert "directa" in body["detail"]

    kwargs = record.call_args.kwargs
    assert kwargs["direct"] is True
    assert kwargs["destination"] == FOREIGN
    assert kwargs["client_name"] == "Your.Name.2016.1080p.BluRay.x264-GRP.mkv"
    assert kwargs["client_hash"] is None, "the ED2K hash is not the client's infohash"


def test_an_unrecognisable_target_sends_nothing_anywhere(monkeypatch):
    """S2: there is no resolve step anymore — the dispatch acts on the row's
    own target, and what it cannot recognise is refused before any client is
    touched (was `test_a_missing_link_sends_nothing_anywhere`, whose refusal
    came from the deleted link re-search)."""
    monkeypatch.delenv("AMULE_EC_DIRECT", raising=False)

    def _fail(*args, **kwargs):
        raise AssertionError("no client seam may be called for a refused target")

    with patch.object(gateways, "amule_add_ed2k", _fail), \
            patch.object(gateways, "amule_download_search_result", _fail), \
            patch.object(gateways, "qbit_add_download", AsyncMock(side_effect=_fail)) as qbit, \
            patch.object(gateways, "amutorrent_add_download", AsyncMock(side_effect=_fail)) as bridge, \
            patch(RECORD, new=MagicMock()) as record:
        body = _post(guid="not-a-link", title="Never.Seen.2024.2160p")

    assert body["ok"] is False
    assert body["detail"] == BAD_SCHEME
    qbit.assert_not_awaited()
    bridge.assert_not_awaited()
    record.assert_not_called()


def test_a_client_refusal_is_reported_and_not_recorded():
    # The refusal detail is the DISPATCH's, verbatim — the transport names
    # itself (the native qBittorrent client now, not the old bridge).
    with patch(DISPATCH, new=AsyncMock(return_value={
        "ok": False,
        "detail": "qBittorrent (http://qb:8080) no aceptó la descarga: HTTP 400: magnet no soportado",
    })) as dispatch, \
            patch(RECORD, new=MagicMock()) as record:
        body = _post(destination=FOREIGN, link="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567")

    assert body["ok"] is False
    assert "qBittorrent" in body["detail"] and "HTTP 400" in body["detail"]
    dispatch.assert_awaited_once()
    record.assert_not_called()


def test_the_batch_dispatches_row_by_row_with_links_aligned_to_guids():
    """S4 (T2 RED): a batch with a destination outside the arr roots but
    allowed by `path_is_allowed` is NO LONGER refused — «la negativa actual
    del lote… ya no aplica» (S4). It dispatches row by row, each row's `link`
    paired with its `guid` by index (S2: no re-search; a missing/short `links`
    entry falls back to that row's guid)."""
    link0 = "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=One"
    link1 = "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&dn=Two"
    guid2 = "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc&dn=Three"
    calls = []

    async def fake_qbit(session, url, category=None):
        calls.append({"url": url, "category": category})
        return {
            "ok": True,
            "detail": f"Descarga añadida en qBittorrent (stub), categoría {category}",
        }

    with patch.object(gateways, "qbit_add_download", fake_qbit), \
            patch(f"{BATCH}.arr_root_folders", new=AsyncMock(return_value=["/mnt/storage/movies"])) as roots, \
            patch(f"{BATCH}.arr_grab_release", new=AsyncMock(), create=True) as arr, \
            patch(BATCH_RECORD, new=MagicMock()) as record:
        resp = client.post(
            "/api/calendar/grab-batch",
            json={
                "source": "radarr",
                "guids": ["g1", "g2", guid2],
                "links": [link0, link1],
                "indexerIds": [1, 2, 3],
                "movieId": 855,
                "destination": FOREIGN,
            },
        )
    body = resp.json()

    assert body["ok"] is True, body
    assert body["downloaded"] == ["g1", "g2", guid2]
    assert calls == [
        {"url": link0, "category": "flow"},
        {"url": link1, "category": "flow"},
        {"url": guid2, "category": "flow"},
    ]
    roots.assert_not_awaited(), "S4: las raíces del arr ya no son gate del lote"
    arr.assert_not_awaited(), "S2: el lote ya no pasa por el arr"
    assert record.call_count == 3, "una fila own_grab por descarga exitosa"


def test_the_library_button_skips_the_quality_derivation():
    # → Biblioteca on a 4K row must mean the ARR's path: without the flag the
    # quality derivation would silently reroute the "library" grab to path_4k.
    with patch(DISPATCH, new=AsyncMock(return_value={"ok": True, "detail": "encolado"})) as dispatch, \
            patch(RECORD, new=MagicMock()) as record, \
            patch(f"{BATCH}.arr_root_folders", new=AsyncMock(return_value=["/mnt/storage/movies"])) as roots:
        body = _post(quality="Bluray-2160p", title="Some.Movie.2024.2160p", library=True)

    dispatch.assert_awaited_once_with("g1", "radarr")
    roots.assert_not_awaited(), "the grab flow never consults the arr's roots (S3)"
    assert body["ok"] is True
    kwargs = record.call_args.kwargs
    assert kwargs["destination"] is None, "library is explicit, never derived"
    assert kwargs["quality"] == "Bluray-2160p", "the registry still learns what was grabbed"


def test_a_quality_derived_4k_destination_also_goes_direct(monkeypatch):
    # Nobody pressed a button: the RULE routes 2160p to path_4k, and that
    # leaves the library — it must take the same direct path as a chosen one
    # (category `flow` + the honesty suffix, S3).
    import config as config_module

    monkeypatch.setattr(config_module, "PATH_4K", "/mnt/storage-6tb/Movies4K")
    with patch(DISPATCH, new=AsyncMock(return_value={"ok": True, "detail": "Descarga añadida (categoría flow)"})) as dispatch, \
            patch(ARR, new=AsyncMock(), create=True) as arr, \
            patch(RECORD, new=MagicMock()) as record:
        body = _post(quality="Bluray-2160p", title="Some.Movie.2024.2160p")

    arr.assert_not_awaited()
    dispatch.assert_awaited_once_with("g1", "flow")
    assert body["ok"] is True and body["direct"] is True
    assert record.call_args.kwargs["destination"] == "/mnt/storage-6tb/Movies4K"
