import asyncio
import json
import logging
import os
import time

import aiohttp

from config import (
    AMUTORRENT_API_KEY,
    AMUTORRENT_PASSWORD,
    AMUTORRENT_URL,
    AMUTORRENT_USER,
    _AMU_WS_COMPLETE,
    MAX_RETRIES,
    QBIT_COMPLETED,
    QBIT_DOWNLOADING,
    REQUEST_TIMEOUT,
    RETRY_DELAY,
)

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


async def check_arr(session: aiohttp.ClientSession, service: dict) -> tuple[str, str, dict]:
    url = service["url"]
    headers = arr_headers(service["api_key"])
    endpoint = f"{url}/api/v3/system/status"
    last_error = "sin respuesta"
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT)
            async with session.get(endpoint, headers=headers, timeout=timeout) as resp:
                if resp.status in (200, 401, 301, 302):
                    return "online", f"Conexión exitosa (intento {attempt})", {}
                last_error = f"HTTP {resp.status}"
        except asyncio.TimeoutError:
            last_error = "Timeout"
        except aiohttp.ClientError as exc:
            last_error = type(exc).__name__
        if attempt < MAX_RETRIES:
            await asyncio.sleep(RETRY_DELAY)
    return "offline", f"Fallaron {MAX_RETRIES} intentos ({last_error})", {}


async def fetch_qbit_meta(session: aiohttp.ClientSession, service: dict) -> dict:
    headers = qbit_headers(service["api_key"])
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT)
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
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT)
            async with session.get(endpoint, headers=headers, timeout=timeout) as resp:
                if resp.status == 200:
                    meta = await fetch_qbit_meta(session, service)
                    return "online", f"Conexión exitosa (intento {attempt})", meta
                last_error = f"HTTP {resp.status}"
        except asyncio.TimeoutError:
            last_error = "Timeout"
        except aiohttp.ClientError as exc:
            last_error = type(exc).__name__
        if attempt < MAX_RETRIES:
            await asyncio.sleep(RETRY_DELAY)
    return "offline", f"Fallaron {MAX_RETRIES} intentos ({last_error})", {}


async def check_service(session: aiohttp.ClientSession, service: dict) -> tuple[str, str, dict]:
    if service["kind"] == "qbit":
        return await check_qbit(session, service)
    return await check_arr(session, service)


async def arr_command(session: aiohttp.ClientSession, service: dict, body: dict) -> dict:
    headers = arr_headers(service["api_key"])
    headers["Content-Type"] = "application/json"
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2)
    try:
        async with session.post(
            f"{service['url']}/api/v3/command", headers=headers, json=body, timeout=timeout
        ) as resp:
            text = await resp.text()
            if resp.status in (200, 201):
                return {"ok": True, "detail": f"Comando '{body.get('name')}' encolado"}
            return {"ok": False, "detail": f"HTTP {resp.status}: {text[:200]}"}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


async def qbit_post(session: aiohttp.ClientSession, path: str, data: dict) -> dict:
    headers = qbit_headers(AMUTORRENT_API_KEY)
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2)
    try:
        async with session.post(
            f"{AMUTORRENT_URL}{path}", headers=headers, data=data, timeout=timeout
        ) as resp:
            if resp.status == 200:
                return {"ok": True, "detail": f"{path} OK"}
            return {"ok": False, "detail": f"HTTP {resp.status}"}
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
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2),
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


async def arr_delete_queue(session: aiohttp.ClientSession, service: dict, queue_id: int, blocklist: bool) -> dict:
    headers = arr_headers(service["api_key"])
    url = (
        f"{service['url']}/api/v3/queue/{queue_id}"
        f"?removeFromClient=true&blocklist={'true' if blocklist else 'false'}"
    )
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2)
    try:
        async with session.delete(url, headers=headers, timeout=timeout) as resp:
            if resp.status in (200, 204):
                return {"ok": True, "detail": "Item eliminado de la cola"}
            return {"ok": False, "detail": f"HTTP {resp.status}"}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


async def arr_remote_paths(session: aiohttp.ClientSession, service: dict) -> list[dict]:
    headers = arr_headers(service["api_key"])
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2)
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
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2)
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
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
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
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
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
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
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
    """Devuelve metadatos completos de un episodio: season_number, episode_number, title."""
    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/episode/{episode_id}",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
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
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
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
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
        ) as resp:
            if resp.status != 200:
                return {}
            data = await resp.json(content_type=None)
            quality = ""
            mf = data.get("movieFile") or {}
            q = (mf.get("quality") or {}).get("quality") or {}
            quality = q.get("name", "")
            alt_titles = [
                alt.get("title", "") if isinstance(alt, dict) else str(alt)
                for alt in (data.get("altTitles") or [])
            ]
            return {
                "title": data.get("title", ""),
                "year": data.get("year"),
                "quality": quality,
                "path": data.get("path", ""),
                "altTitles": alt_titles,
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
                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
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
                    timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
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
                    timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
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
                    timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
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


async def fetch_arr_all_series(session: aiohttp.ClientSession, service: dict) -> dict[int, str]:
    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/series",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2),
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
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2),
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
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2)
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
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2)
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
        async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT)) as resp:
            if resp.status != 200:
                return []
            return await resp.json(content_type=None)
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return []


async def arr_indexers(session: aiohttp.ClientSession, service: dict) -> list[dict]:
    """Obtiene la lista de indexadores configurados en Radarr/Sonarr."""
    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/indexer",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
        ) as resp:
            if resp.status != 200:
                return []
            data = await resp.json(content_type=None)
            return [
                {
                    "id": idx.get("id"),
                    "name": idx.get("name", ""),
                    "implementation": idx.get("implementation", ""),
                    "configFields": [
                        {"name": f.get("name", ""), "value": f.get("value", "")}
                        for f in idx.get("configFields", [])
                        if f.get("name") == "apiUrl"
                    ],
                    "enableRss": idx.get("enableRss", False),
                    "enableSearch": idx.get("enableSearch", False),
                }
                for idx in data
                if idx.get("enableSearch", False)
            ]
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return []


async def arr_root_folders(session: aiohttp.ClientSession, service: dict) -> list[str]:
    """Obtiene las carpetas raíz configuradas en Radarr/Sonarr."""
    headers = arr_headers(service["api_key"])
    url = f"{service['url']}/api/v3/rootfolder"
    try:
        async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT)) as resp:
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
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 3)
    try:
        async with session.get(
            f"{AMUTORRENT_URL}/api/v2/torrents/info", headers=headers, timeout=timeout
        ) as resp:
            if resp.status != 200:
                return []
            return await resp.json(content_type=None)
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return []


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
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2),
        ) as resp:
            if resp.status != 200:
                return {"items": [], "total": 0}
            data = await resp.json(content_type=None)
            items = [
                {
                    "id": m.get("id"),
                    "title": m.get("title", ""),
                    "year": m.get("year"),
                    "overview": m.get("overview", ""),
                    "remotePoster": m.get("remotePoster", ""),
                    "has_file": m.get("hasFile", False),
                    "altTitles": [
                        alt.get("title", "") if isinstance(alt, dict) else str(alt)
                        for alt in (m.get("altTitles") or [])
                    ],
                }
                for m in data.get("records", [])
            ]
            return {"items": items, "total": data.get("total", len(items))}
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return {"items": [], "total": 0}


async def fetch_all_movies_detailed(session: aiohttp.ClientSession, service: dict) -> dict:
    """Devuelve todas las películas de Radarr con estado de archivo y ruta."""
    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/movie",
            headers=headers,
            params={"sortKey": "title", "sortDirection": "ascending"},
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2),
        ) as resp:
            if resp.status != 200:
                return {"items": [], "total": 0}
            data = await resp.json(content_type=None)
            items = []
            for m in data:
                if "id" not in m:
                    continue
                path = m.get("path", "")
                path_exists = False
                if path:
                    try:
                        path_exists = os.path.isdir(path)
                    except (OSError, ValueError):
                        path_exists = False
                items.append({
                    "id": m.get("id"),
                    "title": m.get("title", ""),
                    "year": m.get("year"),
                    "remotePoster": m.get("remotePoster", ""),
                    "has_file": m.get("hasFile", False),
                    "path_exists": path_exists,
                    "monitored": m.get("monitored", False),
                })
            return {"items": items, "total": len(items)}
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return {"items": [], "total": 0}


async def fetch_all_series_detailed(session: aiohttp.ClientSession, service: dict) -> dict:
    """Devuelve todas las series de Sonarr con estado de archivo y ruta."""
    headers = arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/series",
            headers=headers,
            params={"sortKey": "title", "sortDirection": "ascending"},
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2),
        ) as resp:
            if resp.status != 200:
                return {"items": [], "total": 0}
            data = await resp.json(content_type=None)
            items = []
            for s in data:
                if "id" not in s:
                    continue
                path = s.get("path", "")
                path_exists = False
                if path:
                    try:
                        path_exists = os.path.isdir(path)
                    except (OSError, ValueError):
                        path_exists = False
                seasons = s.get("seasons", [])
                total_episodes = sum(len(sea.get("episodes", [])) for sea in seasons)
                items.append({
                    "id": s.get("id"),
                    "title": s.get("title", ""),
                    "year": s.get("year"),
                    "remotePoster": s.get("remotePoster", ""),
                    "has_file": s.get("statistics", {}).get("episodeFileCount", 0) > 0,
                    "path_exists": path_exists,
                    "monitored": s.get("monitored", False),
                    "episode_count": s.get("statistics", {}).get("episodeCount", 0),
                    "episode_file_count": s.get("statistics", {}).get("episodeFileCount", 0),
                })
            return {"items": items, "total": len(items)}
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return {"items": [], "total": 0}


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
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2),
        ) as resp:
            if resp.status != 200:
                return {"items": [], "total": 0}
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
            return {"items": items, "total": data.get("total", len(items))}
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return {"items": [], "total": 0}


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
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2)
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
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2)
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
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2)
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
            # Return first match
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


async def arr_fetch_releases(session: aiohttp.ClientSession, service: dict, movie_id: int = 0, episode_id: int = 0) -> dict:
    """Obtiene releases disponibles de Radarr/Sonarr via GET /api/v3/release."""
    headers = arr_headers(service["api_key"])
    params: dict[str, int] = {}
    if movie_id:
        params["movieId"] = movie_id
    elif episode_id:
        params["episodeId"] = episode_id
    else:
        return {"releases": [], "detail": "Se requiere movieId o episodeId"}
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 3)
    try:
        async with session.get(
            f"{service['url']}/api/v3/release",
            headers=headers,
            params=params,
            timeout=timeout,
        ) as resp:
            if resp.status != 200:
                text = await resp.text()
                return {"releases": [], "detail": f"HTTP {resp.status}: {text[:200]}"}
            data = await resp.json(content_type=None)
            releases = []
            for r in data:
                releases.append({
                    "guid": r.get("guid", ""),
                    "title": r.get("title", ""),
                    "size": r.get("size", 0),
                    "quality": r.get("quality", {}).get("quality", "Unknown"),
                    "indexer": r.get("indexer", ""),
                    "indexerFlags": r.get("indexerFlags", ""),
                    "seeders": r.get("seeders", 0),
                    "leechers": r.get("leechers", 0),
                    "protocol": r.get("protocol", "torrent"),
                    "releaseGroup": r.get("releaseGroup", ""),
                    "languages": [l.get("name", "") for l in r.get("languages", [])],
                })
            return {"releases": releases, "detail": f"{len(releases)} releases encontrados"}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {"releases": [], "detail": f"{type(exc).__name__}: {exc}"}


async def arr_grab_release(session: aiohttp.ClientSession, service: dict, guid: str) -> dict:
    """Descarga un release específico via POST /api/v3/release/pick."""
    headers = arr_headers(service["api_key"])
    headers["Content-Type"] = "application/json"
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2)
    try:
        async with session.post(
            f"{service['url']}/api/v3/release/pick",
            headers=headers,
            json={"guid": guid},
            timeout=timeout,
        ) as resp:
            text = await resp.text()
            if resp.status in (200, 201):
                return {"ok": True, "detail": "Release encolado para descarga"}
            return {"ok": False, "detail": f"HTTP {resp.status}: {text[:200]}"}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


async def arr_manual_import(session: aiohttp.ClientSession, service: dict, file_path: str, movie_id: int) -> dict:
    """Importa un archivo directamente a una película en Radarr via POST /api/v3/manualimport."""
    headers = arr_headers(service["api_key"])
    headers["Content-Type"] = "application/json"
    body = [{"path": file_path, "movieId": movie_id}]
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2)
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


async def arr_downloaded_scan(session: aiohttp.ClientSession, service: dict, folder_path: str) -> dict:
    """Escanea una carpeta buscando películas para importar."""
    return await arr_command(session, service, {
        "name": "DownloadedMoviesScan",
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
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2),
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
                    "remotePoster": (m.get("images") or [{}])[0].get("url", "") if m.get("images") else "",
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
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2),
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
                    "remotePoster": (series.get("images") or [{}])[0].get("url", "") if series.get("images") else "",
                    "series_title": series.get("title", ""),
                    "season_number": ep.get("seasonNumber"),
                    "episode_number": ep.get("episodeNumber"),
                    "source": "sonarr",
                })
            return items
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return []
