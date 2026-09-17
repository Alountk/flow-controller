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
