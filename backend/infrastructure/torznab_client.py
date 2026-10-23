"""Torznab client — direct indexer connections (S1/T2 of «indexadores-directos»).

The transport is the `prowlarr_client.py` mold with one deliberate difference:
`url` and `api_key` arrive as ARGUMENTS of every call (they come from the rows
of the `indexers` table — there is no `find_service` for this one), the `session`
seam falls back to `state.http_session()`, the timeout scales `REQUEST_TIMEOUT`
×12 (`arr_fetch_releases` does the same for its own indexer fan-out) and the
query travels as a `params=` MAPPING so aiohttp percent-encodes UTF-8 — raw
Cyrillic spliced into the URL is an instant HTTP 400 (lesson #218).

Endpoints (both `GET {url}` with the params as query string, `apikey` as a
query param like `arr_client.py:1089-1093` does):

- ``t=caps`` — autodiscovery: which searches the indexer answers, with their
  `supportedParams`, and its categories as plain ``{id, name}`` rows INCLUDING
  subcats. NoNaMe reports custom 100xxx ids, so category ids are data, never
  constants: `cat=` travels only when the caller explicitly passes `cats`.
- ``t=search|movie|tvsearch`` — RSS 2.0 parsed with `ElementTree` (the
  `arr_client.py:1108-1130` precedent): `item/enclosure@url|@length`, `guid`,
  `title`, `pubDate`, and `torznab:attr` name/value pairs (`seeders`, `size`,
  `infohash`) — the `xmlns:torznab="http://torznab.com/schemas/2015/feed"`
  namespace is matched by local name so a feed that forgets to declare the
  prefix still parses. Rows are normalized to
  ``{title, link, guid, size, seeders, infohash, published}`` with ints and
  ``None`` for whatever is missing.

Download/infohash values are copied VERBATIM: link templates are never
expanded into URLs and an `infohash` is never rebuilt into a magnet — the only
magnet that reaches `link` is the one already literal in the feed.

Failures raise `aiohttp.ClientError`: a non-200 answer carries its body, and
a body that is not XML is the same kind of failure (nothing silent, nothing
empty-disguised-as-success).

Query shaping mirrors `arr_client._search_query` byte-for-byte (the
`arr_client.py:1028-1046` precedent): head before the first parenthetical,
cut at the first quality token, dots to spaces, the year appended when the
title carries one, and an 8-token cap.
"""

import re
import xml.etree.ElementTree as ElementTree

import aiohttp

import config
from state import http_session

__all__ = ["torznab_caps", "torznab_search"]

#: Fan-out search, multiple of `REQUEST_TIMEOUT` (see the module docstring).
TIMEOUT_MULTIPLE = 12

#: Quality-token cut of `_search_query`: everything from `.<quality>` on dies.
_QUALITY_TOKENS = (
    r"\.(?=(?:1080p|720p|2160p|4k|HDTV|WEB-?DL|BluRay|BDRip|HDRip|VHS)\b)"
)


def _search_query(title: str) -> str:
    """The query a slow index network can answer — measured, not assumed.

    Byte-for-byte mirror of `arr_client._search_query` (and of the one in
    `grab_release`): the full release name times out while "Name Year" answers
    in ~30 s. This layer may not import an adapter, so the pure normalization
    travels with the code that needs it.
    """
    head = re.split(r"[()]", title, maxsplit=1)[0]
    head = re.split(_QUALITY_TOKENS, head, maxsplit=1, flags=re.IGNORECASE)[0]
    tokens = head.replace(".", " ").split()
    year = re.search(r"\(((?:19|20)\d{2})\)", title)
    if year:
        tokens.append(year.group(1))
    return " ".join(tokens[:8]).strip()


async def torznab_caps(url: str, api_key: str, *, session=None) -> dict:
    """`t=caps` autodiscovery of one indexer, as plain data.

    Answers ``{"searches": {<type>: {"available": bool,
    "supported_params": [...]}}, "categories": [{"id": int, "name": str}]}`` —
    categories include subcats as flat `{id, name}` rows in document order,
    and `supported_params` is the search's `supportedParams` attribute split
    on commas. `session` is the HTTP seam: tests hand over a stub, a caller
    with none gets the shared one. Raises `aiohttp.ClientError` on HTTP or
    XML failures.
    """
    params = {"t": "caps", "apikey": api_key}
    if session is not None:
        return _parse_caps(await _get_root(session, url, params))
    async with http_session() as own:
        return _parse_caps(await _get_root(own, url, params))


async def torznab_search(
    url: str,
    api_key: str,
    *,
    query: str,
    cats=None,
    t: str = "search",
    session=None,
) -> list[dict]:
    """`t=search|movie|tvsearch` of one indexer, as normalized rows.

    `query` travels as the user wrote it (the `prowlarr_search` rule) inside
    the params MAPPING — the percent-encoding seam. `cat=` travels ONLY when
    the caller explicitly passes a non-empty `cats` (a hardcoded filter answers
    0 releases on real indexers); `t` reaches the wire verbatim. Rows are
    ``{title, link, guid, size, seeders, infohash, published}`` with ints and
    ``None`` for whatever is missing — `size` comes from `enclosure@length`
    and falls back to the `size` attr when the enclosure carries none. Same
    seam and same `aiohttp.ClientError` contract as `torznab_caps`.
    """
    params = {"t": t, "q": query, "apikey": api_key}
    if cats:
        params["cat"] = ",".join(str(cat) for cat in cats)
    if session is not None:
        return _parse_rows(await _get_root(session, url, params))
    async with http_session() as own:
        return _parse_rows(await _get_root(own, url, params))


# ── transport ─────────────────────────────────────────────────────────────────


async def _get_root(session, url: str, params: dict) -> ElementTree.Element:
    """The XML root of the answer, or `aiohttp.ClientError` — never silence."""
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * TIMEOUT_MULTIPLE)
    # `params=` is load-bearing: it is what percent-encodes the query.
    async with session.get(url, params=params, timeout=timeout) as resp:
        if resp.status != 200:
            text = await resp.text()
            raise aiohttp.ClientError(f"HTTP {resp.status}: {text[:200]}")
        text = await resp.text()
    try:
        return ElementTree.fromstring(text)
    except ElementTree.ParseError as exc:
        raise aiohttp.ClientError(f"invalid XML from torznab: {exc}") from exc


# ── caps parsing ──────────────────────────────────────────────────────────────


def _parse_caps(root: ElementTree.Element) -> dict:
    return {"searches": _parse_searches(root), "categories": _parse_categories(root)}


def _parse_searches(root: ElementTree.Element) -> dict:
    searches = {}
    searching = root.find("searching")
    if searching is None:
        return searches
    for entry in searching:
        supported = entry.get("supportedParams") or ""
        searches[entry.tag] = {
            "available": (entry.get("available") or "").lower() in ("yes", "true", "1"),
            "supported_params": [p.strip() for p in supported.split(",") if p.strip()],
        }
    return searches


def _parse_categories(root: ElementTree.Element) -> list[dict]:
    """Flat `{id, name}` rows in document order, subcats included."""
    categories = []
    group = root.find("categories")
    if group is None:
        return categories
    for category in group:
        categories.append(_category_row(category))
        categories.extend(_category_row(sub) for sub in category)
    return categories


def _category_row(element: ElementTree.Element) -> dict:
    raw_id = element.get("id") or ""
    try:
        category_id = int(raw_id)
    except ValueError:
        category_id = raw_id
    return {"id": category_id, "name": element.get("name") or ""}


# ── RSS 2.0 parsing ───────────────────────────────────────────────────────────


def _parse_rows(root: ElementTree.Element) -> list[dict]:
    rows = []
    for item in root.iter("item"):
        enclosure = item.find("enclosure")
        attrs = _torznab_attrs(item)
        size = _int(enclosure.get("length")) if enclosure is not None else None
        if not size:
            size = _int(attrs.get("size"))
        rows.append(
            {
                "title": _text(item.findtext("title")),
                "link": _text(enclosure.get("url")) if enclosure is not None else None,
                "guid": _text(item.findtext("guid")),
                "size": size,
                "seeders": _int(attrs.get("seeders")),
                "infohash": _text(attrs.get("infohash")),
                "published": _text(item.findtext("pubDate")),
            }
        )
    return rows


def _torznab_attrs(item: ElementTree.Element) -> dict:
    """`torznab:attr` name/value pairs, matched by local name.

    The `http://torznab.com/schemas/2015/feed` namespace is what the spec
    declares, but real feeds also emit the literal `torznab:attr` prefix when
    they forget `xmlns:torznab` — both must parse to the same pairs.
    """
    attrs = {}
    for element in item.iter():
        local = element.tag.rsplit("}", 1)[-1].rsplit(":", 1)[-1]
        if local == "attr":
            name = element.get("name")
            if name:
                attrs[name] = element.get("value")
    return attrs


def _int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _text(value) -> str | None:
    return (value or "").strip() or None
