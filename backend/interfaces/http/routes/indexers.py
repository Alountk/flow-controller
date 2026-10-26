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

The T4/S4 unified search (`POST /api/indexers/search`) lives here too: one
query fans out over the ENABLED Torznab rows plus `prowlarr_search` and
`gateways.amule_search` in parallel, and one source's failure never discards
another's results — every absence is a `skipped` entry with an honest reason,
never a silent `[]`. The optional `indexer_ids` body field (T2/S3) narrows
the Torznab fan-out to a per-row subset of the registry.

The T5/S5 download (`POST /api/indexers/download`, the L6 amendment) is the
free search's «Descargar»: `POST /api/calendar/grab` needs an arr service and
a movieId/episodeId the free rows do not have, so this one dispatches by the
SHAPE of the target and persists nothing — `ed2k://` to the direct EC seam
(or, under the `AMULE_EC_DIRECT=0` rollback, to the legacy aMuTorrent bridge),
a 32-hex aMule hash-id to `amule_download_search_result` (a hash has no
bridge entry point under the rollback — an honest refusal says so), and
`magnet:`/`http(s)` to the bridge with `routes_mixer.py:591-631`'s exact
session and `{ok, detail}` mapping. 200 with `ok`/`detail` in BOTH directions,
like every refusal in this repo.
"""

import asyncio
import os
import re
from urllib.parse import urlsplit

import aiohttp
from fastapi import APIRouter, Depends, HTTPException

from application import gateways
from application.gateways import history, store_available
from config import find_service, service_unavailable_reason
from interfaces.http.deps import verify_api_key
from state import http_session

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


# ── T4/S4: the unified parallel search ──────────────────────────────────────────
#
# The gateways seams below are reached as MODULE attributes on purpose: they
# resolve the bound adapter on every call (`gateways`' own contract) and the
# suite replaces them at that seam — a from-import would freeze the reference.


#: The searchable sources, in the order their rows merge into the answer.
SOURCES = ("torznab", "amule", "prowlarr")

#: Mirror of `prowlarr_client.MIN_TOKEN_LENGTH` — see `_query_tokens`.
MIN_TOKEN_LENGTH = 3


def _query_tokens(query: str) -> list[str]:
    r"""Byte-identical mirror of `prowlarr_client._query_tokens` (rule #218).

    The frozen relevance rule lives in `infrastructure` as private helpers and
    `interfaces/` may not import `infrastructure/` (`tests_architecture`), so
    the rule is REPLICATED here — same `\W+` split, same casefold, same
    minimum length, same digit rejection — rather than relaxed into a second,
    softer rule. Relaxed would silently re-admit the year-only junk #218
    dropped.
    """
    return [
        token
        for token in re.split(r"\W+", query.casefold())
        if len(token) >= MIN_TOKEN_LENGTH and not token.isdigit()
    ]


def _is_relevant(query: str, title: str) -> bool:
    """Byte-identical mirror of `prowlarr_client._is_relevant` (rule #218).

    A row survives only when its name contains at least one QUERY token that
    is not purely numeric and is >= 3 chars (case-insensitive).
    """
    haystack = (title or "").casefold()
    return any(token in haystack for token in _query_tokens(query))


def _skip_reason(exc: BaseException) -> str:
    """Why something is skipped — never a traceback, never a dangling colon.

    `RuntimeError` is the seams' DESIGNED fail-closed refusal (their shared
    `service_unavailable_reason` contract), so its message travels verbatim,
    exactly as `grab_release.py:219-223` maps it; anything else is an accident
    and gets the honest short `Tipo: mensaje` of `grab_release._ec_add_link`.
    """
    if isinstance(exc, RuntimeError):
        return str(exc).strip() or type(exc).__name__
    return f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__


def selected_sources(raw) -> list[str]:
    """The subset to search, in canonical order — or a Spanish 400.

    Absent, null and `[]` all mean «no filter» and search the three sources:
    the contract's default. Anything else must be a LIST of known names — one
    typo must never silently widen or narrow the search (400 naming it).
    """
    if raw is None or raw == []:
        return list(SOURCES)
    if not isinstance(raw, list):
        raise HTTPException(400, "sources debe ser una lista de fuentes")
    unknown = [str(item) for item in raw if item not in SOURCES]
    if unknown:
        raise HTTPException(400, f"fuente desconocida: «{unknown[0]}»")
    return [source for source in SOURCES if source in raw]


def selected_indexer_ids(raw) -> frozenset[int] | None:
    """The per-row subset of the Torznab registry — or a Spanish 400 (T2/S3).

    Absent, null and `[]` all mean «no filter» and query every enabled row —
    the `selected_sources` default precedent, byte-identical to today.
    Anything else must be a LIST of positive integer ids: `bool`, `float`,
    `str`, zero and negatives are NOT ids, and one bad entry is a 400 naming
    it (the `selected_sources` honesty style) — never a silently widened or
    narrowed search. Ids that match no enabled row are NOT this validator's
    business (L6e: a concurrently deleted indexer must not break the
    search): the fan-out answers them with an honest `skipped` entry.
    """
    if raw is None or raw == []:
        return None
    if not isinstance(raw, list):
        raise HTTPException(400, "indexer_ids debe ser una lista de ids")
    for item in raw:
        if isinstance(item, bool) or not isinstance(item, int) or item < 1:
            raise HTTPException(400, f"id de indexador no válido: «{item}»")
    return frozenset(raw)


def _torznab_row(indexer: str, raw: dict) -> dict:
    """One T2 row merged into the shared shape — only what really exists."""
    row = {
        "source": "torznab",
        "indexer": indexer,
        "name": raw.get("title") or "",
        "size": raw.get("size"),
    }
    for key in ("seeders", "infohash", "link", "guid"):
        value = raw.get(key)
        if value is not None and value != "":
            row[key] = value
    return row


def _prowlarr_row(raw: dict) -> dict:
    """One `prowlarr_search` row merged in — the magnet wins the `link` slot.

    The grab flow resolves a `magnet:` guid verbatim (`grab_release.py:203`),
    so when a row has both urls the magnet is the one worth keeping in the
    single `link` field the shared shape offers.
    """
    row = {"source": "prowlarr", "name": raw.get("title") or "", "size": raw.get("size")}
    for key in ("indexer", "seeders", "guid"):
        value = raw.get(key)
        if value is not None and value != "":
            row[key] = value
    link = raw.get("magnet_url") or raw.get("download_url")
    if link:
        row["link"] = link
    return row


def _amule_row(result) -> dict:
    """One `SearchResult` merged in — `sources` stays `sources`.

    The honesty rule: aMule's `sources` is a count of ED2K sources, NOT
    seeders — different magnitudes, and this repo never lies about data. The
    file hash travels as `guid` (the hash-id shape the grab flow joins on,
    `grab_release.py:241-246`) and as the standard ed2k `link` built from the
    same three fields `grab_release.py:262` uses.
    """
    name = getattr(result, "name", "") or ""
    size = getattr(result, "size", None)
    row = {"source": "amule", "name": name, "size": size}
    count = getattr(result, "sources", None)
    if count is not None:
        row["sources"] = count
    file_hash = getattr(result, "file_hash", "") or ""
    if file_hash:
        row["guid"] = file_hash
        if name and size is not None:
            row["link"] = f"ed2k://|file|{name}|{size}|{file_hash}|/"
    return row


async def _torznab_row_call(query: str, row: dict) -> dict:
    """One indexer's search — its own rows and its own skipped entries.

    `api_key is None` is the store's hard «cannot decrypt» signal (a rotated
    `FC_SECRET`): the row is skipped by name and NEVER sent — unreadable
    ciphertext must not travel as a credential. A failing indexer gets the
    probe endpoint's `_redact` treatment before its text reaches the answer.
    """
    name = row.get("name") or ""
    key = row.get("api_key")
    if key is None:
        return {
            "rows": [],
            "ok": False,
            "skipped": [{
                "source": "torznab",
                "reason": (
                    f"indexador «{name}»: no se pudo descifrar la api_key "
                    "guardada (¿cambió FC_SECRET?)"
                ),
            }],
        }
    if torznab is None:
        return {
            "rows": [],
            "ok": False,
            "skipped": [{"source": "torznab", "reason": "cliente Torznab no disponible"}],
        }
    try:
        found = await torznab.torznab_search(row.get("url") or "", key, query=query)
    except Exception as exc:  # noqa: BLE001 — un indexador caído jamás tira la fuente
        reason = _redact(_skip_reason(exc), key)
        return {
            "rows": [],
            "ok": False,
            "skipped": [{"source": "torznab", "reason": f"indexador «{name}»: {reason}"}],
        }
    return {"rows": [_torznab_row(name, raw) for raw in found], "ok": True, "skipped": []}


async def _search_torznab(
    query: str, indexer_ids: frozenset[int] | None = None
) -> dict:
    """Every ENABLED row in parallel — one bad indexer never drops the rest.

    `indexer_ids` narrows the fan-out to a per-row subset of the registry
    (T2/S3): a disabled id is simply not in the intersection, and a selection
    whose intersection with the enabled rows is empty is SKIPPED with its own
    honest reason — never a 400 (L6e: a concurrently deleted indexer must not
    break the search) and never a silent zero dressed up as «sin resultados».
    """
    rows = await asyncio.to_thread(history.indexers_raw)
    if indexer_ids is not None:
        rows = [row for row in rows if row.get("id") in indexer_ids]
        if not rows:
            return {
                "rows": [],
                "ok": False,
                "skipped": [{
                    "source": "torznab",
                    "reason": "ningún indexador de los seleccionados está habilitado",
                }],
            }
    if not rows:
        return {
            "rows": [],
            "ok": False,
            "skipped": [{"source": "torznab", "reason": "sin indexadores habilitados"}],
        }
    calls = await asyncio.gather(
        *(_torznab_row_call(query, row) for row in rows), return_exceptions=True
    )
    merged: list[dict] = []
    skipped: list[dict] = []
    answered = False
    for outcome in calls:
        if isinstance(outcome, BaseException):
            skipped.append({"source": "torznab", "reason": _skip_reason(outcome)})
            continue
        merged.extend(outcome["rows"])
        skipped.extend(outcome["skipped"])
        answered = answered or outcome["ok"]
    return {"rows": merged, "ok": answered, "skipped": skipped}


async def _search_amule(query: str) -> dict:
    """aMule via the EC seam — SYNC, so it rides `asyncio.to_thread` (the
    `grab_release` `record_own_grab` precedent): ED2K is slow and the event
    loop is not ours to block.
    """
    try:
        found = await asyncio.to_thread(gateways.amule_search, query)
    except Exception as exc:  # noqa: BLE001 — errores EC tipados + la negativa «no configurado»
        return {
            "rows": [],
            "ok": False,
            "skipped": [{"source": "amule", "reason": _skip_reason(exc)}],
        }
    return {"rows": [_amule_row(item) for item in found], "ok": True, "skipped": []}


async def _search_prowlarr(query: str) -> dict:
    """Prowlarr behind the `routes_mixer` gate: absent config fails closed
    before ever calling out (`service_unavailable_reason`), and a refusal or
    failure becomes a `skipped` entry — never a 502 that would discard the
    other sources' results.
    """
    if not find_service("prowlarr", "prowlarr"):
        return {
            "rows": [],
            "ok": False,
            "skipped": [{
                "source": "prowlarr",
                "reason": service_unavailable_reason("prowlarr", "prowlarr"),
            }],
        }
    try:
        async with http_session() as session:
            found = await gateways.prowlarr_search(query, session=session)
    except Exception as exc:  # noqa: BLE001 — la negativa «no configurado» + errores de transporte
        return {
            "rows": [],
            "ok": False,
            "skipped": [{"source": "prowlarr", "reason": _skip_reason(exc)}],
        }
    return {"rows": [_prowlarr_row(raw) for raw in found], "ok": True, "skipped": []}


_SOURCE_TASKS = {
    "torznab": _search_torznab,
    "amule": _search_amule,
    "prowlarr": _search_prowlarr,
}


def _source_task(source: str, query: str, indexer_ids: frozenset[int] | None):
    """Bind the per-row filter to the only per-row source.

    `indexer_ids` narrows the Torznab REGISTRY fan-out (T2/S3); `amule` and
    `prowlarr` are single services, not registry rows, so the selection can
    never narrow them — they run exactly as today.
    """
    if source == "torznab":
        return _search_torznab(query, indexer_ids)
    return _SOURCE_TASKS[source](query)


async def search_sources(
    query: str, sources=None, indexer_ids=None, *, raw_counts: bool = False
) -> dict:
    """The fan-out over our own sources — serves BOTH `POST /api/indexers/search` and the calendar release job (S1). `raw_counts` adds the per-source pre-relevance tallies the calendar's honest detail needs."""
    selected = selected_sources(sources)
    indexer_ids = selected_indexer_ids(indexer_ids)

    outcomes = await asyncio.gather(
        *(_source_task(source, query, indexer_ids) for source in selected),
        return_exceptions=True,
    )
    results: list[dict] = []
    skipped: list[dict] = []
    raw_seen: dict[str, int] = {}
    answered = False
    for source, outcome in zip(selected, outcomes):
        if isinstance(outcome, BaseException):
            skipped.append({"source": source, "reason": _skip_reason(outcome)})
            continue
        answered = answered or outcome["ok"]
        skipped.extend(outcome["skipped"])
        raw_seen[source] = len(outcome["rows"])
        results.extend(row for row in outcome["rows"] if _is_relevant(query, row["name"]))

    if results or answered:
        answer = {"ok": True, "results": results, "skipped": skipped}
        if raw_counts:
            answer["raw_counts"] = raw_seen
        return answer
    return {
        "ok": False,
        "results": [],
        "skipped": skipped,
        "detail": (
            "todas las fuentes seleccionadas fallaron — "
            + "; ".join(f"{entry['source']}: {entry['reason']}" for entry in skipped)
        ),
    }


@router.post("/api/indexers/search")
async def search_indexers(body: dict, _key: str = Depends(verify_api_key)):
    """T4/S4 — ONE query over Torznab + aMule + Prowlarr, in parallel.

    Body `{query, sources?, indexer_ids?}`; every selected source runs
    concurrently (`asyncio.gather(..., return_exceptions=True)` per source)
    and answers its own rows and its own `skipped` entries, so one source's
    failure or absence NEVER discards another's results. `indexer_ids`
    (T2/S3) narrows the Torznab fan-out to a per-row subset of the registry;
    absent, null and `[]` query every enabled row, byte-identical to today.
    The answer is `{"ok", "results",
    "skipped"}` — plus a `detail` summary when EVERY selected source failed,
    because a silent `[]` disguised as «sin resultados» is the one answer S4
    refuses to give. The status stays 200 in that case, like every honest
    refusal in this repo (S3: «200 con ok:false en fallo»): one merged
    envelope must carry per-source truth, so the truth lives in `ok`/`skipped`
    and the status does not lie about partial success.
    """
    raw_query = body.get("query")
    query = raw_query.strip() if isinstance(raw_query, str) else ""
    if not query:
        raise HTTPException(400, "query is required")
    return await search_sources(query, body.get("sources"), body.get("indexer_ids"))


# ── T5/S5 (enmienda L6): the download dispatch ────────────────────────────────
#
# The free search has no arr service and no movieId/episodeId, so the calendar
# grab cannot serve it. One row in, one {ok, detail} out — no persistence, no
# query, and every refusal is a 200 like the rest of the repo's honest answers.

#: The aMule hash-id shape (`guid` of rows without a buildable ed2k link).
HASH32 = re.compile(r"[0-9a-fA-F]{32}\Z")

#: The pinned answers — `grab_release._ec_add_link`'s success text and
#: `routes_mixer.py:591-631`'s bridge mapping, mirrored byte for byte.
_EC_ADDED = "Descarga añadida"
_HASH_REFUSED_FLAG0 = (
    "el puente aMuTorrent no tiene entrada para el hash de aMule: "
    "esta fila sólo puede descargarse con el EC directo (AMULE_EC_DIRECT)"
)
_BAD_SCHEME = (
    "link no válido: se espera ed2k://, magnet:, http(s) o un hash de aMule (32 hex)"
)


def _ec_direct() -> bool:
    """Mirror of `grab_release._ec_direct` (same semantics, same contract):

    `AMULE_EC_DIRECT` is read from the environment on EVERY call, never
    cached — the mandated rollback must take effect on the next request
    without a restart. Unset or anything except `"0"` is the EC direct
    default; `"0"` is the exact legacy aMuTorrent path.
    """
    return os.environ.get("AMULE_EC_DIRECT") != "0"


def _download_target(body: dict) -> str:
    """The link or hash to act on — or the caller's Spanish 400.

    `link` wins over `guid` (the row's built link is the better target) and a
    blank value counts as absent. A non-string is malformed input, not an
    absent field: 400 says so before anything is sent anywhere.
    """
    values = {}
    for field in ("link", "guid"):
        value = body.get(field)
        if value is None:
            values[field] = ""
        elif not isinstance(value, str):
            raise HTTPException(400, "link y guid deben ser texto")
        else:
            values[field] = value.strip()
    target = values["link"] or values["guid"]
    if not target:
        raise HTTPException(400, "hace falta un link o un guid")
    return target


async def _download_ed2k(link: str, category: str | None = None) -> dict:
    """An ed2k link: the direct EC seam by default, the LEGACY aMuTorrent
    bridge under rollback (`_download_bridge_legacy` — S7: aMule's domain,
    never qBittorrent's).

    The EC adapter is SYNC, so the add rides `asyncio.to_thread` (the
    `grab_release._ec_add_link` precedent) and the tests hold it off the loop.
    A refusal is a dict, never a raise. The EC add takes NO category (it is an
    aMule category id and none is invented, S5); the legacy bridge forwards
    the caller's category (S3) and defaults to its own when absent — which is
    what keeps `POST /api/indexers/download` byte-identical.
    """
    if not _ec_direct():
        return await _download_bridge_legacy(link, category)
    try:
        await asyncio.to_thread(gateways.amule_add_ed2k, link)
    except Exception as exc:  # noqa: BLE001 — la negativa «no configurado» + errores EC tipados
        return {"ok": False, "detail": _redact(_skip_reason(exc), "")}
    return {"ok": True, "detail": _EC_ADDED}


async def _download_hash(file_hash: str) -> dict:
    """A 32-hex aMule hash-id (rows without a buildable link): the EC seam.

    Under the `AMULE_EC_DIRECT=0` rollback this is an HONEST refusal: the
    legacy bridge has no hash-id entry point at all, so there is nothing to
    fall back to and pretending otherwise would fail in silence later.
    """
    if not _ec_direct():
        return {"ok": False, "detail": _HASH_REFUSED_FLAG0}
    try:
        await asyncio.to_thread(gateways.amule_download_search_result, file_hash)
    except Exception as exc:  # noqa: BLE001 — la negativa «no configurado» + errores EC tipados
        return {"ok": False, "detail": _redact(_skip_reason(exc), "")}
    return {"ok": True, "detail": _EC_ADDED}


async def _download_bridge(link: str, category: str | None = None) -> dict:
    """magnet/http(s) → the NATIVE qBittorrent client (S4/S5): one
    `http_session()` per call, the client's dict mapped to `{ok, detail}`.

    PASSTHROUGH, no prefix (S5/S6): the native client's Spanish details
    already name the destination (S2 — «Descarga añadida en qBittorrent
    (URL), categoría flow» / «qBittorrent (URL) no aceptó la descarga: …»),
    so nothing is re-worded here. The caller's category (S3) is forwarded —
    the calendar grab chooses it by destination — and when it is absent the
    seam's own default (`flow`) applies, byte-identical to the endpoint's
    historical call. A raised transport error keeps `_skip_reason`'s short
    text. Either way the `apikey=` value a direct .torrent URL may carry is
    REDACTED first (risk 2): no secret ever reaches a response.
    """
    try:
        async with http_session() as session:
            if category is None:
                added = await gateways.qbit_add_download(session, link)
            else:
                added = await gateways.qbit_add_download(session, link, category)
        detail = _redact(str(added.get("detail", "")), "")
        return {"ok": bool(added.get("ok")), "detail": detail}
    except Exception as exc:  # noqa: BLE001 — la negativa del puente + errores de transporte
        return {"ok": False, "detail": _redact(_skip_reason(exc), "")}


async def _download_bridge_legacy(link: str, category: str | None = None) -> dict:
    """The aMuTorrent bridge — ONLY for the `AMULE_EC_DIRECT=0` rollback (S7).

    Byte-identical legacy shape: one `http_session()` per call, and a refusal
    keeps the «aMuTorrent no aceptó la descarga: …» prefix of always. Same
    category rule as `_download_bridge`: forwarded when the caller chose one
    (S3), the seam's own default otherwise.
    """
    try:
        async with http_session() as session:
            if category is None:
                added = await gateways.amutorrent_add_download(session, link)
            else:
                added = await gateways.amutorrent_add_download(session, link, category)
        detail = _redact(str(added.get("detail", "")), "")
        if not added.get("ok"):
            return {"ok": False, "detail": f"aMuTorrent no aceptó la descarga: {detail}"}
        return {"ok": True, "detail": detail}
    except Exception as exc:  # noqa: BLE001 — la negativa del puente + errores de transporte
        return {"ok": False, "detail": _redact(_skip_reason(exc), "")}


async def dispatch_direct(target: str, category: str | None = None) -> dict:
    """One target straight to a client, dispatched by SHAPE — `{ok, detail}`.

    Serves BOTH `POST /api/indexers/download` and the calendar grab flows
    (calendario-directo T2/S2): `ed2k://` → the direct EC seam (the legacy
    aMuTorrent bridge under the `AMULE_EC_DIRECT=0` rollback), a 32-hex aMule
    hash-id → `amule_download_search_result` (an honest refusal under the
    rollback), `magnet:`/`http(s)` → the NATIVE qBittorrent client, and
    anything else is the `_BAD_SCHEME` honest refusal. NO query, NO re-search:
    the caller already holds the link.

    `category` is the client category the caller chose (S3 — by destination).
    `None` means "the bridges' own default" and is exactly the historical
    `POST /api/indexers/download` call, byte for byte; the EC add takes no
    category at all.
    """
    if target.startswith("ed2k://"):
        return await _download_ed2k(target, category)
    if HASH32.fullmatch(target):
        return await _download_hash(target)
    if target.startswith("magnet:") or target.startswith(("http://", "https://")):
        return await _download_bridge(target, category)
    return {"ok": False, "detail": _BAD_SCHEME}


@router.post("/api/indexers/download")
async def download_indexer(body: dict, _key: str = Depends(verify_api_key)):
    """T5/S5 (enmienda L6) — one free-search row straight to a client.

    Body `{link?, guid?}` — at least one, dispatched by the target's shape
    through `dispatch_direct` (the SAME dispatch the calendar grab uses,
    calendario-directo T2/S2): `ed2k://` → the direct EC seam (the legacy
    aMuTorrent bridge under the `AMULE_EC_DIRECT=0` rollback), a 32-hex aMule
    hash → `amule_download_search_result` (an honest refusal under the
    rollback), `magnet:`/`http(s)` → the NATIVE qBittorrent client (S4/S5,
    destination named in the detail per S2). No persistence, no query, and
    200 `{ok, detail}` in BOTH directions — the only 400s are the body's own
    (no link AND no guid, or a non-string), all of them in Spanish.
    """
    target = _download_target(body)
    return await dispatch_direct(target)
