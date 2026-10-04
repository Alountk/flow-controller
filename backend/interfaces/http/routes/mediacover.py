"""Bounded proxy for the arrs' poster images (``/MediaCover/…``).

Radarr and Sonarr report posters as ``/MediaCover/…`` paths (their ``urlBase``
is ``/``), so the browser resolves them against THIS app's origin — where
nothing serves ``/MediaCover`` and every poster fell back to initials. This
router fetches the image server-side, with the arr's API key attached here
where the browser can never see it.
"""

import asyncio
import posixpath
from contextlib import AsyncExitStack
from urllib.parse import unquote, urlsplit

import aiohttp
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

import config
from application.gateways import arr_headers
from config import find_service
from state import http_session

router = APIRouter()

CHUNK_SIZE = 64 * 1024
MEDIA_PREFIX = "MediaCover/"


def _safe_mediacover_path(rest: str) -> str | None:
    """The upstream path ``rest`` is allowed to fetch — or ``None`` (refuse it).

    The ORDER is the whole defence: decode, normalise (collapsing ``..``
    segments), and only then require the ``MediaCover/`` prefix. Checking the
    prefix first would pass ``MediaCover/../../api/v3/system/status`` — the
    raw string does start with ``MediaCover/`` — and only collapse it
    afterwards, into a request to an arbitrary endpoint. Percent-encoded dots
    (``%2e%2e``, including double-encoded ones) are decoded before collapsing
    so they cannot dodge the normalisation either; an absolute rest or one
    carrying a scheme/host is refused outright.
    """
    if not rest:
        return None
    decoded = unquote(rest)
    for candidate in (rest, decoded):
        if candidate.startswith(("/", "\\")) or "\\" in candidate:
            return None
        if "?" in candidate or "#" in candidate:
            return None
        split = urlsplit(candidate)
        if split.scheme or split.netloc:
            return None
    path = posixpath.normpath(decoded)
    if not path.startswith(MEDIA_PREFIX):
        return None
    return path


@router.get("/api/mediacover/{source}/{rest:path}")
async def get_mediacover_image(source: str, rest: str, request: Request) -> Response:
    """Stream one poster image from a configured arr.

    Deliberately NOT behind ``verify_api_key``: an ``<img src>`` cannot send
    an ``X-Api-Key`` header, so gating this route would silently blank every
    poster in the UI the moment anyone configured an app key — a landmine
    nobody would find until posters broke. The trade-off is bounded on
    purpose: this route exposes only the bytes of poster images from
    already-configured arr services — ``source`` must resolve through
    ``find_service(source, "arr")`` (unknown or unconfigured → 404) and
    ``rest`` must normalise to a ``MediaCover/…`` path (anything else → 404,
    see ``_safe_mediacover_path``) — so neither the arr's URL nor its API key
    can be read through it, while the rest of the API stays gated by
    ``verify_api_key`` as before.

    Upstream failures never 500: a connection failure answers 502 and any
    other non-200 status passes through with a short body of our own — no
    upstream URL, no API key and no stack trace ever reach the browser.
    """
    service = find_service(source, "arr")
    if service is None:
        raise HTTPException(status_code=404, detail="Fuente no disponible")
    upstream_path = _safe_mediacover_path(rest)
    if upstream_path is None:
        raise HTTPException(status_code=404, detail="Ruta no válida")

    upstream_url = f"{service['url'].rstrip('/')}/{upstream_path}"
    query = str(request.url.query)
    if query:
        upstream_url = f"{upstream_url}?{query}"

    stack = AsyncExitStack()
    try:
        session = await stack.enter_async_context(http_session())
        upstream = await stack.enter_async_context(
            session.get(
                upstream_url,
                headers=arr_headers(service["api_key"]),
                timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT),
            )
        )
    except (asyncio.TimeoutError, aiohttp.ClientError):
        await stack.aclose()
        raise HTTPException(status_code=502, detail="Sin respuesta de la fuente")
    except ValueError:
        await stack.aclose()
        raise HTTPException(status_code=404, detail="Ruta no válida")

    if upstream.status != 200:
        await stack.aclose()
        return Response(
            content=f"La fuente respondió HTTP {upstream.status}",
            status_code=upstream.status,
            media_type="text/plain; charset=utf-8",
        )

    content_type = upstream.headers.get("Content-Type", "application/octet-stream")

    async def _stream():
        try:
            async for chunk in upstream.content.iter_chunked(CHUNK_SIZE):
                yield chunk
        finally:
            # Runs on completion AND on a client disconnect (GeneratorExit),
            # so the connection and, outside a lifespan, the session itself
            # are always released.
            await stack.aclose()

    return StreamingResponse(
        _stream(),
        status_code=200,
        media_type=content_type,
        # Upstream URLs already carry a `?h=…` cache-buster; a private,
        # modest max-age keeps posters off shared caches but out of the way
        # of re-renders.
        headers={"Cache-Control": "private, max-age=3600"},
    )
