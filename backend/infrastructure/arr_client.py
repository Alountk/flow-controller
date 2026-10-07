import config
import asyncio
import json
import logging
import os
import posixpath
import re
import time
from urllib.parse import unquote, unquote_plus, urlsplit
from xml.etree import ElementTree

import aiohttp

from config import (
    AMUTORRENT_API_KEY,
    AMUTORRENT_PASSWORD,
    AMUTORRENT_URL,
    AMUTORRENT_USER,
    EXPECTED_CATEGORY,
    _AMU_WS_COMPLETE,
    QBIT_COMPLETED,
    QBIT_DOWNLOADING,
)
from domain.naming import MEDIA_EXTENSIONS

log = logging.getLogger("flow-controller")


def arr_headers(api_key: str) -> dict:
    headers = {"accept": "application/json"}
    if api_key:
        headers["X-Api-Key"] = api_key
    return headers


def qbit_headers(api_key: str) -> dict:
    headers = {"accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


#: Category for downloads this app adds DIRECTLY to the client, outside any
#: arr. The arr only polls the client for ITS own category, and it never gets
#: a queue item for a download it was never told about — so a torrent under
#: this name is invisible to Radarr/Sonarr: they cannot import it and cannot
#: replace what the library already holds. That invisibility is the entire
#: point of routing a release to a folder they manage.
DIRECT_DOWNLOAD_CATEGORY = "flow"


# A rejected credential is not a transient failure: retrying cannot fix it,
# and reporting it as "online" hides the most likely misconfiguration.
AUTH_STATUSES = (401, 403)


async def check_arr(session: aiohttp.ClientSession, service: dict) -> tuple[str, str, dict]:
    url = service["url"]
    headers = arr_headers(service["api_key"])
    endpoint = f"{url}/api/v3/system/status"
    last_error = "sin respuesta"
    for attempt in range(1, config.MAX_RETRIES + 1):
        try:
            timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT)
            async with session.get(endpoint, headers=headers, timeout=timeout) as resp:
                if resp.status in AUTH_STATUSES:
                    # Up but unusable. Calling this "online" sent the user to
                    # check whether the container was running, when the actual
                    # problem was the key.
                    return "misconfigured", f"API key rechazada (HTTP {resp.status})", {}
                if resp.status in (200, 301, 302):
                    return "online", f"Conexión exitosa (intento {attempt})", {}
                last_error = f"HTTP {resp.status}"
        except asyncio.TimeoutError:
            last_error = "Timeout"
        except aiohttp.ClientError as exc:
            last_error = type(exc).__name__
        if attempt < config.MAX_RETRIES:
            await asyncio.sleep(config.RETRY_DELAY)
    return "offline", f"Fallaron {config.MAX_RETRIES} intentos ({last_error})", {}


async def fetch_qbit_meta(session: aiohttp.ClientSession, service: dict) -> dict:
    headers = qbit_headers(service["api_key"])
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT)
    meta: dict = {}
    try:
        async with session.get(f"{service['url']}/api/v2/app/version", headers=headers, timeout=timeout) as resp:
            if resp.status == 200:
                meta["version"] = (await resp.text()).strip()
    except (asyncio.TimeoutError, aiohttp.ClientError):
        pass
    try:
        async with session.get(f"{service['url']}/api/v2/torrents/info", headers=headers, timeout=timeout) as resp:
            if resp.status == 200:
                torrents = await resp.json(content_type=None)
                downloading = sum(1 for t in torrents if t.get("state") in QBIT_DOWNLOADING)
                completed = sum(1 for t in torrents if t.get("state") in QBIT_COMPLETED)
                errored = sum(1 for t in torrents if t.get("state") == "error")
                meta["torrents"] = {
                    "total": len(torrents),
                    "downloading": downloading,
                    "completed": completed,
                    "errors": errored,
                }
    except (asyncio.TimeoutError, aiohttp.ClientError):
        pass
    return meta


async def check_qbit(session: aiohttp.ClientSession, service: dict) -> tuple[str, str, dict]:
    url = service["url"]
    headers = qbit_headers(service["api_key"])
    endpoint = f"{url}/api/v2/app/version"
    last_error = "sin respuesta"
    for attempt in range(1, config.MAX_RETRIES + 1):
        try:
            timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT)
            async with session.get(endpoint, headers=headers, timeout=timeout) as resp:
                if resp.status in AUTH_STATUSES:
                    return "misconfigured", f"API key rechazada (HTTP {resp.status})", {}
                if resp.status == 200:
                    meta = await fetch_qbit_meta(session, service)
                    return "online", f"Conexión exitosa (intento {attempt})", meta
                last_error = f"HTTP {resp.status}"
        except asyncio.TimeoutError:
            last_error = "Timeout"
        except aiohttp.ClientError as exc:
            last_error = type(exc).__name__
        if attempt < config.MAX_RETRIES:
            await asyncio.sleep(config.RETRY_DELAY)
    return "offline", f"Fallaron {config.MAX_RETRIES} intentos ({last_error})", {}


async def check_service(session: aiohttp.ClientSession, service: dict) -> tuple[str, str, dict]:
    if service["kind"] == "qbit":
        return await check_qbit(session, service)
    return await check_arr(session, service)


async def test_service_connection(session: aiohttp.ClientSession, service: dict) -> dict:
    """Probe one configured service and report what actually happened.

    Deliberately NOT the same as check_arr, which treats HTTP 401 as "online":
    a rejected API key is the most likely misconfiguration, and calling it a
    successful connection hides exactly the thing the user is testing.

    Always echoes the URL, because the same logical setting resolves to
    localhost or to a host IP depending on where the app runs.
    """
    service_key = service.get("key", "?")
    result = {
        "key": service_key,
        "kind": service.get("kind", "arr"),
        "url": service.get("url", ""),
    }

    if service["kind"] == "qbit":
        endpoint = f"{service['url']}/api/v2/app/version"
        headers = qbit_headers(service["api_key"])
    else:
        endpoint = f"{service['url']}/api/v3/system/status"
        headers = arr_headers(service["api_key"])

    try:
        async with session.get(
            endpoint, headers=headers, timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT)
        ) as resp:
            if resp.status != 200:
                return {**result, "ok": False, **_failure_detail(service, status=resp.status)}

            if service["kind"] == "qbit":
                version = (await resp.text()).strip()
            else:
                data = await resp.json(content_type=None)
                version = data.get("version", "")

            return {
                **result,
                "ok": True,
                "version": version,
                "detail": f"Conectado ({version})" if version else "Conectado",
            }
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {**result, "ok": False, **_failure_detail(service, exc=exc)}


def _failure_detail(service: dict, **kwargs) -> dict:
    """arr_failure under a name that matches this endpoint's response shape.

    The wanted endpoints expose `error`; this list exposes `detail`, which is
    what a status row shows. `error_kind` stays identical so the two share one
    classification.
    """
    failure = arr_failure(service, **kwargs)
    return {"error_kind": failure["error_kind"], "detail": failure["error"]}


async def arr_command(session: aiohttp.ClientSession, service: dict, body: dict) -> dict:
    headers = arr_headers(service["api_key"])
    headers["Content-Type"] = "application/json"
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2)
    try:
        async with session.post(
            f"{service['url']}/api/v3/command", headers=headers, json=body, timeout=timeout
        ) as resp:
            text = await resp.text()
            if resp.status in (200, 201):
                result: dict = {"ok": True, "detail": f"Comando '{body.get('name')}' encolado"}
                # Radarr answers the command's `id`: the ONLY handle to cancel
                # it afterwards (DELETE /api/v3/command/{id}). Dropping it is
                # what made a fired mass search unstoppable (C-09).
                try:
                    payload = json.loads(text)
                except ValueError:
                    payload = None
                if isinstance(payload, dict) and payload.get("id") is not None:
                    result["command_id"] = payload["id"]
                return result
            return {"ok": False, "detail": f"HTTP {resp.status}: {text[:200]}"}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


async def arr_cancel_command(session: aiohttp.ClientSession, service: dict, command_id: int) -> dict:
    """Cancela un comando en curso en el arr: ``DELETE /api/v3/command/{id}``.

    El id es el que devolvió la propia ejecución de ``arr_command``. Un 404 no
    es un error nuestro: el comando ya terminó (o el id nunca existió) y decir
    "cancelado" ahí sería mentir.
    """
    headers = arr_headers(service["api_key"])
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT)
    try:
        async with session.delete(
            f"{service['url']}/api/v3/command/{int(command_id)}",
            headers=headers,
            timeout=timeout,
        ) as resp:
            if resp.status in (200, 201, 202, 204):
                return {"ok": True, "detail": f"Comando {command_id} cancelado"}
            text = await resp.text()
            if resp.status == 404:
                return {
                    "ok": False,
                    "detail": f"Comando {command_id} no encontrado: ya finalizado o id desconocido",
                }
            return {"ok": False, "detail": f"HTTP {resp.status}: {text[:200]}"}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


async def amu_ws_login(session: aiohttp.ClientSession) -> tuple[bool, str]:
    if not AMUTORRENT_PASSWORD:
        return False, "faltan credenciales (AMUTORRENT_PASSWORD)"
    try:
        async with session.post(
            f"{AMUTORRENT_URL}/api/auth/login",
            json={
                "username": AMUTORRENT_USER,
                "password": AMUTORRENT_PASSWORD,
                "rememberMe": True,
            },
            headers={"Referer": AMUTORRENT_URL},
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2),
        ) as resp:
            data = await resp.json(content_type=None)
            if data.get("success"):
                return True, "sesión iniciada"
            return False, data.get("message") or f"HTTP {resp.status}"
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return False, f"{type(exc).__name__}: {exc}"


def amu_ws_url() -> str:
    base = AMUTORRENT_URL.rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base[len("https://"):] + "/ws"
    if base.startswith("http://"):
        return "ws://" + base[len("http://"):] + "/ws"
    return base + "/ws"


async def amu_ws(action: str, payload: dict, *, timeout: float = 15.0) -> dict:
    expect = _AMU_WS_COMPLETE.get(action)
    if expect is None:
        return {"ok": False, "detail": f"acción WS desconocida: {action}"}
    jar = aiohttp.CookieJar(unsafe=True)
    async with aiohttp.ClientSession(cookie_jar=jar) as session:
        ok, detail = await amu_ws_login(session)
        if not ok:
            return {"ok": False, "detail": f"login aMuTorrent: {detail}"}
        try:
            async with session.ws_connect(
                amu_ws_url(),
                headers={"Referer": AMUTORRENT_URL},
                timeout=aiohttp.ClientTimeout(total=timeout),
                heartbeat=None,
            ) as ws:
                await ws.send_json({"action": action, **payload})
                deadline = time.monotonic() + timeout
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return {"ok": False, "detail": "sin confirmación (timeout)"}
                    msg = await ws.receive(timeout=remaining)
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        try:
                            event = json.loads(msg.data)
                        except ValueError:
                            continue
                        etype = event.get("type")
                        if etype == "error":
                            return {
                                "ok": False,
                                "detail": event.get("message") or "error de aMuTorrent",
                            }
                        if etype == expect:
                            results = event.get("results")
                            if isinstance(results, list) and results:
                                failed = [r for r in results if not r.get("success")]
                                if failed:
                                    why = failed[0].get("error") or "rechazado"
                                    return {
                                        "ok": False,
                                        "detail": f"{len(failed)}/{len(results)} fallaron: {why}",
                                    }
                            return {"ok": True, "detail": "aplicado vía WebSocket"}
                    elif msg.type in (
                        aiohttp.WSMsgType.CLOSED,
                        aiohttp.WSMsgType.CLOSE,
                        aiohttp.WSMsgType.ERROR,
                    ):
                        return {"ok": False, "detail": f"WebSocket cerrado ({msg.data})"}
        except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
            return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


async def amu_ws_find_instance(
    matched_hash: str, *, timeout: float = 10.0,
) -> tuple[str, str]:
    jar = aiohttp.CookieJar(unsafe=True)
    async with aiohttp.ClientSession(cookie_jar=jar) as session:
        ok, _ = await amu_ws_login(session)
        if not ok:
            return "", ""
        try:
            async with session.ws_connect(
                amu_ws_url(),
                headers={"Referer": AMUTORRENT_URL},
                timeout=aiohttp.ClientTimeout(total=timeout),
            ) as ws:
                await asyncio.wait_for(ws.receive(), timeout=5)
                await ws.send_json({"action": "subscribe", "channel": "items"})
                deadline = time.monotonic() + timeout
                h_lower = matched_hash.lower()
                h_prefix = h_lower[:32]
                while time.monotonic() < deadline:
                    msg = await ws.receive(timeout=min(5, deadline - time.monotonic()))
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    try:
                        ev = json.loads(msg.data)
                    except ValueError:
                        continue
                    if ev.get("type") != "batch-update":
                        continue
                    items = ev.get("data", {}).get("items", [])
                    for item in items:
                        ih = item.get("hash", "").lower()
                        if ih == h_lower or ih == h_prefix:
                            client = item.get("client", "amule")
                            inst = item.get("instanceId", "")
                            return client, inst
                return "", ""
        except Exception:
            return "", ""


def amu_ws_items(matched_hash: str, *, client: str = "amule", instance_id: str | None = None, name: str | None = None) -> list[dict]:
    h = matched_hash.lower()
    if len(h) == 40 and h.endswith("00000000"):
        h = h[:32]
    item: dict = {"fileHash": h, "clientType": client}
    if instance_id:
        item["instanceId"] = instance_id
    if name:
        item["fileName"] = name
    return [item]


async def arr_delete_queue(
    session: aiohttp.ClientSession,
    service: dict,
    queue_id: int,
    blocklist: bool,
    *,
    remove_from_client: bool = True,
) -> dict:
    """Remove one item from the arr's queue.

    ``remove_from_client`` defaults to ``True`` (the historical behaviour: the
    arr also deletes the download from the client). A foreign destination must
    pass ``False``: the arr stops tracking the item but the client keeps the
    files, so the user keeps seeding.

    A 404 is reported as ``not_found`` in ADDITION to the usual keys: it means
    the arr was not tracking the item, which is not a failure for a caller that
    only wanted it gone.
    """
    headers = arr_headers(service["api_key"])
    url = (
        f"{service['url']}/api/v3/queue/{queue_id}"
        f"?removeFromClient={'true' if remove_from_client else 'false'}"
        f"&blocklist={'true' if blocklist else 'false'}"
    )
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2)
    try:
        async with session.delete(url, headers=headers, timeout=timeout) as resp:
            if resp.status in (200, 204):
                return {"ok": True, "detail": "Item eliminado de la cola"}
            if resp.status == 404:
                return {"ok": False, "not_found": True, "detail": "HTTP 404"}
            return {"ok": False, "detail": f"HTTP {resp.status}"}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


async def arr_remote_paths(session: aiohttp.ClientSession, service: dict) -> list[dict]:
    headers = arr_headers(service["api_key"])
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2)
    try:
        async with session.get(
            f"{service['url']}/api/v3/remotepathmapping",
            headers=headers,
            timeout=timeout,
        ) as resp:
            if resp.status != 200:
                return []
            return await resp.json(content_type=None) or []
    except (asyncio.TimeoutError, aiohttp.ClientError, ValueError):
        return []


async def arr_add_remote_path(
    session: aiohttp.ClientSession,
    service: dict,
    host: str,
    remote_path: str,
    local_path: str,
) -> dict:
    headers = arr_headers(service["api_key"])
    headers["Content-Type"] = "application/json"
    body = {"host": host, "remotePath": remote_path, "localPath": local_path}
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2)
    try:
        async with session.post(
            f"{service['url']}/api/v3/remotepathmapping",
            headers=headers,
            json=body,
            timeout=timeout,
        ) as resp:
            text = await resp.text()
            if resp.status in (200, 201):
                return {"ok": True, "detail": f"mapeo creado: {remote_path} → {local_path}"}
            return {"ok": False, "detail": f"HTTP {resp.status}: {text[:200]}"}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


async def arr_series_root_folder(session: aiohttp.ClientSession, service: dict, series_id: int) -> str:
    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/series/{series_id}",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT),
        ) as resp:
            if resp.status != 200:
                return ""
            data = await resp.json(content_type=None)
            return data.get("path", "")
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return ""


async def arr_episode_season(session: aiohttp.ClientSession, service: dict, episode_id: int) -> int | None:
    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/episode/{episode_id}",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT),
        ) as resp:
            if resp.status != 200:
                return None
            data = await resp.json(content_type=None)
            return data.get("seasonNumber")
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return None


async def arr_movie_root_folder(session: aiohttp.ClientSession, service: dict, movie_id: int) -> str:
    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/movie/{movie_id}",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT),
        ) as resp:
            if resp.status != 200:
                return ""
            data = await resp.json(content_type=None)
            return data.get("path", "")
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return ""


async def arr_episode_metadata(
    session: aiohttp.ClientSession, service: dict, episode_id: int
) -> dict:
    """Full metadata for one episode: season, episode, title and series id.

    `copy_engine` reads season_number/episode_number/title for its smart rename
    and ignores the extra key; the calendar grab route reads `series_id` to
    record which series a grabbed episode belongs to.
    """
    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/episode/{episode_id}",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT),
        ) as resp:
            if resp.status != 200:
                return {}
            data = await resp.json(content_type=None)
            return {
                "season_number": data.get("seasonNumber"),
                "episode_number": data.get("episodeNumber"),
                "title": data.get("title", ""),
                "series_id": data.get("seriesId"),
            }
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return {}


async def arr_series_metadata(
    session: aiohttp.ClientSession, service: dict, series_id: int
) -> dict:
    """Devuelve título, path y títulos alternativos de una serie."""
    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/series/{series_id}",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT),
        ) as resp:
            if resp.status != 200:
                return {}
            data = await resp.json(content_type=None)
            return {
                "title": data.get("title", ""),
                "path": data.get("path", ""),
                "alternateTitles": data.get("alternateTitles", []),
            }
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return {}


async def arr_movie_metadata(
    session: aiohttp.ClientSession, service: dict, movie_id: int
) -> dict:
    """Devuelve título, año, calidad y títulos alternativos de una película."""
    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/movie/{movie_id}",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT),
        ) as resp:
            if resp.status != 200:
                return {}
            data = await resp.json(content_type=None)
            quality = ""
            mf = data.get("movieFile") or {}
            q = (mf.get("quality") or {}).get("quality") or {}
            quality = q.get("name", "")
            # Radarr exposes alternate titles as `alternateTitles`; `altTitles`
            # does not exist there and always came back empty. The output key
            # stays `altTitles` because that is our own normalized contract.
            alt_titles = [
                alt.get("title", "") if isinstance(alt, dict) else str(alt)
                for alt in (data.get("alternateTitles") or [])
            ]
            path = data.get("path", "")
            return {
                "title": data.get("title", ""),
                "year": data.get("year"),
                "quality": quality,
                "path": path,
                "altTitles": alt_titles,
                # Radarr's OWN answer to "where does this movie live" — no
                # evaluation needed, which is why it beats deriving the folder
                # from `movieFolderFormat`.
                "folder": os.path.basename(path) if path else "",
                # The name Radarr chose for the file it already owns. This is
                # the reference the naming self-check compares against; empty
                # means "no reference", never "no file".
                "file_name": (mf.get("relativePath") or ""),
            }
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return {}


async def arr_import_status(
    session: aiohttp.ClientSession, service: dict, *, series_id: int | None = None, movie_id: int | None = None, season_number: int | None = None
) -> dict:
    result = {"has_file": False, "needs_rename": None, "file_path": "", "detail": ""}
    headers = arr_headers(service["api_key"])

    if movie_id:
        try:
            async with session.get(
                f"{service['url']}/api/v3/movie/{movie_id}",
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json(content_type=None)
                    result["has_file"] = data.get("hasFile", False)
        except (asyncio.TimeoutError, aiohttp.ClientError):
            result["detail"] = "error consultando movie"

        if result["has_file"]:
            try:
                async with session.get(
                    f"{service['url']}/api/v3/rename",
                    params={"movieId": movie_id},
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT),
                ) as resp:
                    if resp.status == 200:
                        renames = await resp.json(content_type=None)
                        result["needs_rename"] = len(renames) > 0
                        if renames:
                            result["file_path"] = renames[0].get("existingPath", "")
                            result["detail"] = f"renombrado pendiente: {renames[0].get('existingPath', '')} → {renames[0].get('newPath', '')}"
                        else:
                            result["detail"] = "importado y renombrado correctamente"
            except (asyncio.TimeoutError, aiohttp.ClientError):
                result["detail"] = "error consultando rename"

    elif series_id:
        if season_number is not None:
            try:
                async with session.get(
                    f"{service['url']}/api/v3/episode",
                    params={"seriesId": series_id, "seasonNumber": season_number},
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT),
                ) as resp:
                    if resp.status == 200:
                        episodes = await resp.json(content_type=None)
                        if episodes:
                            result["has_file"] = episodes[0].get("hasFile", False)
            except (asyncio.TimeoutError, aiohttp.ClientError):
                result["detail"] = "error consultando episodes"

        if result["has_file"] and season_number is not None:
            try:
                async with session.get(
                    f"{service['url']}/api/v3/rename",
                    params={"seriesId": series_id, "seasonNumber": season_number},
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT),
                ) as resp:
                    if resp.status == 200:
                        renames = await resp.json(content_type=None)
                        result["needs_rename"] = len(renames) > 0
                        if renames:
                            result["file_path"] = renames[0].get("existingPath", "")
                            result["detail"] = f"renombrado pendiente: {renames[0].get('existingPath', '')} → {renames[0].get('newPath', '')}"
                        else:
                            result["detail"] = "importado y renombrado correctamente"
            except (asyncio.TimeoutError, aiohttp.ClientError):
                result["detail"] = "error consultando rename"

    return result


async def arr_has_file(
    session: aiohttp.ClientSession,
    service: dict,
    *,
    movie_id: int | None = None,
    episode_id: int | None = None,
) -> bool | None:
    """Ask the arr whether it already holds this specific item.

    Three-valued on purpose: `True` when the arr says it has the file, `False`
    only when it explicitly says it does not, and `None` when the answer is
    unknown (no id, a non-200, a missing field, a timeout or any client error).
    The policy skips on `True` only, so collapsing `None` into `False` would
    turn a transient failure into "not imported yet" and invite a duplicate
    copy — the exact race this guard exists to prevent.

    An episode asks `/api/v3/episode/{id}` rather than `arr_import_status`, which
    checks a Sonarr series a season at a time and reads the first episode's
    flag: too coarse to answer whether *this* episode is imported.
    """
    if movie_id is not None:
        endpoint = f"{service['url']}/api/v3/movie/{movie_id}"
    elif episode_id is not None:
        endpoint = f"{service['url']}/api/v3/episode/{episode_id}"
    else:
        return None

    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            endpoint,
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT),
        ) as resp:
            if resp.status != 200:
                return None
            data = await resp.json(content_type=None)
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return None

    if not isinstance(data, dict):
        return None
    value = data.get("hasFile")
    if value is None:
        # Field absent or explicitly null: unknown, not "no file".
        return None
    return bool(value)


async def fetch_arr_all_series(session: aiohttp.ClientSession, service: dict) -> dict[int, str]:
    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/series",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2),
        ) as resp:
            if resp.status != 200:
                return {}
            data = await resp.json(content_type=None)
            return {s["id"]: s.get("path", "") for s in data if "id" in s}
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return {}


async def fetch_arr_all_movies(session: aiohttp.ClientSession, service: dict) -> dict[int, str]:
    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/movie",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2),
        ) as resp:
            if resp.status != 200:
                return {}
            data = await resp.json(content_type=None)
            return {m["id"]: m.get("path", "") for m in data if "id" in m}
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return {}


async def fetch_arr_grabbed(session: aiohttp.ClientSession, service: dict, limit: int) -> list[dict]:
    headers = arr_headers(service["api_key"])
    url = (
        f"{service['url']}/api/v3/history"
        f"?pageSize={limit}&sortKey=date&sortDirection=descending&eventType=1"
    )
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2)
    try:
        async with session.get(url, headers=headers, timeout=timeout) as resp:
            if resp.status != 200:
                return []
            data = await resp.json(content_type=None)
            return data.get("records", [])
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return []


async def fetch_arr_queue(session: aiohttp.ClientSession, service: dict) -> list[dict]:
    headers = arr_headers(service["api_key"])
    url = f"{service['url']}/api/v3/queue?pageSize=200&includeUnknownSeriesItems=true&includeUnknownMovieItems=true"
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2)
    try:
        async with session.get(url, headers=headers, timeout=timeout) as resp:
            if resp.status != 200:
                return []
            data = await resp.json(content_type=None)
            return data.get("records", [])
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return []


async def arr_download_clients(session: aiohttp.ClientSession, service: dict) -> list[dict]:
    headers = arr_headers(service["api_key"])
    url = f"{service['url']}/api/v3/downloadclient"
    try:
        async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT)) as resp:
            if resp.status != 200:
                return []
            return await resp.json(content_type=None)
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return []


async def arr_indexers(session: aiohttp.ClientSession, service: dict) -> dict:
    """Indexadores configurados en Radarr/Sonarr, o el motivo de no haberlos podido preguntar.

    Devuelve dict y no lista: `[]` sobre un timeout sería indistinguible de "no
    hay ninguno configurado", y la pantalla afirmaría lo segundo con confianza.
    Es el mismo trato que ya da `fetch_wanted_movies` vía `arr_failure`.
    """
    headers = arr_headers(service["api_key"])
    url = f"{service['url']}/api/v3/indexer"
    try:
        async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT)) as resp:
            if resp.status != 200:
                log.warning("arr_indexers %s status=%d", service["key"], resp.status)
                return {"indexers": [], **arr_failure(service, status=resp.status)}
            data = await resp.json(content_type=None)
            # ALL indexers — the frontend shows them and lets the user pick one.
            result = [
                {
                    "id": idx.get("id"),
                    "name": idx.get("name", ""),
                    "implementation": idx.get("implementation", ""),
                    "enableRss": idx.get("enableRss", False),
                    "enableSearch": idx.get("enableSearch", False),
                }
                for idx in data
            ]
            log.info("arr_indexers %s returning=%d", service["key"], len(result))
            return {"indexers": result}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        log.warning("arr_indexers %s error: %s", service["key"], exc)
        return {"indexers": [], **arr_failure(service, exc=exc)}


async def arr_naming_config(session: aiohttp.ClientSession, service: dict) -> dict:
    """Radarr's naming pattern — the only thing it offers for a file it will
    never see.

    Radarr renames what it owns (`GET /api/v3/rename`, `RenameMovie`,
    `RenameFiles`) and exposes no "what would this be called" endpoint for one
    outside its roots. The pattern is what we have, so the caller must evaluate
    it AND check the result against `movieFile.relativePath` before trusting it.

    Degrades to `{}` on any doubt: an empty pattern means "rename nothing",
    which is the safe reading of a config we could not read.
    """
    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/config/naming",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT),
        ) as resp:
            if resp.status != 200:
                log.warning("arr_naming_config %s status=%d", service["key"], resp.status)
                return {}
            data = await resp.json(content_type=None)
    except (asyncio.TimeoutError, aiohttp.ClientError, ValueError) as exc:
        log.warning("arr_naming_config %s error: %s", service["key"], exc)
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        "standard_movie_format": str(data.get("standardMovieFormat") or ""),
        "movie_folder_format": str(data.get("movieFolderFormat") or ""),
    }


async def arr_root_folders(session: aiohttp.ClientSession, service: dict) -> list[str]:
    """Obtiene las carpetas raíz configuradas en Radarr/Sonarr."""
    headers = arr_headers(service["api_key"])
    url = f"{service['url']}/api/v3/rootfolder"
    try:
        async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT)) as resp:
            text = await resp.text()
            if resp.status != 200:
                log.warning("arr_root_folders %s status=%d body=%s", service["key"], resp.status, text[:200])
                return []
            data = await resp.json(content_type=None)
            paths = [f.get("path", "") for f in data if f.get("path")]
            log.info("arr_root_folders %s found: %s", service["key"], paths)
            return paths
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        log.warning("arr_root_folders %s error: %s", service["key"], exc)
        return []


async def fetch_qbit_torrents(session: aiohttp.ClientSession) -> list[dict]:
    headers = qbit_headers(AMUTORRENT_API_KEY)
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 3)
    try:
        async with session.get(
            f"{AMUTORRENT_URL}/api/v2/torrents/info", headers=headers, timeout=timeout
        ) as resp:
            if resp.status != 200:
                return []
            return await resp.json(content_type=None)
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return []


async def amu_torrent_categories(session: aiohttp.ClientSession) -> list[str]:
    """Category names configured in aMuTorrent, or [] if it cannot be reached."""
    try:
        async with session.get(
            f"{AMUTORRENT_URL}/api/v2/torrents/categories",
            headers=qbit_headers(AMUTORRENT_API_KEY),
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT),
        ) as resp:
            if resp.status != 200:
                return []
            data = await resp.json(content_type=None)
            return list(data.keys()) if isinstance(data, dict) else []
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return []


def direct_link_identity(link: str, fallback_title: str) -> tuple[str, str | None]:
    """What the client will call the download, and its hash when knowable.

    Pure, because the identity rules deserve tests without a client. The
    `ed2k://|file <name>|<size>|<hash>|/` name IS what the client names the
    download — but the link's hash is deliberately NOT returned: aMuTorrent
    translates the ED2K hash into its own infohash, and guessing that mapping
    would join the wrong torrent. A magnet carries its identity in `dn` and a
    hex `btih`, both literal.
    """
    if link.startswith("ed2k://"):
        parts = link.split("|")
        name = parts[1][5:].strip() if len(parts) > 1 and parts[1].startswith("file ") else ""
        return (name or fallback_title, None)
    if link.startswith("magnet:"):
        dn = re.search(r"[?&]dn=([^&]+)", link)
        btih = re.search(r"xt=urn:btih:([0-9a-fA-F]{40})", link)
        name = unquote_plus(dn.group(1)) if dn and dn.group(1) else fallback_title
        return (name, btih.group(1).lower() if btih else None)
    return (fallback_title, None)


async def amutorrent_ensure_category(session: aiohttp.ClientSession, category: str) -> bool:
    """The category exists in the client, creating it if missing.

    Best effort on purpose: a torrent with NO category is still invisible to
    the arr (it only polls its own), so a failed create must never block the
    add — it only loses the bookkeeping label.
    """
    try:
        if category in await amu_torrent_categories(session):
            return True
        async with session.post(
            f"{AMUTORRENT_URL}/api/v2/torrents/createCategories",
            headers=qbit_headers(AMUTORRENT_API_KEY),
            data={"name": category},
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT),
        ) as resp:
            return resp.status in (200, 409)
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return False


async def amutorrent_add_download(
    session: aiohttp.ClientSession, url: str, category: str = DIRECT_DOWNLOAD_CATEGORY
) -> dict:
    """``POST /api/v2/torrents/add`` — the same call the arr itself makes.

    This is the whole of option B: the link goes straight to the client under
    OUR category, and the arr never learns the download exists.
    """
    await amutorrent_ensure_category(session, category)
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2)
    try:
        async with session.post(
            f"{AMUTORRENT_URL}/api/v2/torrents/add",
            headers=qbit_headers(AMUTORRENT_API_KEY),
            data={"urls": url, "category": category},
            timeout=timeout,
        ) as resp:
            if resp.status == 200:
                return {"ok": True, "detail": f"Descarga añadida (categoría {category})", "category": category}
            text = await resp.text()
            return {"ok": False, "detail": f"HTTP {resp.status}: {text[:200]}"}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


async def amutorrent_search_link(session: aiohttp.ClientSession, title: str) -> str | None:
    """The ED2K/magnet link behind `title`, from aMuTorrent's own Torznab.

    The arr's release payload carries only its guid — the link lives in the
    indexer that produced the release, so we ask the same Torznab the arr
    asked, and match the item on guid first (it IS the indexer's id) then on
    the exact title, case-insensitively. No fuzzy match: a wrong link is a
    wrong download, and "not found" is an honest answer the caller shows.

    ED2K searches are throttled server-side (~5 s), hence the ×4 timeout; a
    repeat query is normally served from the client's cache.
    """
    if not AMUTORRENT_URL or not title:
        return None
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 4)
    try:
        async with session.get(
            f"{AMUTORRENT_URL}/indexer/amule/api",
            params={"t": "search", "q": title, "apikey": AMUTORRENT_API_KEY},
            timeout=timeout,
        ) as resp:
            if resp.status != 200:
                log.warning("amutorrent_search_link status=%s", resp.status)
                return None
            text = await resp.text()
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        log.warning("amutorrent_search_link: %s", exc)
        return None
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError:
        log.warning("amutorrent_search_link: respuesta no es XML")
        return None
    want = title.strip().casefold()
    for item in root.iter("item"):
        item_title = (item.findtext("title") or "").strip().casefold()
        item_guid = (item.findtext("guid") or "").strip()
        enclosure = item.find("enclosure")
        link = enclosure.get("url") if enclosure is not None else None
        if not link and item_guid.casefold().startswith(("ed2k://", "magnet:")):
            link = item_guid
        if link and (item_guid.casefold() == want or item_title == want):
            return link
    return None


async def amutorrent_reload_shared_dirs(session: aiohttp.ClientSession) -> dict:
    """Ask aMuTorrent to tell aMule to re-read its shared-folder files.

    aMuTorrent already holds the External Connections session with aMule, so
    this is one HTTP call instead of implementing EC here — which matters,
    because aMule does not advertise `EC_TAG_CAN_SHAREDDIRS_CONFIG` and the
    file-plus-reload path is the one that actually works.

    The instance id comes from aMuTorrent's own config, an endpoint that also
    carries every password it holds. Only `id` of the client whose `type` is
    `amule` is read out; nothing else from that response leaves this function
    and nothing from it is logged.
    """
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 3)
    try:
        async with session.get(
            f"{AMUTORRENT_URL}/api/config/current",
            headers=qbit_headers(AMUTORRENT_API_KEY),
            timeout=timeout,
        ) as resp:
            if resp.status != 200:
                return {"ok": False, "detail": f"config de aMuTorrent: HTTP {resp.status}"}
            data = await resp.json(content_type=None)
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {"ok": False, "detail": f"config de aMuTorrent: {type(exc).__name__}"}

    instance_id = next(
        (
            str(client.get("id") or "")
            for client in (data.get("clients") or [])
            if isinstance(client, dict) and client.get("type") == "amule"
        ),
        "",
    )
    if not instance_id:
        return {"ok": False, "detail": "aMuTorrent no tiene ningún cliente de tipo aMule"}

    try:
        async with session.post(
            f"{AMUTORRENT_URL}/api/amule/shared-dirs/reload",
            json={"instanceId": instance_id},
            headers=qbit_headers(AMUTORRENT_API_KEY),
            timeout=timeout,
        ) as resp:
            if resp.status == 200:
                return {"ok": True, "detail": "recarga pedida a aMule"}
            text = await resp.text()
            return {"ok": False, "detail": f"HTTP {resp.status}: {text[:200]}"}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {"ok": False, "detail": f"recarga: {type(exc).__name__}"}


def arr_categories_for(service_key: str, available: list[str]) -> list[str]:
    """aMuTorrent categories that belong to an arr service.

    Includes localized variants: the server has `radarr` AND `radarr-ru`, so
    matching only the configured base name would silently miss downloads.
    """
    bases = {service_key, EXPECTED_CATEGORY.get(service_key, service_key)}
    bases.discard("")

    matches = []
    for candidate in available:
        for base in bases:
            if candidate == base or candidate.startswith(f"{base}-"):
                matches.append(candidate)
                break
    return sorted(set(matches))


async def fetch_amu_torrents_by_category(
    session: aiohttp.ClientSession, categories: list[str]
) -> tuple[list[dict], dict | None]:
    """Torrents for the given categories, plus a failure description.

    `torrents/info` unfiltered returns ~1097 KB for 813 torrents, and its
    `hashes=`/`filter=` parameters are ignored — only `category=` works. A
    failure is returned rather than swallowed so the caller can tell "no
    downloads" apart from "could not ask".
    """
    if not categories:
        return [], None

    collected: list[dict] = []
    failures: list[str] = []

    for category in categories:
        try:
            async with session.get(
                f"{AMUTORRENT_URL}/api/v2/torrents/info",
                params={"category": category},
                headers=qbit_headers(AMUTORRENT_API_KEY),
                timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 3),
            ) as resp:
                if resp.status != 200:
                    failures.append(f"{category}: HTTP {resp.status}")
                    continue
                data = await resp.json(content_type=None)
                if isinstance(data, list):
                    collected.extend(data)
        except asyncio.TimeoutError:
            failures.append(f"{category}: no respondió a tiempo")
        except aiohttp.ClientError as exc:
            failures.append(f"{category}: {type(exc).__name__}")

    if failures and not collected:
        return [], {"error_kind": "unreachable", "error": "aMuTorrent: " + "; ".join(failures)}
    return collected, None


def arr_failure(service: dict, *, status: int | None = None, exc: BaseException | None = None) -> dict:
    """Explain why an arr call produced nothing.

    Returning an empty list on a timeout or a rejected API key makes "Radarr
    says there is nothing missing" indistinguishable from "we could not ask
    Radarr", and the UI then states the former with confidence. Callers merge
    this into their empty result so the failure survives to the screen.
    """
    name = service.get("key", "arr")

    if status is not None:
        if status in (401, 403):
            return {
                "error_kind": "auth",
                "error": f"{name}: API key rechazada (HTTP {status})",
            }
        return {"error_kind": "http", "error": f"{name}: respuesta HTTP {status}"}

    if isinstance(exc, asyncio.TimeoutError):
        return {"error_kind": "timeout", "error": f"{name}: no respondió a tiempo"}

    return {
        "error_kind": "unreachable",
        "error": f"{name}: no se pudo conectar ({type(exc).__name__ if exc else 'desconocido'})",
    }


def _empty_page(page: int, page_size: int) -> dict:
    return {"items": [], "total": 0, "page": page, "page_size": page_size}


def _proxied_poster(url: str, source: str) -> str:
    """``url`` rewritten to ``/api/mediacover/<source>/…`` — or left untouched.

    The arrs word the poster in two shapes: a relative ``/MediaCover/…``
    (their ``urlBase`` is ``/``) and an absolute
    ``http://arr:7878/MediaCover/…``. The browser resolves the first against
    THIS app's origin, where nothing serves ``/MediaCover`` → 404 → initials;
    the second points at a host it may never reach. Both lose their origin
    and become the proxy path, so the app is the only thing that ever has to
    reach the arr — one rule for either shape.

    Anything that is not a MediaCover path (another CDN, another service) is
    returned exactly as it came: what we do not recognise, we do not mangle.
    And no rewrite may ever emit ``/api/mediacover/…/../..`` — the path is
    decoded and normalised FIRST and only then checked against the
    ``/MediaCover/`` prefix, the same order the proxy route enforces.
    """
    parts = urlsplit(url)
    path = posixpath.normpath(unquote(parts.path))
    if not path.startswith("/MediaCover/"):
        return url
    proxied = f"/api/mediacover/{source}{path}"
    if parts.query:
        proxied = f"{proxied}?{parts.query}"
    return proxied


def _poster_url(item: dict, source: str) -> str:
    """The poster of an arr payload's first ``images`` entry — two-step chain.

    Radarr and Sonarr send ``images: [{"url": ..., "remoteUrl": ...,
    "coverType": "poster"}]`` on movies, series and calendar entries — never
    a ``remotePoster`` key, so reading that one always yielded ``""`` and
    every section row (and the detail panel fed from it) rendered without
    its poster.

    1. ``images[0].remoteUrl`` — a non-empty string — is returned untouched.
       The arrs word it as an absolute external URL (the real, working
       image: the local copy behind ``url`` is frequently never
       downloaded), the frontend renders it as ``<img src>``, and an
       ``https`` image on an ``http`` app is a plain upgrade, not mixed
       content. It is never rewritten, stripped, resized or proxied — in
       particular it must never become ``/api/mediacover/…``.
    2. Otherwise the local ``images[0].url``, rewritten to this app's own
       poster proxy — see ``_proxied_poster`` — because the arrs report
       that copy as a ``/MediaCover/…`` path the browser would resolve
       against OUR origin. ``source`` is the service key
       (``radarr``/``sonarr``) the fetcher already holds, and it becomes
       the proxy's ``{source}`` segment. This is the path taken when the
       payload carries no ``remoteUrl`` (or an empty one).

    The first entry is the poster the arrs report for the item. Anything
    missing or malformed — no ``images`` key, ``[]``, a non-list container, a
    non-dict entry, a dict without ``url`` — reads as ``""``: the frontend
    falls back to initials and must never render ``<img src="">``, and no
    payload shape may raise (the expression this replaced died on a string
    entry with ``AttributeError``). An empty ``remoteUrl`` falls through to
    step 2 rather than rendering an empty ``<img>``.
    """
    images = item.get("images")
    if not isinstance(images, list) or not images:
        return ""
    first = images[0]
    if not isinstance(first, dict):
        return ""
    remote = first.get("remoteUrl")
    if isinstance(remote, str) and remote:
        return remote
    url = first.get("url")
    if not isinstance(url, str) or not url:
        return ""
    return _proxied_poster(url, source)


async def fetch_wanted_movies(session: aiohttp.ClientSession, service: dict, page: int = 1, page_size: int = 50) -> dict:
    """Devuelve películas monitorizadas sin archivo (wanted/missing)."""
    headers = arr_headers(service["api_key"])
    params = {
        "sortKey": "releaseDate",
        "sortDirection": "descending",
        "monitored": "true",
        "page": str(page),
        "pageSize": str(page_size),
    }
    try:
        async with session.get(
            f"{service['url']}/api/v3/wanted/missing",
            headers=headers,
            params=params,
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2),
        ) as resp:
            if resp.status != 200:
                return {**_empty_page(page, page_size), **arr_failure(service, status=resp.status)}
            data = await resp.json(content_type=None)
            items = [
                {
                    "id": m.get("id"),
                    "title": m.get("title", ""),
                    "year": m.get("year"),
                    "overview": m.get("overview", ""),
                    "remotePoster": _poster_url(m, service["key"]),
                    "has_file": m.get("hasFile", False),
                    # Radarr sends `alternateTitles`; kept as our own `altTitles` key.
                    "altTitles": [
                        alt.get("title", "") if isinstance(alt, dict) else str(alt)
                        for alt in (m.get("alternateTitles") or [])
                    ],
                }
                for m in data.get("records", [])
            ]
            total = data.get("totalRecords") or data.get("total", len(items))
            return {"items": items, "total": total, "page": page, "page_size": page_size}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {**_empty_page(page, page_size), **arr_failure(service, exc=exc)}


def _movie_quality(movie: dict) -> str:
    """The quality name of the file Radarr owns, or ``""`` when unknown.

    Same reading as ``arr_movie_metadata``: ``movieFile.quality.quality.name``
    (e.g. ``Bluray-2160p``). Every step is guarded — ``movieFile`` is absent
    until the movie has a file, and an odd payload can put a plain string where
    the shape says a dict — so anything unexpected reads as unknown, never as a
    guessed quality: the Calidad view turns ``""`` into "desconocida".
    """
    movie_file = movie.get("movieFile")
    if not isinstance(movie_file, dict):
        return ""
    quality = movie_file.get("quality")
    if not isinstance(quality, dict):
        return ""
    inner = quality.get("quality")
    if not isinstance(inner, dict):
        return ""
    name = inner.get("name")
    return name if isinstance(name, str) else ""


def _movie_file_name(movie: dict) -> str:
    """``movieFile.relativePath`` — the file Radarr owns, or ``""`` when absent.

    The same guarded read as ``_movie_quality``: ``movieFile`` only exists once
    the movie has a file, and an odd payload can put anything where the shape
    says a string. Empty means "no name to show" and is NEVER filled in from
    the title — the panel would then present a name this app made up as the
    file that is on disk.
    """
    movie_file = movie.get("movieFile")
    if not isinstance(movie_file, dict):
        return ""
    relative_path = movie_file.get("relativePath")
    return relative_path if isinstance(relative_path, str) else ""


def _movie_languages(movie: dict) -> list[str]:
    """The names in ``movieFile.languages``, or ``[]`` when unknown.

    Radarr sends ``[{"id": 1, "name": "Spanish"}, ...]`` — objects, not
    strings. Every step is guarded so the list can only ever contain names the
    arr actually reported: a non-list container, an entry without ``name``, an
    empty or non-string ``name`` are all dropped rather than stringified
    (``{"id": 3}`` must never reach the screen as ``"undefined"``), and the
    result is never padded — ``[]`` renders nothing, ``[""]`` would render a
    language nobody spoke.
    """
    movie_file = movie.get("movieFile")
    if not isinstance(movie_file, dict):
        return []
    languages = movie_file.get("languages")
    if not isinstance(languages, list):
        return []
    names = []
    for entry in languages:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if isinstance(name, str) and name:
            names.append(name)
    return names


def _folder_has_video(path: str) -> bool:
    """Whether this title's folder holds a video Radarr never imported.

    Radarr's ``hasFile`` is an IMPORT state, not a disk fact: a file that
    arrived outside Radarr (a manual copy, an aMule download) leaves
    ``hasFile: false`` while the bytes sit in ``movie.path``, and the UI then
    printed "✗ Sin archivo" over a folder full of video. This is the disk-side
    answer to that one question, decided by the repo's single definition of
    "video" (``naming.MEDIA_EXTENSIONS``).

    Bounded on purpose: callers invoke it ONLY when ``hasFile`` is false —
    65 of 913 titles on the real library, never the 848 that would turn one
    Biblioteca request into a full directory walk of an NFS mount per page.
    An unreadable or missing folder reads as ``False``, never as an
    exception: a store of any kind must not fail the whole listing.
    """
    try:
        with os.scandir(path) as entries:
            for entry in entries:
                if entry.is_file() and os.path.splitext(entry.name)[1].lower() in MEDIA_EXTENSIONS:
                    return True
    except OSError:
        return False
    return False


async def fetch_all_movies_detailed(
    session: aiohttp.ClientSession, service: dict, page: int = 1, page_size: int = 50
) -> dict:
    """Devuelve todas las películas de Radarr con estado de archivo y ruta (paginado)."""
    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/movie",
            headers=headers,
            params={"sortKey": "title", "sortDirection": "ascending"},
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2),
        ) as resp:
            if resp.status != 200:
                return {**_empty_page(page, page_size), **arr_failure(service, status=resp.status)}
            data = await resp.json(content_type=None)
            valid_movies = [m for m in data if isinstance(m, dict) and "id" in m]
            total = len(valid_movies)

            if page_size > 0:
                start = (page - 1) * page_size
                end = start + page_size
                sliced = valid_movies[start:end]
            else:
                sliced = valid_movies

            items = []
            for m in sliced:
                path = m.get("path", "")
                # Radarr reports the path AS IT SEES IT (/data/...); the disk
                # lives under the mount this host sees. Asking `isdir` about
                # the arr's view is B-08: a healthy folder read as missing.
                # The path EXPOSED below stays the arr's own — Calidad matches
                # path_4k/path_3d membership off that field.
                fs_path = config.host_path(path) if path else ""
                path_exists = False
                if fs_path:
                    try:
                        path_exists = os.path.isdir(fs_path)
                    except (OSError, ValueError):
                        path_exists = False
                has_file = m.get("hasFile", False)
                items.append({
                    "id": m.get("id"),
                    "title": m.get("title", ""),
                    "year": m.get("year"),
                    "remotePoster": _poster_url(m, service["key"]),
                    "has_file": has_file,
                    # Radarr's `hasFile: false` says "not imported", not "no
                    # bytes on disk". Only for THOSE titles is the folder
                    # listed (never for the imported 848 — see
                    # `_folder_has_video`), so a video Radarr never picked up
                    # stops being reported as "Sin archivo". False means
                    # "checked and none found" or "imported already", and an
                    # unreadable folder also lands here.
                    "has_unimported_file": (
                        not has_file and path_exists and _folder_has_video(fs_path)
                    ),
                    # The path is exposed, not only measured: the Calidad view
                    # reads the path_4k/path_3d membership off it.
                    "path": path,
                    # "" means unknown (no file / odd payload), never a guess.
                    "quality": _movie_quality(m),
                    # The file itself, from the same `movieFile` the quality
                    # came from: its name and its languages. "" / [] mean "not
                    # available", never a title-derived name or a placeholder.
                    "file_name": _movie_file_name(m),
                    "languages": _movie_languages(m),
                    "path_exists": path_exists,
                    "monitored": m.get("monitored", False),
                })
            return {"items": items, "total": total, "page": page, "page_size": page_size}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {**_empty_page(page, page_size), **arr_failure(service, exc=exc)}


async def fetch_all_series_detailed(
    session: aiohttp.ClientSession, service: dict, page: int = 1, page_size: int = 50
) -> dict:
    """Devuelve todas las series de Sonarr con estado de archivo y ruta (paginado)."""
    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/series",
            headers=headers,
            params={"sortKey": "title", "sortDirection": "ascending"},
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2),
        ) as resp:
            if resp.status != 200:
                return {**_empty_page(page, page_size), **arr_failure(service, status=resp.status)}
            data = await resp.json(content_type=None)
            valid_series = [s for s in data if isinstance(s, dict) and "id" in s]
            total = len(valid_series)

            if page_size > 0:
                start = (page - 1) * page_size
                end = start + page_size
                sliced = valid_series[start:end]
            else:
                sliced = valid_series

            items = []
            for s in sliced:
                path = s.get("path", "")
                # Same rule as the movie listing (B-08): the disk is asked
                # through the host's view of the path, the arr's own path is
                # what the row exposes.
                fs_path = config.host_path(path) if path else ""
                path_exists = False
                if fs_path:
                    try:
                        path_exists = os.path.isdir(fs_path)
                    except (OSError, ValueError):
                        path_exists = False
                items.append({
                    "id": s.get("id"),
                    "title": s.get("title", ""),
                    "year": s.get("year"),
                    "remotePoster": _poster_url(s, service["key"]),
                    "has_file": s.get("statistics", {}).get("episodeFileCount", 0) > 0,
                    # Exposed because the class of a series IS derived from
                    # where it lives (path_4k → 4K, path_3d → 3D): Sonarr's list
                    # carries no quality, so this path is the honest signal.
                    "path": path,
                    "path_exists": path_exists,
                    "monitored": s.get("monitored", False),
                    "episode_count": s.get("statistics", {}).get("episodeCount", 0),
                    "episode_file_count": s.get("statistics", {}).get("episodeFileCount", 0),
                })
            return {"items": items, "total": total, "page": page, "page_size": page_size}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {**_empty_page(page, page_size), **arr_failure(service, exc=exc)}


async def fetch_wanted_episodes(session: aiohttp.ClientSession, service: dict, page: int = 1, page_size: int = 50) -> dict:
    """Devuelve episodios monitorizados sin archivo (wanted/missing)."""
    headers = arr_headers(service["api_key"])
    params = {
        "sortKey": "airDateUtc",
        "sortDirection": "descending",
        "monitored": "true",
        "includeSeries": "true",
        "page": str(page),
        "pageSize": str(page_size),
    }
    try:
        async with session.get(
            f"{service['url']}/api/v3/wanted/missing",
            headers=headers,
            params=params,
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2),
        ) as resp:
            if resp.status != 200:
                return {**_empty_page(page, page_size), **arr_failure(service, status=resp.status)}
            data = await resp.json(content_type=None)
            items = [
                {
                    "id": ep.get("id"),
                    "title": ep.get("title", ""),
                    "series_title": (ep.get("series") or {}).get("title", ""),
                    "series_id": ep.get("seriesId"),
                    "season_number": ep.get("seasonNumber"),
                    "episode_number": ep.get("episodeNumber"),
                    "air_date": ep.get("airDateUtc", ""),
                    "overview": ep.get("overview", ""),
                    "has_file": ep.get("hasFile", False),
                    "alternateTitles": (ep.get("series") or {}).get("alternateTitles", []),
                }
                for ep in data.get("records", [])
            ]
            total = data.get("totalRecords") or data.get("total", len(items))
            return {"items": items, "total": total, "page": page, "page_size": page_size}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {**_empty_page(page, page_size), **arr_failure(service, exc=exc)}


async def arr_series_episodes(session: aiohttp.ClientSession, service: dict, series_id: int) -> dict:
    """Episodios de una serie, con el archivo que Sonarr ya tiene.

    Two endpoints, because neither one alone is the row this draws. Sonarr's
    ``/api/v3/episode`` answers WHETHER an episode has its file (``hasFile``)
    and carries ``episodeFileId``; the path and the quality name live on
    ``/api/v3/episodefile``, which is only reachable by that id. Joining them
    gives what the prototype puts on a row: the pill, the quality tag and the
    folder it sits in.

    They are asked in parallel — neither depends on the other, and the panel is
    the slowest page in the app to reach.

    **A failed file lookup does not fail the list.** Episodes come back with
    ``has_file`` intact and ``path``/``quality`` null. That combination is not a
    gap in the data: ``has_file: true`` with no path reads as "it is there and
    we could not read it", which is what happened, rather than "it is not
    there", which would be a lie. Only a failure of the episode call itself
    ends the request, as before.

    The field names on both payloads are Sonarr's own, not a superset invented
    here: ``EpisodeResource.hasFile``/``episodeFileId`` and
    ``EpisodeFileResource.path``/``quality.quality.name`` were read from the
    live instance before this was written.
    """
    headers = arr_headers(service["api_key"])
    url = service["url"]
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2)

    async def _episodes() -> dict:
        async with session.get(
            f"{url}/api/v3/episode",
            params={"seriesId": str(series_id)},
            headers=headers,
            timeout=timeout,
        ) as resp:
            if resp.status != 200:
                return {"episodes": [], **arr_failure(service, status=resp.status)}
            return {"episodes": await resp.json(content_type=None)}

    async def _files() -> dict:
        async with session.get(
            f"{url}/api/v3/episodefile",
            params={"seriesId": str(series_id)},
            headers=headers,
            timeout=timeout,
        ) as resp:
            if resp.status != 200:
                log.warning("arr_series_episodes episodefile status=%d", resp.status)
                return {}
            data = await resp.json(content_type=None)
            return {
                f["id"]: f
                for f in data
                if isinstance(f, dict) and f.get("id") is not None
            }

    payload, raw_files = await asyncio.gather(_episodes(), _files())

    if "error" in payload:
        return payload

    episodes: list[dict] = []
    for ep in payload["episodes"]:
        if not isinstance(ep, dict):
            continue
        # A None file id is not "id 0": it means Sonarr has no file for this
        # episode, and a dict lookup on it would raise KeyError on the next line.
        file_id = ep.get("episodeFileId")
        entry = raw_files.get(file_id) if file_id is not None else None
        quality = (entry or {}).get("quality") or {}
        quality = quality.get("quality") if isinstance(quality, dict) else {}
        episodes.append({
            "id": ep.get("id"),
            "season_number": ep.get("seasonNumber"),
            "episode_number": ep.get("episodeNumber"),
            "title": ep.get("title", ""),
            "air_date": ep.get("airDateUtc", ""),
            "has_file": ep.get("hasFile", False),
            "quality": (quality or {}).get("name") if isinstance(quality, dict) else None,
            "path": (entry or {}).get("path"),
        })
    return {"episodes": episodes}


async def arr_search_missing_movies(session: aiohttp.ClientSession, service: dict) -> dict:
    """Lanza búsqueda masiva de todas las películas faltantes."""
    return await arr_command(session, service, {"name": "MissingMoviesSearch"})


async def arr_search_missing_episodes(session: aiohttp.ClientSession, service: dict) -> dict:
    """Lanza búsqueda masiva de todos los episodios faltantes."""
    return await arr_command(session, service, {"name": "MissingEpisodeSearch"})


async def arr_search_movie(session: aiohttp.ClientSession, service: dict, movie_id: int) -> dict:
    """Busca una película específica en los indexadores."""
    return await arr_command(session, service, {"name": "MoviesSearch", "movieIds": [movie_id]})


async def arr_search_episode(session: aiohttp.ClientSession, service: dict, episode_id: int) -> dict:
    """Busca un episodio específico en los indexadores."""
    return await arr_command(session, service, {"name": "EpisodeSearch", "episodeIds": [episode_id]})


async def arr_add_movie(session: aiohttp.ClientSession, service: dict, movie_data: dict) -> dict:
    """Agrega una película a la biblioteca de Radarr via POST /api/v3/movie."""
    headers = arr_headers(service["api_key"])
    headers["Content-Type"] = "application/json"
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2)
    url = f"{service['url']}/api/v3/movie"
    log.info("arr_add_movie %s payload=%s", service["key"], {k: v for k, v in movie_data.items() if k != "images"})
    try:
        async with session.post(url, headers=headers, json=movie_data, timeout=timeout) as resp:
            text = await resp.text()
            if resp.status in (200, 201):
                try:
                    data = await resp.json(content_type=None)
                    movie_id = data.get("id")
                except Exception:
                    movie_id = None
                log.info("arr_add_movie %s OK id=%s", service["key"], movie_id)
                return {"ok": True, "id": movie_id, "detail": "Película agregada a Radarr"}
            log.warning("arr_add_movie %s status=%d body=%s", service["key"], resp.status, text[:300])
            return {"ok": False, "id": None, "detail": f"HTTP {resp.status}: {text[:300]}"}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        log.warning("arr_add_movie %s error: %s", service["key"], exc)
        return {"ok": False, "id": None, "detail": f"{type(exc).__name__}: {exc}"}


async def arr_add_series(session: aiohttp.ClientSession, service: dict, series_data: dict) -> dict:
    """Agrega una serie a la biblioteca de Sonarr via POST /api/v3/series."""
    headers = arr_headers(service["api_key"])
    headers["Content-Type"] = "application/json"
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2)
    url = f"{service['url']}/api/v3/series"
    log.info("arr_add_series %s payload=%s", service["key"], {k: v for k, v in series_data.items() if k != "images"})
    try:
        async with session.post(url, headers=headers, json=series_data, timeout=timeout) as resp:
            text = await resp.text()
            if resp.status in (200, 201):
                try:
                    data = await resp.json(content_type=None)
                    series_id = data.get("id")
                except Exception:
                    series_id = None
                log.info("arr_add_series %s OK id=%s", service["key"], series_id)
                return {"ok": True, "id": series_id, "detail": "Serie agregada a Sonarr"}
            log.warning("arr_add_series %s status=%d body=%s", service["key"], resp.status, text[:300])
            return {"ok": False, "id": None, "detail": f"HTTP {resp.status}: {text[:300]}"}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        log.warning("arr_add_series %s error: %s", service["key"], exc)
        return {"ok": False, "id": None, "detail": f"{type(exc).__name__}: {exc}"}


async def arr_series_lookup(session: aiohttp.ClientSession, service: dict, title: str) -> dict:
    """Busca una serie por título en Sonarr y devuelve metadata (tvdbId, title, year, etc)."""
    headers = arr_headers(service["api_key"])
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2)
    try:
        async with session.get(
            f"{service['url']}/api/v3/series/lookup",
            headers=headers,
            params={"term": title},
            timeout=timeout,
        ) as resp:
            if resp.status != 200:
                return {}
            data = await resp.json(content_type=None)
            if not data:
                return {}
            s = data[0]
            return {
                "tvdbId": s.get("tvdbId", 0),
                "title": s.get("title", ""),
                "year": s.get("year"),
                "seasonFolder": s.get("seasonFolder", True),
                "qualityProfileId": s.get("qualityProfileId", 1),
                "path": s.get("path", ""),
            }
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        log.warning("arr_series_lookup %s error: %s", service["key"], exc)
        return {}


async def arr_movie_lookup(session: aiohttp.ClientSession, service: dict, title: str) -> dict:
    """Busca una película por título en Radarr y devuelve metadata (tmdbId, title, year, etc)."""
    headers = arr_headers(service["api_key"])
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2)
    try:
        async with session.get(
            f"{service['url']}/api/v3/movie/lookup",
            headers=headers,
            params={"term": title},
            timeout=timeout,
        ) as resp:
            if resp.status != 200:
                return {}
            data = await resp.json(content_type=None)
            if not data:
                return {}
            m = data[0]
            return {
                "tmdbId": m.get("tmdbId", 0),
                "title": m.get("title", ""),
                "year": m.get("year"),
                "qualityProfileId": m.get("qualityProfileId", 1),
                "path": m.get("path", ""),
            }
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        log.warning("arr_movie_lookup %s error: %s", service["key"], exc)
        return {}


async def arr_movie_exists(session: aiohttp.ClientSession, service: dict, tmdb_id: int) -> int | None:
    """Verifica si una película ya existe en Radarr por tmdbId. Retorna el ID de Radarr o None."""
    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/movie",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT),
        ) as resp:
            if resp.status != 200:
                return None
            data = await resp.json(content_type=None)
            for m in data:
                if m.get("tmdbId") == tmdb_id:
                    return m.get("id")
            return None
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return None


async def arr_series_exists(session: aiohttp.ClientSession, service: dict, tvdb_id: int) -> int | None:
    """Verifica si una serie ya existe en Sonarr por tvdbId. Retorna el ID de Sonarr o None."""
    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/series",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT),
        ) as resp:
            if resp.status != 200:
                return None
            data = await resp.json(content_type=None)
            for s in data:
                if s.get("tvdbId") == tvdb_id:
                    return s.get("id")
            return None
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return None


async def arr_fetch_releases(session: aiohttp.ClientSession, service: dict, movie_id: int = 0, episode_id: int = 0) -> dict:
    """Lanza búsqueda de releases en Radarr/Sonarr via GET /api/v3/release.
    
    Radarr: GET /api/v3/release?movieId=X (lanza búsqueda en todos los indexadores).
    Sonarr: GET /api/v3/release?episodeId=X (lanza búsqueda en todos los indexadores).
    """
    headers = arr_headers(service["api_key"])
    headers["Content-Type"] = "application/json"
    if not movie_id and not episode_id:
        return {"releases": [], "detail": "Se requiere movieId o episodeId"}
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 48)  # 5*48=240s=4min (aMuleTorrent puede ser lento)
    log.info("arr_fetch_releases %s movieId=%s episodeId=%s", service["key"], movie_id or "-", episode_id or "-")
    try:
        params: dict[str, int] = {}
        if movie_id:
            params["movieId"] = movie_id
        elif episode_id:
            params["episodeId"] = episode_id
        url = f"{service['url']}/api/v3/release"
        log.info("arr_fetch_releases %s GET %s params=%s", service["key"], url, params)
        async with session.get(
            url,
            headers=headers,
            params=params,
            timeout=timeout,
        ) as resp:
            if resp.status != 200:
                text = await resp.text()
                log.warning("arr_fetch_releases %s status=%d body=%s", service["key"], resp.status, text[:200])
                return {"releases": [], "detail": f"HTTP {resp.status}: {text[:200]}"}
            data = await resp.json(content_type=None)
        releases = []
        for r in data:
            # quality comes as {quality: {id, name, source, ...}, revision: {...}}
            q = r.get("quality", {})
            if isinstance(q, dict):
                inner = q.get("quality", {})
                quality_name = inner.get("name", "Unknown") if isinstance(inner, dict) else str(inner)
            else:
                quality_name = str(q) if q else "Unknown"
            releases.append({
                "guid": r.get("guid", ""),
                "title": r.get("title", ""),
                "size": r.get("size", 0),
                "quality": quality_name,
                "indexer": r.get("indexer", ""),
                "indexerId": r.get("indexerId", 0),
                "indexerFlags": r.get("indexerFlags", ""),
                "seeders": r.get("seeders", 0),
                "leechers": r.get("leechers", 0),
                "protocol": r.get("protocol", "torrent"),
                "releaseGroup": r.get("releaseGroup", ""),
                "languages": [l.get("name", "") if isinstance(l, dict) else str(l) for l in r.get("languages", [])],
            })
        log.info("arr_fetch_releases %s found %d releases", service["key"], len(releases))
        return {"releases": releases, "detail": f"{len(releases)} releases encontrados"}
    except asyncio.TimeoutError:
        log.warning("arr_fetch_releases %s TIMEOUT after %ds", service["key"], int(timeout.total))
        return {"releases": [], "detail": f"Timeout: Radarr/Sonarr no respondió en {int(timeout.total)}s. Verifica que el servicio esté activo."}
    except aiohttp.ClientError as exc:
        log.warning("arr_fetch_releases %s error: %s", service["key"], exc)
        return {"releases": [], "detail": f"Error de conexión: {exc}"}


async def arr_grab_release(session: aiohttp.ClientSession, service: dict, guid: str, indexer_id: int = 0, movie_id: int = 0, episode_id: int = 0) -> dict:
    """Descarga un release específico via POST /api/v3/release."""
    headers = arr_headers(service["api_key"])
    headers["Content-Type"] = "application/json"
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2)
    body = {"guid": guid}
    if indexer_id:
        body["indexerId"] = indexer_id
    if movie_id:
        body["movieId"] = movie_id
    elif episode_id:
        body["episodeId"] = episode_id
    log.info("arr_grab_release %s guid=%s body=%s", service["key"], guid[:32], body)
    try:
        async with session.post(
            f"{service['url']}/api/v3/release",
            headers=headers,
            json=body,
            timeout=timeout,
        ) as resp:
            text = await resp.text()
            if resp.status in (200, 201):
                return {"ok": True, "detail": "Release encolado para descarga"}
            log.warning("arr_grab_release %s status=%d body=%s", service["key"], resp.status, text[:500])
            # Try to parse Radarr/Sonarr JSON error for human-readable message
            try:
                import json as _json
                err_data = _json.loads(text)
                if isinstance(err_data, list) and err_data:
                    messages = [e.get("errorMessage", str(e)) for e in err_data if isinstance(e, dict)]
                    detail = "; ".join(messages) if messages else f"HTTP {resp.status}"
                elif isinstance(err_data, dict):
                    detail = err_data.get("message", err_data.get("detail", f"HTTP {resp.status}"))
                else:
                    detail = f"HTTP {resp.status}: {text[:200]}"
            except (ValueError, TypeError):
                detail = f"HTTP {resp.status}: {text[:200]}"
            return {"ok": False, "detail": detail}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


async def arr_manual_import(session: aiohttp.ClientSession, service: dict, file_path: str, movie_id: int) -> dict:
    """Importa un archivo directamente a una película en Radarr via POST /api/v3/manualimport."""
    headers = arr_headers(service["api_key"])
    headers["Content-Type"] = "application/json"
    body = [{"path": file_path, "movieId": movie_id}]
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2)
    try:
        async with session.post(
            f"{service['url']}/api/v3/manualimport",
            headers=headers,
            json=body,
            timeout=timeout,
        ) as resp:
            text = await resp.text()
            log.info("Radarr manualimport response: status=%s body=%s", resp.status, text[:500])
            if resp.status in (200, 201):
                return {"ok": True, "detail": "Importación manual completada", "response": text[:500]}
            return {"ok": False, "detail": f"HTTP {resp.status}: {text[:300]}"}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


async def arr_refresh_movie(session: aiohttp.ClientSession, service: dict, movie_id: int) -> dict:
    """Refresca metadata y escanea la carpeta de una película en Radarr."""
    return await arr_command(session, service, {"name": "RefreshMovie", "movieId": movie_id})


async def arr_rescan_movie(session: aiohttp.ClientSession, service: dict, movie_id: int) -> dict:
    """Re-escanea la carpeta de una película en Radarr (sin refrescar metadata)."""
    return await arr_command(session, service, {"name": "RescanMovie", "movieId": movie_id})


async def arr_rescan_series(session: aiohttp.ClientSession, service: dict, series_id: int) -> dict:
    """Re-escanea la carpeta de una serie en Sonarr para detectar e importar nuevos episodios."""
    return await arr_command(session, service, {"name": "RescanSeries", "seriesId": series_id})


async def arr_refresh_series(session: aiohttp.ClientSession, service: dict, series_id: int) -> dict:
    """Refresca metadata y re-escanea la serie en Sonarr."""
    return await arr_command(session, service, {"name": "RefreshSeries", "seriesId": series_id})


async def arr_downloaded_scan(session: aiohttp.ClientSession, service: dict, folder_path: str) -> dict:
    """Escanea una carpeta buscando películas para importar."""
    return await arr_command(session, service, {
        "name": "DownloadedMoviesScan",
        "path": folder_path,
        "importMode": "Move",
    })


async def arr_downloaded_episodes_scan(session: aiohttp.ClientSession, service: dict, folder_path: str) -> dict:
    """Escanea una carpeta buscando episodios para importar en Sonarr."""
    return await arr_command(session, service, {
        "name": "DownloadedEpisodesScan",
        "path": folder_path,
        "importMode": "Move",
    })


async def fetch_radarr_calendar(session: aiohttp.ClientSession, service: dict, start: str, end: str) -> list[dict]:
    """Devuelve películas próximas de Radarr entre start y end (YYYY-MM-DD)."""
    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/calendar",
            headers=headers,
            params={"start": start, "end": end},
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2),
        ) as resp:
            if resp.status != 200:
                return []
            data = await resp.json(content_type=None)
            items = []
            for m in data:
                if "id" not in m:
                    continue
                release = m.get("physicalRelease") or m.get("digitalRelease") or m.get("inCinemas") or ""
                items.append({
                    "type": "movie",
                    "id": m.get("id"),
                    "title": m.get("title", ""),
                    "date": release[:10] if release else "",
                    "year": m.get("year"),
                    "has_file": m.get("hasFile", False),
                    "remotePoster": _poster_url(m, service["key"]),
                    "series_title": None,
                    "season_number": None,
                    "episode_number": None,
                    "source": "radarr",
                })
            return items
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return []


async def fetch_sonarr_calendar(session: aiohttp.ClientSession, service: dict, start: str, end: str) -> list[dict]:
    """Devuelve episodios próximos de Sonarr entre start y end (YYYY-MM-DD)."""
    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/calendar",
            headers=headers,
            params={"start": start, "end": end, "includeSeries": "true"},
            timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * 2),
        ) as resp:
            if resp.status != 200:
                return []
            data = await resp.json(content_type=None)
            items = []
            for ep in data:
                if "id" not in ep:
                    continue
                series = ep.get("series", {})
                air = ep.get("airDate") or ep.get("airDateUtc") or ""
                items.append({
                    "type": "episode",
                    "id": ep.get("id"),
                    "title": ep.get("title", ""),
                    "date": air[:10] if air else "",
                    "year": series.get("year"),
                    "has_file": ep.get("hasFile", False),
                    "remotePoster": _poster_url(series, service["key"]),
                    "series_title": series.get("title", ""),
                    "season_number": ep.get("seasonNumber"),
                    "episode_number": ep.get("episodeNumber"),
                    "source": "sonarr",
                })
            return items
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return []
