"""Prowlarr text search — the «Buscar y descargar alternativa» language search (S6/T2).

Radarr searches by id and falls back to Original/English/Translated titles, so
a Russian release for «Arthur and the Invisibles» is invisible to it (feature
doc S2/S3). This client searches Prowlarr with THE TERM THE USER WROTE, in the
language the release actually uses.

The wire format is the frozen 2026-10-21 probe against the real Prowlarr:

- `GET {url}/api/v1/search` with `X-Api-Key: {key}` and params
  `query=<term>&type=search`. The query travels as a params MAPPING so aiohttp
  percent-encodes it: raw UTF-8/Cyrillic spliced into the URL is an instant
  HTTP 400.
- NO `categories` filter: NoNaMe Club reports custom category ids (100091…)
  and classes movies under TV/Other — `categories=2000,2010` answered 0 where
  the bare query answered 31 Russian releases. No `indexerIds` either (a
  REPEATED parameter in v1; T2 does not need it).
- The answer is a JSON array of releases (`title`, `indexer`, `size`,
  `seeders`, `guid`, `magnetUrl`, `downloadUrl`, …), normalized here to
  snake_case with the download urls included ONLY when non-null.
- Relevance filter: dmhy answers dozens of year-only matches for Cyrillic
  queries, so a release survives only when its title contains at least one
  QUERY token that is not purely numeric and is >= 3 chars (case-insensitive).
  «Артур» is what keeps «Артур и минипуты» for the query «Артур и минимоны».

The service is read exactly like `services.radarr` is — `find_service` — and
absent config raises the same «no está configurado» reason the API surfaces;
the route fails closed before ever calling here. `arr_fetch_releases` scales
`REQUEST_TIMEOUT` in multiples for its own indexer fan-out; this is the same
kind of fan-out (probe: 3–20 s), hence ×12 — 60 s at the 5 s default.
"""

import re

import aiohttp

import config
from state import http_session

#: `GET {url}/api/v1/search` — Prowlarr's release text search.
SEARCH_PATH = "/api/v1/search"

#: Fan-out search, multiple of `REQUEST_TIMEOUT` (see the module docstring).
TIMEOUT_MULTIPLE = 12

#: A query token must reach this length to count for the relevance filter.
MIN_TOKEN_LENGTH = 3


def prowlarr_headers(api_key: str) -> dict:
    return {"accept": "application/json", "X-Api-Key": api_key}


def _query_tokens(query: str) -> list[str]:
    """The query's words that can make a title relevant.

    Not purely numeric (a year is not a topic) and at least
    `MIN_TOKEN_LENGTH` chars (short tokens substring-match everything).
    """
    return [
        token
        for token in re.split(r"\W+", query.casefold())
        if len(token) >= MIN_TOKEN_LENGTH and not token.isdigit()
    ]


def _is_relevant(query: str, title: str) -> bool:
    haystack = (title or "").casefold()
    return any(token in haystack for token in _query_tokens(query))


def _normalize(release: dict) -> dict:
    item = {
        "title": release.get("title") or "",
        "indexer": release.get("indexer") or "",
        "size": release.get("size"),
        "seeders": release.get("seeders"),
        "guid": release.get("guid") or "",
    }
    magnet_url = release.get("magnetUrl") or None
    download_url = release.get("downloadUrl") or None
    if magnet_url:
        item["magnet_url"] = magnet_url
    if download_url:
        item["download_url"] = download_url
    return item


async def prowlarr_search(query: str, *, session=None) -> list[dict]:
    """Search Prowlarr for `query` and answer the relevant, normalized releases.

    `session` is the HTTP seam: the route hands over its own, tests hand over a
    stub, and a caller with neither gets the shared one. Raises `RuntimeError`
    when the `prowlarr` service is not configured and `aiohttp.ClientError` /
    `asyncio.TimeoutError` on transport or HTTP failures (the route maps those).
    """
    service = config.find_service("prowlarr", "prowlarr")
    if not service:
        raise RuntimeError(config.service_unavailable_reason("prowlarr", "prowlarr"))
    if session is not None:
        return await _search(session, service, query)
    async with http_session() as own:
        return await _search(own, service, query)


async def _search(session, service: dict, query: str) -> list[dict]:
    # `params=` is load-bearing: it is what percent-encodes the query.
    params = {"query": query, "type": "search"}
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * TIMEOUT_MULTIPLE)
    url = f"{service['url']}{SEARCH_PATH}"
    async with session.get(
        url, headers=prowlarr_headers(service["api_key"]), params=params, timeout=timeout
    ) as resp:
        if resp.status != 200:
            text = await resp.text()
            raise aiohttp.ClientError(f"HTTP {resp.status}: {text[:200]}")
        try:
            data = await resp.json(content_type=None)
        except ValueError as exc:
            raise aiohttp.ClientError(f"invalid JSON from prowlarr: {exc}") from exc
    raw = data if isinstance(data, list) else []
    return [
        _normalize(release)
        for release in raw
        if isinstance(release, dict) and _is_relevant(query, release.get("title") or "")
    ]
