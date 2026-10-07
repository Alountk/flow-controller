"""Where a grabbed release is SENT: through the arr, or straight to the client.

Option B of the routed-grab work (the 4K-cannibalises-the-1080p incident): a
destination OUTSIDE every arr root must never reach the arr — the arr imports
its downloads on completion and quality-upgrades replace what the library
already holds. These tests pin the gate and both sides of it:

- foreign destination → Torznab link → `torrents/add` under our own category,
  no arr call at all, and the own-grab row recorded as a direct add;
- anything else (library, destination inside an arr root, UNREADABLE root
  list) → the arr path exactly as before — the gate fails closed.

Only the collaborators the route module imports are patched, so the real
route body runs.
"""

from unittest.mock import AsyncMock, MagicMock, patch

from tests._stubs import client

ED2K_LINK = (
    "ed2k://|file Your.Name.2016.1080p.BluRay.x264-GRP.mkv"
    "|8589934592|ABCDEF0123456789ABCDEF0123456789|/"
)

FOREIGN = "/mnt/storage-6tb/Movies4K"
INSIDE_ROOT = "/mnt/storage/movies/_manual"

ROOTS = "interfaces.http.routes.calendar.arr_root_folders"
GRAB = "interfaces.http.routes.calendar.arr_grab_release"
SEARCH = "interfaces.http.routes.calendar.amutorrent_search_link"
ADD = "interfaces.http.routes.calendar.amutorrent_add_download"
RECORD = "interfaces.http.routes.calendar.record_own_grab"


def _post(**body):
    payload = {"source": "radarr", "guid": "g1", "movieId": 855}
    payload.update(body)
    return client.post("/api/calendar/grab", json=payload).json()


def _foreign_patches(*, link=ED2K_LINK, add_result=None, roots=None):
    """The standard arrangement: readable roots, a resolvable link, a client that accepts."""
    roots = ["/mnt/storage/movies"] if roots is None else roots
    add_result = add_result or {"ok": True, "detail": "Descarga añadida (categoría flow)", "category": "flow"}
    return (
        patch(ROOTS, new=AsyncMock(return_value=roots)),
        patch(SEARCH, new=AsyncMock(return_value=link)),
        patch(ADD, new=AsyncMock(return_value=add_result)),
        patch(GRAB, new=AsyncMock(return_value={"ok": True, "detail": "encolado"})),
        patch(RECORD, new=MagicMock()),
    )


def test_a_library_grab_never_asks_for_the_arrs_roots():
    # No destination → no foreign question → the arr path it has always taken,
    # and not even one root-folder round trip for it.
    with patch(ROOTS, new=AsyncMock(return_value=["/mnt/storage/movies"])) as roots, \
            patch(GRAB, new=AsyncMock(return_value={"ok": True, "detail": "encolado"})) as grab, \
            patch(RECORD, new=MagicMock()) as record:
        body = _post()

    assert body["ok"] is True
    grab.assert_awaited_once()
    roots.assert_not_awaited()
    assert record.call_args.kwargs["direct"] is False


def test_a_foreign_destination_goes_straight_to_the_client():
    roots_p, search_p, add_p, grab_p, record_p = _foreign_patches()
    with roots_p as roots, search_p as search, add_p as add, grab_p as grab, record_p as record:
        body = _post(destination=FOREIGN, title="Your.Name.2016.1080p.BluRay.x264-GRP")

    roots.assert_awaited_once()
    search.assert_awaited_once()
    assert search.await_args.args[1] == "Your.Name.2016.1080p.BluRay.x264-GRP"
    add.assert_awaited_once()
    grab.assert_not_awaited()  # the arr must never be told about this download
    assert body["ok"] is True and body["direct"] is True
    assert "directa" in body["detail"]

    kwargs = record.call_args.kwargs
    assert kwargs["direct"] is True
    assert kwargs["destination"] == FOREIGN
    assert kwargs["client_name"] == "Your.Name.2016.1080p.BluRay.x264-GRP.mkv"
    assert kwargs["client_hash"] is None, "the ED2K hash is not the client's infohash"


def test_a_destination_inside_an_arr_root_stays_on_the_arr():
    roots_p, search_p, add_p, grab_p, record_p = _foreign_patches(roots=["/mnt/storage/movies"])
    with roots_p, search_p as search, add_p as add, grab_p as grab, record_p as record:
        body = _post(destination=INSIDE_ROOT, title="Some.Title.2024")

    grab.assert_awaited_once()
    search.assert_not_awaited()
    add.assert_not_awaited()
    assert body["ok"] is True
    assert record.call_args.kwargs["direct"] is False


def test_unreadable_roots_fail_closed_to_the_arr():
    # An empty root list proves nothing, so the gate stays shut: the arr path.
    roots_p, search_p, add_p, grab_p, record_p = _foreign_patches(roots=[])
    with roots_p, search_p as search, add_p, grab_p as grab, record_p:
        body = _post(destination=FOREIGN, title="Some.Title.2024")

    grab.assert_awaited_once()
    search.assert_not_awaited()
    assert body["ok"] is True


def test_a_missing_link_sends_nothing_anywhere():
    roots_p, search_p, add_p, grab_p, record_p = _foreign_patches(link=None)
    with roots_p, search_p, add_p as add, grab_p as grab, record_p as record:
        body = _post(destination=FOREIGN, title="Never.Seen.2024.2160p")

    assert body["ok"] is False
    assert "indexador de aMule" in body["detail"]
    assert "Biblioteca" in body["detail"]
    add.assert_not_awaited()
    grab.assert_not_awaited()
    record.assert_not_called()


def test_a_client_refusal_is_reported_and_not_recorded():
    roots_p, search_p, add_p, grab_p, record_p = _foreign_patches(
        add_result={"ok": False, "detail": "HTTP 400: magnet no soportado"}
    )
    with roots_p, search_p, add_p, grab_p as grab, record_p as record:
        body = _post(destination=FOREIGN, title="Some.Title.2024.2160p")

    assert body["ok"] is False
    assert "aMuTorrent" in body["detail"] and "HTTP 400" in body["detail"]
    grab.assert_not_awaited()
    record.assert_not_called()


def test_a_foreign_grab_without_a_title_fails_before_any_call():
    roots_p, search_p, add_p, grab_p, record_p = _foreign_patches()
    with roots_p, search_p as search, add_p, grab_p as grab, record_p as record:
        body = _post(destination=FOREIGN)

    assert body["ok"] is False
    assert "título" in body["detail"]
    search.assert_not_awaited()
    grab.assert_not_awaited()
    record.assert_not_called()


def test_the_batch_refuses_a_foreign_destination_upfront():
    roots_p, search_p, add_p, grab_p, record_p = _foreign_patches()
    with roots_p as roots, search_p, add_p, grab_p as grab, record_p as record:
        resp = client.post(
            "/api/calendar/grab-batch",
            json={
                "source": "radarr",
                "guids": ["g1", "g2"],
                "indexerIds": [1, 2],
                "movieId": 855,
                "destination": FOREIGN,
            },
        )
    body = resp.json()

    roots.assert_awaited_once()
    grab.assert_not_awaited()
    record.assert_not_called()
    assert body["ok"] is False
    assert "fila a fila" in body["detail"]
    assert body["downloaded"] == [] and body["errors"] == []


def test_the_library_button_skips_the_quality_derivation():
    # → Biblioteca on a 4K row must mean the ARR's path: without the flag the
    # quality derivation would silently reroute the "library" grab to path_4k.
    with patch(GRAB, new=AsyncMock(return_value={"ok": True, "detail": "encolado"})) as grab, \
            patch(RECORD, new=MagicMock()) as record, \
            patch("interfaces.http.routes.calendar.arr_root_folders", new=AsyncMock(return_value=["/mnt/storage/movies"])) as roots:
        body = _post(quality="Bluray-2160p", title="Some.Movie.2024.2160p", library=True)

    grab.assert_awaited_once()
    roots.assert_not_awaited(), "no destination is resolved, so there is no foreign question"
    assert body["ok"] is True
    kwargs = record.call_args.kwargs
    assert kwargs["destination"] is None, "library is explicit, never derived"
    assert kwargs["quality"] == "Bluray-2160p", "the registry still learns what was grabbed"


def test_a_quality_derived_4k_destination_also_goes_direct(monkeypatch):
    # Nobody pressed a button: the RULE routes 2160p to path_4k, and that is a
    # foreign destination — it must take the same direct path as a chosen one.
    import config as config_module

    monkeypatch.setattr(config_module, "PATH_4K", "/mnt/storage-6tb/Movies4K")
    roots_p, search_p, add_p, grab_p, record_p = _foreign_patches()
    with roots_p, search_p as search, add_p, grab_p as grab, record_p as record:
        body = _post(quality="Bluray-2160p", title="Some.Movie.2024.2160p")

    grab.assert_not_awaited()
    search.assert_awaited_once()
    assert body["ok"] is True and body["direct"] is True
    assert record.call_args.kwargs["destination"] == "/mnt/storage-6tb/Movies4K"
