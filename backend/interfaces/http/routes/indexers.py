"""«Indexadores» — CRUD de indexadores Torznab de conexión directa (T3, S2-S3).

Each row is a third-party API key (risk 2), so the discipline is part of the
contract, not an afterthought:

* every response carries `api_key` MASKED (`routes/settings.py:122-128`:
  `"****" + last4`) — no public path may ever return a raw key;
* a PUT body whose `api_key` is EMPTY or still MASKED keeps the stored key
  (S3): the form posts secrets back as shown, and saving that verbatim once
  destroyed every stored credential (`routes/settings.py`'s lesson);
* `POST /{id}/test` is a PROBE: it calls `t=caps` with the row's url+key,
  persists NOTHING, and answers 200 with `{"ok": true, "caps"}` or
  `{"ok": false, "detail"}` in both directions — the honest-refusal shape the
  rest of the repo uses. The detail is the exception's short text with the
  key REDACTED, never a raw traceback.

Duplicate name or URL: one consistent, loud behavior — 409 with a Spanish
detail naming the field. First-wins would silently register the same indexer
twice and T4 would then query it twice per search; a UI list cannot tell two
identical names apart. Names and URLs are compared exactly after stripping:
canonicalising URLs is not ours to decide (paths and case can be load-bearing
on the far side).

Wiring note: the Torznab client is an ADAPTER and `interfaces/` may not
import `infrastructure/` (`tests_architecture`). `app.py` — the one file
allowed to hold an adapter — puts it in this module's hand (`torznab` below);
with no hand-off the probe answers `ok:false` instead of crashing.
"""

import asyncio
import re
from urllib.parse import urlsplit

import aiohttp
from fastapi import APIRouter, Depends, HTTPException

from application.gateways import history, store_available
from interfaces.http.deps import verify_api_key

router = APIRouter()

#: The Torznab adapter module, handed over by the composition root (app.py).
#: Tests replace it with a stub — never a real network call.
torznab = None

#: A stored secret is shown to the UI as this prefix plus its last characters.
#: Anything still carrying the prefix means the user did not change it.
MASK_PREFIX = "****"


def _is_mask(value) -> bool:
    return isinstance(value, str) and value.startswith(MASK_PREFIX)


def _incoming_key(body: dict) -> str | None:
    """The key the body really means: `None` = keep the stored one.

    Empty means KEEP and a masked value means KEEP too (S3 and the historic
    bug in `routes/settings.py`): only a value that is neither absent, nor
    blank, nor a mask replaces the stored key.
    """
    value = body.get("api_key")
    if value is None:
        return None
    text = str(value)
    if not text.strip() or _is_mask(text):
        return None
    return text


def _validated(body: dict, base: dict | None) -> tuple[str, str, str, int]:
    """name/url/categories/enabled after validation, or a Spanish 422.

    `base` is the stored row for a PUT — every field the body omits keeps its
    value — and `None` for a POST, where name and url are required.
    """
    base = base or {}

    def pick(field: str) -> str:
        value = body.get(field)
        if value is None:
            return str(base.get(field, "") or "")
        return str(value)

    name = pick("name").strip()
    url = pick("url").strip()
    if not name:
        raise HTTPException(422, "el nombre es obligatorio")
    if not url:
        raise HTTPException(422, "la URL es obligatoria")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise HTTPException(422, "la URL debe empezar por http:// o https://")
    categories = pick("categories")
    if body.get("enabled") is not None:
        enabled = 1 if body["enabled"] else 0
    else:
        enabled = int(base.get("enabled", 1) or 0)
    return name, url, categories, enabled


async def _reject_duplicate(name: str, url: str, exclude_id: int | None) -> None:
    """409 naming the field — see the module docstring for why not first-wins."""
    for row in await asyncio.to_thread(history.indexers_list):
        if exclude_id is not None and row["id"] == exclude_id:
            continue
        if row["name"] == name:
            raise HTTPException(409, f"ya existe un indexador con el nombre «{name}»")
        if row["url"] == url:
            raise HTTPException(409, "ya existe un indexador con esa URL")


def _redact(text: str, key: str) -> str:
    """The error text without the api_key — twice over.

    The key travels as a query PARAM, so an exception that echoes the URL
    carries it (`apikey=...`) even when the message never names it. Both
    shapes go: the literal key and any `apikey=` value.
    """
    if key:
        text = text.replace(key, MASK_PREFIX)
    return re.sub(r"(?i)(apikey=)[^&\s]*", r"\g<1>" + MASK_PREFIX, text)


@router.get("/api/indexers")
async def list_indexers(_key: str = Depends(verify_api_key)):
    """The registry, api_key masked.

    An unavailable store is an honest empty list WITH a reason (the auto-copy
    precedent) — never a 500, never silence disguised as "no indexers".
    """
    rows = await asyncio.to_thread(history.indexers_list)
    if not store_available():
        return {"indexers": [], "error": "el almacén de indexadores no está disponible"}
    return {"indexers": rows}


@router.post("/api/indexers")
async def create_indexer(body: dict, _key: str = Depends(verify_api_key)):
    name, url, categories, enabled = _validated(body, None)
    if _is_mask(body.get("api_key")):
        raise HTTPException(422, "la api_key no puede ser una máscara: escribe la clave real")
    await _reject_duplicate(name, url, exclude_id=None)
    key = str(body.get("api_key") or "")
    row = await asyncio.to_thread(
        history.indexer_create, name, url, key, categories, enabled
    )
    if row is None:
        raise HTTPException(503, "el almacén de indexadores no está disponible")
    return {"ok": True, "indexer": row}


@router.put("/api/indexers/{id}")
async def update_indexer(id: int, body: dict, _key: str = Depends(verify_api_key)):
    rows = await asyncio.to_thread(history.indexers_list)
    current = next((row for row in rows if row["id"] == id), None)
    if current is None:
        if not store_available():
            raise HTTPException(503, "el almacén de indexadores no está disponible")
        raise HTTPException(404, "Indexador no encontrado")
    name, url, categories, enabled = _validated(body, current)
    await _reject_duplicate(name, url, exclude_id=id)
    row = await asyncio.to_thread(
        history.indexer_update,
        id,
        name=name,
        url=url,
        api_key=_incoming_key(body),
        categories=categories,
        enabled=enabled,
    )
    if row is None:
        raise HTTPException(503, "el almacén de indexadores no está disponible")
    return {"ok": True, "indexer": row}


@router.delete("/api/indexers/{id}")
async def delete_indexer(id: int, _key: str = Depends(verify_api_key)):
    if await asyncio.to_thread(history.indexer_delete, id):
        return {"ok": True}
    if not store_available():
        raise HTTPException(503, "el almacén de indexadores no está disponible")
    raise HTTPException(404, "Indexador no encontrado")


@router.post("/api/indexers/{id}/test")
async def test_indexer(id: int, _key: str = Depends(verify_api_key)):
    """`t=caps` against the row — a probe, so it always answers 200 with the
    `{"ok": true, "caps"}` or `{"ok": false, "detail"}` shape (S3) and
    persists NOTHING: whatever the indexer answers, the row is untouched.
    """
    if not store_available():
        return {"ok": False, "detail": "el almacén de indexadores no está disponible"}
    rows = await asyncio.to_thread(history.indexers_raw, indexer_id=id)
    if not rows:
        return {"ok": False, "detail": "Indexador no encontrado"}
    row = rows[0]
    key = row["api_key"]
    if key is None:
        return {"ok": False, "detail": "no se pudo descifrar la api_key guardada (¿cambió FC_SECRET?)"}
    if torznab is None:
        return {"ok": False, "detail": "cliente Torznab no disponible"}
    try:
        caps = await torznab.torznab_caps(row["url"], key)
    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
        detail = str(exc).strip() or type(exc).__name__
        return {"ok": False, "detail": _redact(detail, key)}
    return {"ok": True, "caps": caps}
