"""Direct-to-client downloads: link identity and category.

Option B of the routed-grab work: a release whose destination sits outside
every arr root goes STRAIGHT to the client under this app's own category, so
the arr never tracks it and cannot import it over what the library already
holds (the 4K-replaces-1080p incident). These tests pin the link identity,
and the category.
"""


from infrastructure.arr_client import (
    DIRECT_DOWNLOAD_CATEGORY,
    direct_link_identity,
)
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



def test_direct_add_is_the_category_the_arr_never_polls():
    # The whole point of B: not `radarr`, not `tv-sonarr`.
    assert DIRECT_DOWNLOAD_CATEGORY == "flow"
